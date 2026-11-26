import json
import math
import ntpath
import os
import re
import secrets
import tempfile

try:
    import torch
except ImportError:
    torch = None

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    import comfy.sd
    import comfy.utils
except Exception:
    comfy = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


H3_PROMPT_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)

ASSET_SOCKET_TYPES = "IMAGE,VIDEO,AUDIO,LORA_STACK,REFMOD,H3_REF_MODS,H3_ASSET_ENTRY"
REFMOD_SOCKET_TYPES = "H3_REF_MODS,REFMOD_STACK,REFMOD"
VIDEO_OUT_TYPES = "IMAGE,VIDEO"

CATEGORY_ORDER = ("IMAGE", "VIDEO", "AUDIO", "LORA", "REFMOD")
MAX_SLOTS_BY_TYPE = {
    "IMAGE": 9,
    "VIDEO": 3,
    "AUDIO": 3,
}
SLOT_PREFIX_BY_TYPE = {
    "IMAGE": "Picture",
    "VIDEO": "Video",
    "AUDIO": "Audio",
}

ALLOWED_SCRIPT_EXTS = {".md", ".txt"}
_WRITER_CSRF_TOKEN = secrets.token_urlsafe(32)
TOKEN_HEADER = "X-H3-Writer-Token"

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))


def _allowed_script_roots():
    roots = [_NODE_DIR]
    comfy_root = os.path.abspath(os.path.join(_NODE_DIR, "..", ".."))
    if os.path.isdir(comfy_root):
        roots.append(comfy_root)
    if folder_paths is not None:
        for getter in ("get_input_directory", "get_output_directory", "get_user_directory"):
            fn = getattr(folder_paths, getter, None)
            if callable(fn):
                try:
                    d = fn()
                    if d and os.path.isdir(d):
                        roots.append(os.path.abspath(d))
                except Exception:
                    pass
    deduped = []
    seen = set()
    for r in roots:
        real = os.path.realpath(r)
        norm = os.path.normcase(real)
        if norm not in seen:
            seen.add(norm)
            deduped.append(real)
    return deduped


def _is_within_allowed_roots(target_path, allowed_roots):
    real_target = os.path.realpath(target_path)
    for root in allowed_roots:
        try:
            if os.path.commonpath((os.path.normcase(root), os.path.normcase(real_target))) == os.path.normcase(root):
                return True
        except ValueError:
            continue
    return False


def resolve_safe_script_path(raw_path, for_write=False):
    """Validate and resolve a script file path strictly inside allowed ComfyUI directories."""
    if not raw_path or not str(raw_path).strip():
        raise ValueError("Script path is empty.")

    cleaned = str(raw_path).strip().strip('"').strip("'")
    ext = os.path.splitext(cleaned)[1].lower()
    if not ext:
        cleaned += ".md"
        ext = ".md"
    if ext not in ALLOWED_SCRIPT_EXTS:
        raise ValueError(f"Unsupported script extension '{ext}'. Use .md or .txt.")

    roots = _allowed_script_roots()

    if os.path.isabs(cleaned) or ntpath.splitdrive(cleaned)[0]:
        candidate = os.path.abspath(cleaned)
        if not _is_within_allowed_roots(candidate, roots):
            raise ValueError(f"Script path '{cleaned}' is outside allowed ComfyUI workspace directories.")
        return os.path.realpath(candidate)

    # Relative path: search existing files across allowed roots first
    search_bases = []
    if folder_paths is not None:
        for getter in ("get_input_directory", "get_user_directory", "get_output_directory"):
            fn = getattr(folder_paths, getter, None)
            if callable(fn):
                try:
                    d = fn()
                    if d:
                        search_bases.append(os.path.abspath(d))
                except Exception:
                    pass
    search_bases.append(_NODE_DIR)
    comfy_root = os.path.abspath(os.path.join(_NODE_DIR, "..", ".."))
    search_bases.append(comfy_root)

    for base in search_bases:
        cand = os.path.realpath(os.path.join(base, cleaned))
        if _is_within_allowed_roots(cand, roots) and os.path.isfile(cand):
            return cand

    # Not yet on disk: default relative paths to custom node folder (or input dir if prefixed with input/)
    norm_rel = cleaned.replace("\\", "/")
    if norm_rel.lower().startswith("input/") and folder_paths is not None:
        base_dir = folder_paths.get_input_directory()
        rel_part = cleaned[6:]
    else:
        base_dir = _NODE_DIR
        rel_part = cleaned

    target = os.path.realpath(os.path.join(base_dir, rel_part))
    if not _is_within_allowed_roots(target, roots):
        raise ValueError(f"Script path '{cleaned}' escapes allowed workspace directories.")
    return target


def snap_h3_frames(duration_sec, fps=24):
    """Snap duration in seconds at 24fps up to MiniMax H3's native 17k + 5 frame grid."""
    raw_frames = max(5, int(round(float(duration_sec) * int(fps))))
    if raw_frames <= 5:
        return 5
    k = max(0, math.ceil((raw_frames - 5) / 17.0))
    return 17 * k + 5


def parse_resolution(res_str, fallback=(1280, 720)):
    if not res_str:
        return fallback
    m = re.search(r"(\d+)\s*[xX\*:,]\s*(\d+)", str(res_str).strip())
    if not m:
        return fallback
    w = max(32, int(m.group(1)))
    h = max(32, int(m.group(2)))
    return w, h


def _normalize_slot_token(raw_slot, asset_type="IMAGE"):
    if not raw_slot:
        return "Auto"
    s = str(raw_slot).strip()
    if s.lower() == "auto":
        return "Auto"
    m = re.match(r"^@(\d+)$", s)
    if m:
        idx = int(m.group(1))
        max_slot = MAX_SLOTS_BY_TYPE.get(asset_type.upper(), 9)
        if 1 <= idx <= max_slot:
            return f"@{idx}"
    return "Auto"


def _parse_bool_token(raw):
    return str(raw).strip().lower() in ("true", "1", "on", "yes")


def _parse_weight_kv(raw_weights):
    result = {}
    if not raw_weights:
        return result
    for part in str(raw_weights).split(","):
        part = part.strip()
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip().lower()
        try:
            fv = float(v.strip())
        except ValueError:
            continue
        if k in ("model", "strength_model"):
            result["strength_model"] = fv
        elif k in ("clip", "strength_clip"):
            result["strength_clip"] = fv
        elif k in ("weight", "strength"):
            result["weight"] = fv
    return result


def _default_header():
    return {
        "metadata": {
            "draft_res": "640x360",
            "prod_res": "1280x720",
            "draft_steps": 15,
            "prod_steps": 30,
            "cfg": 6.0,
        },
        "registry": [],
    }


def _parse_prompt_sections(text):
    """Parse the 6 MiniMax H3 prompt sections from a prompt block."""
    sections = {sec: "" for sec in H3_PROMPT_SECTIONS}
    if not text:
        return sections

    current_sec = None
    buffers = {sec: [] for sec in H3_PROMPT_SECTIONS}
    sec_lookup = {sec.lower(): sec for sec in H3_PROMPT_SECTIONS}

    for line in text.splitlines():
        m = re.match(r"^\s*([a-zA-Z_]+)\s*:\s*(.*)$", line)
        if m and m.group(1).lower() in sec_lookup:
            current_sec = sec_lookup[m.group(1).lower()]
            remainder = m.group(2).strip()
            if remainder:
                buffers[current_sec].append(remainder)
            continue
        if current_sec is not None:
            buffers[current_sec].append(line)

    for sec in H3_PROMPT_SECTIONS:
        sections[sec] = "\n".join(buffers[sec]).strip()
    return sections


def _parse_markdown_header(header_block):
    header = _default_header()
    current_h2 = None

    for raw_line in header_block.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        if re.match(r"^#\s*HEADER\b", stripped, re.I):
            continue
        h2_m = re.match(r"^##\s+([A-Za-z0-9_\s]+)$", stripped)
        if h2_m:
            current_h2 = h2_m.group(1).strip().upper()
            continue
        if stripped.startswith("#"):
            continue

        if current_h2 == "METADATA":
            if ":" in stripped:
                k, v = stripped.split(":", 1)
                k = k.strip().lower()
                v = v.strip()
                if k in ("draft_res", "prod_res"):
                    header["metadata"][k] = v
                elif k in ("draft_steps", "prod_steps"):
                    try:
                        header["metadata"][k] = int(v)
                    except ValueError:
                        pass
                elif k == "cfg":
                    try:
                        header["metadata"]["cfg"] = float(v)
                    except ValueError:
                        pass

        elif current_h2 == "REGISTRY":
            # Format: [IMAGE] @1 | Jonathan_Portrait | true
            #         [LORA] auto | Anamorphic_Lens.safetensors | true | model=0.75, clip=0.75
            #         [REFMOD] auto | Depth_Control | false | weight=1.00
            reg_m = re.match(r"^\[([A-Za-z0-9_]+)\]\s*(.+)$", stripped)
            if not reg_m:
                continue
            raw_type = reg_m.group(1).strip().upper()
            if raw_type == "PICTURE":
                raw_type = "IMAGE"
            if raw_type not in CATEGORY_ORDER:
                continue

            parts = [p.strip() for p in reg_m.group(2).split("|")]
            if len(parts) < 2:
                continue

            slot_tok = _normalize_slot_token(parts[0], raw_type)
            alias = parts[1].strip()
            default_active = _parse_bool_token(parts[2]) if len(parts) >= 3 else True
            weights = _parse_weight_kv(parts[3]) if len(parts) >= 4 else {}

            entry = {
                "type": raw_type,
                "default_slot": slot_tok,
                "alias": alias,
                "default_active": default_active,
                "strength_model": weights.get("strength_model", 1.0),
                "strength_clip": weights.get("strength_clip", 1.0),
                "weight": weights.get("weight", 1.0),
            }
            header["registry"].append(entry)

    return header


def _parse_legacy_header(header_block):
    """Support loading legacy .txt scripts (such as example_script.txt) cleanly."""
    header = _default_header()
    current_cat = None

    for raw_line in header_block.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        sec_m = re.match(r"^\[(IMAGE_REFERENCES|VIDEO_REFERENCES|AUDIO_REFERENCES|LORA_REFERENCES|REFMOD_REFERENCES)\]$", stripped, re.I)
        if sec_m:
            tag = sec_m.group(1).upper()
            if "VIDEO" in tag:
                current_cat = "VIDEO"
            elif "AUDIO" in tag:
                current_cat = "AUDIO"
            elif "LORA" in tag:
                current_cat = "LORA"
            elif "REFMOD" in tag:
                current_cat = "REFMOD"
            else:
                current_cat = "IMAGE"
            continue

        if current_cat is None:
            continue
        if stripped.startswith("**") or stripped.startswith("---"):
            current_cat = None
            continue

        parts = [p.strip() for p in stripped.split("|")]
        if len(parts) < 2:
            continue
        alias = parts[0].strip()
        if not alias or " " in alias and "=" in alias:
            continue

        default_active = False
        path_val = ""
        for p in parts[1:]:
            m_def = re.search(r"default\s*=\s*(true|false|1|0|on|off|yes|no)", p, re.I)
            if m_def:
                default_active = _parse_bool_token(m_def.group(1))
            m_path = re.search(r'path\s*=\s*["\']?([^"\']+)["\']?', p, re.I)
            if m_path:
                path_val = m_path.group(1).strip()

        entry = {
            "type": current_cat,
            "default_slot": "Auto",
            "alias": alias,
            "default_active": default_active,
            "strength_model": 1.0,
            "strength_clip": 1.0,
            "weight": 1.0,
        }
        if path_val:
            entry["path"] = path_val
        header["registry"].append(entry)

    return header


def _parse_override_line(line):
    """Parse a single override line inside ## REFERENCES or [REFERENCES]."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None, None

    weight_part = ""
    if "|" in stripped:
        left, weight_part = stripped.split("|", 1)
    else:
        left = stripped

    if ":" in left:
        alias, raw_state = left.split(":", 1)
    elif "=" in left:
        alias, raw_state = left.split("=", 1)
    else:
        return None, None

    alias = alias.strip()
    raw_state = raw_state.strip()
    if not alias:
        return None, None

    low = raw_state.lower()
    if low in ("false", "0", "off", "no"):
        state = "OFF"
    elif low in ("true", "1", "on", "yes", "auto"):
        state = "ON (Auto)"
    elif low == "inherit":
        state = "Inherit"
    elif re.match(r"^@\d+$", raw_state):
        state = raw_state
    else:
        return None, None

    weights = _parse_weight_kv(weight_part)
    override = {
        "state": state,
        "weight_inherited": len(weights) == 0,
    }
    if "strength_model" in weights:
        override["strength_model"] = weights["strength_model"]
    if "strength_clip" in weights:
        override["strength_clip"] = weights["strength_clip"]
    if "weight" in weights:
        override["weight"] = weights["weight"]
    return alias, override


def _parse_segment_block(seg_block, default_cfg=6.0):
    lines = seg_block.splitlines()
    if not lines:
        return None

    first = lines[0].strip()
    # Supports both:
    #   # SEGMENT 2
    #   #SEGMENT 1 (8s): Arrival at the Cabin
    m_head = re.match(r"^#\s*SEGMENT\s+(\d+)(?:\s*\((\d+)s\))?(?:\s*[:\-]\s*(.+))?$", first, re.I)
    if not m_head:
        return None

    seg_num = int(m_head.group(1))
    duration = int(m_head.group(2)) if m_head.group(2) else 8
    title = m_head.group(3).strip() if m_head.group(3) else f"Segment {seg_num}"
    seed = 0
    cfg = float(default_cfg)
    references = {}

    has_h2 = any(re.match(r"^##\s+(SETTINGS|REFERENCES|PROMPT)\b", ln.strip(), re.I) for ln in lines[1:])

    if has_h2:
        current_h2 = None
        prompt_lines = []
        for raw_line in lines[1:]:
            stripped = raw_line.strip()
            h2_m = re.match(r"^##\s+([A-Za-z0-9_\s]+)$", stripped)
            if h2_m:
                current_h2 = h2_m.group(1).strip().upper()
                continue

            if current_h2 == "SETTINGS":
                if not stripped or stripped.startswith("#"):
                    continue
                if ":" in stripped:
                    k, v = stripped.split(":", 1)
                    k = k.strip().lower()
                    v = v.strip()
                    if k == "title":
                        title = v
                    elif k in ("duration", "duration_sec"):
                        m_dur = re.match(r"^(\d+)", v)
                        if m_dur:
                            duration = int(m_dur.group(1))
                    elif k == "seed":
                        try:
                            seed = int(v)
                        except ValueError:
                            pass
                    elif k == "cfg":
                        try:
                            cfg = float(v)
                        except ValueError:
                            pass

            elif current_h2 == "REFERENCES":
                alias, ov = _parse_override_line(stripped)
                if alias:
                    references[alias] = ov

            elif current_h2 == "PROMPT":
                prompt_lines.append(raw_line)

        prompt_dict = _parse_prompt_sections("\n".join(prompt_lines))
    else:
        # Legacy segment layout ([REFERENCES] + 6 prompt sections)
        in_refs = False
        prompt_lines = []
        for raw_line in lines[1:]:
            stripped = raw_line.strip()
            if re.match(r"^\[(REFERENCES|SWITCHES|MEDIA_SWITCHES)\]$", stripped, re.I):
                in_refs = True
                continue
            if in_refs:
                if re.match(r"^[a-zA-Z_]+\s*:\s*$", stripped) and stripped[:-1].strip().lower() in H3_PROMPT_SECTIONS:
                    in_refs = False
                    prompt_lines.append(raw_line)
                    continue
                if not stripped:
                    continue
                alias, ov = _parse_override_line(stripped)
                if alias:
                    references[alias] = ov
                    continue
            prompt_lines.append(raw_line)

        prompt_dict = _parse_prompt_sections("\n".join(prompt_lines))

    return {
        "number": seg_num,
        "title": title,
        "duration": duration,
        "seed": seed,
        "cfg": cfg,
        "references": references,
        "prompt": prompt_dict,
    }


def parse_script_text(content):
    """Parse either a Structured Markdown (.md) script or a legacy (.txt) script into an AST."""
    if not content or not content.strip():
        return {"header": _default_header(), "segments": []}

    # Split strictly on top-level `# SEGMENT <N>` or `#SEGMENT <N>` lines
    parts = re.split(r"(?=^#\s*SEGMENT\s+\d+\b)", content, flags=re.M | re.I)
    header_part = parts[0] if parts else ""
    seg_parts = parts[1:] if len(parts) > 1 else []

    if re.search(r"^#\s*HEADER\b", header_part, re.M | re.I) or re.search(r"^##\s*(METADATA|REGISTRY)\b", header_part, re.M | re.I):
        header = _parse_markdown_header(header_part)
    else:
        header = _parse_legacy_header(header_part)

    default_cfg = header["metadata"].get("cfg", 6.0)
    segments = []
    for sp in seg_parts:
        seg = _parse_segment_block(sp, default_cfg=default_cfg)
        if seg is not None:
            segments.append(seg)

    segments.sort(key=lambda s: s["number"])
    return {"header": header, "segments": segments}


def serialize_script_ast(ast):
    """Serialize an AST dictionary into the canonical Structured Markdown (.md) format."""
    header = ast.get("header") or _default_header()
    meta = header.get("metadata") or {}
    registry = header.get("registry") or []
    segments = sorted(ast.get("segments") or [], key=lambda s: int(s.get("number", 1)))

    lines = [
        "# HEADER",
        "## METADATA",
        f"draft_res: {meta.get('draft_res', '640x360')}",
        f"prod_res: {meta.get('prod_res', '1280x720')}",
        f"draft_steps: {int(meta.get('draft_steps', 15))}",
        f"prod_steps: {int(meta.get('prod_steps', 30))}",
        f"cfg: {float(meta.get('cfg', 6.0)):.1f}",
        "",
        "## REGISTRY",
    ]

    reg_by_alias = {}
    for item in registry:
        rtype = str(item.get("type", "IMAGE")).upper()
        alias = str(item.get("alias", "")).strip()
        if not alias:
            continue
        reg_by_alias[alias] = item
        slot_raw = _normalize_slot_token(item.get("default_slot", "Auto"), rtype)
        slot_str = "auto" if slot_raw == "Auto" else slot_raw
        active_str = "true" if bool(item.get("default_active", True)) else "false"

        if rtype == "LORA":
            sm = float(item.get("strength_model", 1.0))
            sc = float(item.get("strength_clip", 1.0))
            lines.append(f"[LORA] {slot_str} | {alias} | {active_str} | model={sm:.2f}, clip={sc:.2f}")
        elif rtype == "REFMOD":
            w = float(item.get("weight", 1.0))
            lines.append(f"[REFMOD] {slot_str} | {alias} | {active_str} | weight={w:.2f}")
        else:
            lines.append(f"[{rtype}] {slot_str} | {alias} | {active_str}")

    for seg in segments:
        seg_num = int(seg.get("number", 1))
        title = str(seg.get("title", f"Segment {seg_num}")).strip() or f"Segment {seg_num}"
        duration = int(seg.get("duration", 8))
        seed = int(seg.get("seed", 0))
        cfg = float(seg.get("cfg", meta.get("cfg", 6.0)))

        lines.extend([
            "",
            f"# SEGMENT {seg_num}",
            "## SETTINGS",
            f"title: {title}",
            f"duration: {duration}",
            f"seed: {seed}",
            f"cfg: {cfg:.1f}",
            "",
            "## REFERENCES",
            "# Only differences from HEADER are saved here:",
        ])

        refs = seg.get("references") or {}
        for alias, ov in refs.items():
            if not isinstance(ov, dict):
                continue
            state = str(ov.get("state", "Inherit")).strip()
            weight_inherited = bool(ov.get("weight_inherited", True))

            hdr_item = reg_by_alias.get(alias, {})
            rtype = str(hdr_item.get("type", ov.get("type", "IMAGE"))).upper()

            if state == "Inherit" and (weight_inherited or rtype not in ("LORA", "REFMOD")):
                continue

            if state == "OFF":
                state_tok = "false"
            elif state == "ON (Auto)":
                state_tok = "true"
            elif state.startswith("@"):
                state_tok = state
            else:
                # Inherit state with modified LoRA/RefMod weight
                hdr_active = bool(hdr_item.get("default_active", True))
                hdr_slot = _normalize_slot_token(hdr_item.get("default_slot", "Auto"), rtype)
                if not hdr_active:
                    state_tok = "false"
                elif hdr_slot != "Auto" and rtype in ("IMAGE", "VIDEO", "AUDIO"):
                    state_tok = hdr_slot
                else:
                    state_tok = "true"

            if rtype == "LORA" and not weight_inherited:
                sm = float(ov.get("strength_model", hdr_item.get("strength_model", 1.0)))
                sc = float(ov.get("strength_clip", hdr_item.get("strength_clip", 1.0)))
                lines.append(f"{alias}: {state_tok} | model={sm:.2f}, clip={sc:.2f}")
            elif rtype == "REFMOD" and not weight_inherited:
                w = float(ov.get("weight", hdr_item.get("weight", 1.0)))
                lines.append(f"{alias}: {state_tok} | weight={w:.2f}")
            else:
                lines.append(f"{alias}: {state_tok}")

        lines.extend([
            "",
            "## PROMPT",
        ])

        prompt_data = seg.get("prompt") or {}
        for idx, sec_name in enumerate(H3_PROMPT_SECTIONS):
            if idx > 0:
                lines.append("")
            lines.append(f"{sec_name}:")
            body = str(prompt_data.get(sec_name, "")).strip()
            # Strip accidental duplicate section header inside the box
            dup_m = re.match(rf"^{sec_name}\s*:\s*(.*)$", body, flags=re.I | re.S)
            if dup_m:
                body = dup_m.group(1).strip()
            if body:
                lines.append(body)

    return "\n".join(lines) + "\n"


def _normalize_segment_payload(segment_payload, default_cfg=6.0):
    target_num = int(segment_payload.get("number", 1))
    return {
        "number": target_num,
        "title": str(segment_payload.get("title", f"Segment {target_num}")).strip() or f"Segment {target_num}",
        "duration": int(segment_payload.get("duration", 8)),
        "seed": int(segment_payload.get("seed", 0)),
        "cfg": float(segment_payload.get("cfg", default_cfg)),
        "references": dict(segment_payload.get("references") or {}),
        "prompt": dict(segment_payload.get("prompt") or {}),
    }


def save_script_update(raw_path, header_payload, segment_payload=None, registry_connected=True, segments_payload=None):
    """Save the full script (# HEADER and all # SEGMENT <N> blocks) to disk."""
    resolved_path = resolve_safe_script_path(raw_path, for_write=True)

    if os.path.isfile(resolved_path):
        with open(resolved_path, "r", encoding="utf-8") as fh:
            existing_ast = parse_script_text(fh.read())
    else:
        existing_ast = {"header": _default_header(), "segments": []}

    # Merge header metadata
    new_meta = dict(existing_ast["header"].get("metadata") or {})
    incoming_meta = (header_payload or {}).get("metadata") or {}
    for k in ("draft_res", "prod_res", "draft_steps", "prod_steps", "cfg"):
        if k in incoming_meta and incoming_meta[k] is not None:
            new_meta[k] = incoming_meta[k]

    incoming_reg = (header_payload or {}).get("registry")
    if registry_connected and isinstance(incoming_reg, list):
        new_registry = incoming_reg
    elif incoming_reg:
        new_registry = incoming_reg
    else:
        new_registry = existing_ast["header"].get("registry") or []

    existing_ast["header"] = {
        "metadata": new_meta,
        "registry": new_registry,
    }

    default_cfg = float(new_meta.get("cfg", 6.0))
    if isinstance(segments_payload, list) and len(segments_payload) > 0:
        by_num = {}
        for seg in segments_payload:
            if isinstance(seg, dict):
                norm_seg = _normalize_segment_payload(seg, default_cfg=default_cfg)
                by_num[norm_seg["number"]] = norm_seg
        if isinstance(segment_payload, dict) and segment_payload:
            norm_active = _normalize_segment_payload(segment_payload, default_cfg=default_cfg)
            by_num[norm_active["number"]] = norm_active
        new_segments = [by_num[k] for k in sorted(by_num.keys())]
    elif isinstance(segment_payload, dict) and segment_payload:
        updated_seg = _normalize_segment_payload(segment_payload, default_cfg=default_cfg)
        target_num = updated_seg["number"]
        replaced = False
        new_segments = []
        for seg in existing_ast["segments"]:
            if int(seg.get("number", -1)) == target_num:
                new_segments.append(updated_seg)
                replaced = True
            else:
                new_segments.append(seg)
        if not replaced:
            new_segments.append(updated_seg)
        new_segments.sort(key=lambda s: int(s["number"]))
    else:
        new_segments = list(existing_ast["segments"])

    existing_ast["segments"] = new_segments

    markdown_text = serialize_script_ast(existing_ast)
    parent_dir = os.path.dirname(resolved_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(prefix=".h3_script_", suffix=".tmp", dir=parent_dir or _NODE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as tmp_fh:
            tmp_fh.write(markdown_text)
        os.replace(tmp_path, resolved_path)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise

    return resolved_path, existing_ast


def resolve_segment_assets(registry_assets, overrides):
    """
    Deterministic slot resolution matching frontend h3_state_sync.js 1:1.

    Returns:
        dict with:
          - image_slots: list of 9 items (asset dict or None)
          - video_slots: list of 3 items (asset dict or None)
          - audio_slots: list of 3 items (asset dict or None)
          - active_loras: list of dicts with effective strength_model / strength_clip
          - active_refmods: list of dicts with effective weight
          - slot_map: dict mapping alias -> "Picture N" | "Video N" | "Audio N"
          - all_aliases: set of all declared aliases
    """
    assets = registry_assets or []
    ov_map = overrides or {}
    ov_ci = {str(k).lower(): v for k, v in ov_map.items() if isinstance(v, dict)}

    slots_by_type = {
        "IMAGE": [None] * MAX_SLOTS_BY_TYPE["IMAGE"],
        "VIDEO": [None] * MAX_SLOTS_BY_TYPE["VIDEO"],
        "AUDIO": [None] * MAX_SLOTS_BY_TYPE["AUDIO"],
    }
    auto_header_queue = {"IMAGE": [], "VIDEO": [], "AUDIO": []}
    auto_segment_queue = {"IMAGE": [], "VIDEO": [], "AUDIO": []}
    collision_queue = {"IMAGE": [], "VIDEO": [], "AUDIO": []}

    active_loras = []
    active_refmods = []
    all_aliases = set()

    for asset in assets:
        alias = str(asset.get("alias", "")).strip()
        if not alias:
            continue
        all_aliases.add(alias)
        rtype = str(asset.get("type", "IMAGE")).upper()
        if rtype == "PICTURE":
            rtype = "IMAGE"

        ov = ov_map.get(alias) or ov_ci.get(alias.lower()) or {}
        state = str(ov.get("state", "Inherit")).strip()
        weight_inherited = bool(ov.get("weight_inherited", True))

        default_active = bool(asset.get("default_active", True))
        default_slot = _normalize_slot_token(asset.get("default_slot", "Auto"), rtype)

        if state == "Inherit":
            eff_active = default_active
            eff_slot = default_slot
            from_header = True
        elif state == "OFF":
            eff_active = False
            eff_slot = "Auto"
            from_header = False
        elif state == "ON (Auto)":
            eff_active = True
            eff_slot = "Auto"
            from_header = False
        elif state.startswith("@"):
            eff_active = True
            eff_slot = _normalize_slot_token(state, rtype)
            from_header = False
        else:
            eff_active = default_active
            eff_slot = default_slot
            from_header = True

        if not eff_active:
            continue

        if rtype == "LORA":
            sm = float(asset.get("strength_model", 1.0)) if weight_inherited else float(ov.get("strength_model", asset.get("strength_model", 1.0)))
            sc = float(asset.get("strength_clip", 1.0)) if weight_inherited else float(ov.get("strength_clip", asset.get("strength_clip", 1.0)))
            resolved_item = dict(asset)
            resolved_item["effective_strength_model"] = sm
            resolved_item["effective_strength_clip"] = sc
            active_loras.append(resolved_item)
            continue

        if rtype == "REFMOD":
            w = float(asset.get("weight", 1.0)) if weight_inherited else float(ov.get("weight", asset.get("weight", 1.0)))
            resolved_item = dict(asset)
            resolved_item["effective_weight"] = w
            active_refmods.append(resolved_item)
            continue

        if rtype not in slots_by_type:
            continue

        max_s = MAX_SLOTS_BY_TYPE[rtype]
        if eff_slot.startswith("@"):
            idx = int(eff_slot[1:]) - 1
            if 0 <= idx < max_s and slots_by_type[rtype][idx] is None:
                slots_by_type[rtype][idx] = asset
            else:
                collision_queue[rtype].append(asset)
        else:
            if from_header:
                auto_header_queue[rtype].append(asset)
            else:
                auto_segment_queue[rtype].append(asset)

    slot_map = {}
    for rtype in ("IMAGE", "VIDEO", "AUDIO"):
        arr = slots_by_type[rtype]
        pending = collision_queue[rtype] + auto_header_queue[rtype] + auto_segment_queue[rtype]
        p_idx = 0
        for s_idx in range(len(arr)):
            if arr[s_idx] is None and p_idx < len(pending):
                arr[s_idx] = pending[p_idx]
                p_idx += 1
        prefix = SLOT_PREFIX_BY_TYPE[rtype]
        for s_idx, item in enumerate(arr):
            if item is not None:
                slot_map[item["alias"]] = f"{prefix} {s_idx + 1}"

    return {
        "image_slots": slots_by_type["IMAGE"],
        "video_slots": slots_by_type["VIDEO"],
        "audio_slots": slots_by_type["AUDIO"],
        "active_loras": active_loras,
        "active_refmods": active_refmods,
        "slot_map": slot_map,
        "all_aliases": all_aliases,
    }


def compile_h3_prompt(prompt_sections, slot_map, all_aliases=None):
    """
    Assemble the 6 MiniMax H3 prompt sections in exact schema order and replace
    <Alias> tags with resolved <Picture N>, <Video N>, <Audio N> tags.
    """
    blocks = []
    for sec_name in H3_PROMPT_SECTIONS:
        raw_body = str((prompt_sections or {}).get(sec_name, "")).strip()
        dup_m = re.match(rf"^{sec_name}\s*:\s*(.*)$", raw_body, flags=re.I | re.S)
        if dup_m:
            raw_body = dup_m.group(1).strip()
        if raw_body:
            blocks.append(f"{sec_name}:\n{raw_body}")
        else:
            blocks.append(f"{sec_name}:")

    compiled = "\n\n".join(blocks)
    if not slot_map and not all_aliases:
        return compiled

    ci_slot_map = {k.lower(): v for k, v in (slot_map or {}).items()}
    ci_known = {a.lower(): a for a in (all_aliases or set())}

    def _replace_tag(match):
        inner = match.group(1).strip()
        low = inner.lower()
        if low in ci_slot_map:
            return f"<{ci_slot_map[low]}>"
        if low in ci_known:
            print(f"[H3_ScriptWriter] Warning: Prompt references inactive alias '<{ci_known[low]}>'.")
        return match.group(0)

    return re.sub(r"<([^<>]+)>", _replace_tag, compiled)


def _unwrap_asset_data(item):
    if item is None:
        return None
    raw = item.get("data")
    if isinstance(raw, dict) and raw.get("_h3_asset_entry"):
        return raw.get("data")
    return raw


def _normalize_video_value(val):
    """Extract [T, H, W, C] frame tensor if a ComfyUI VideoInput object was passed."""
    if val is None:
        return None
    if torch is not None and isinstance(val, torch.Tensor):
        return val
    get_comp = getattr(val, "get_components", None)
    if callable(get_comp):
        comp = get_comp()
        return getattr(comp, "images", val)
    return val


def _apply_lora_spec(model, clip, lora_name, strength_model, strength_clip):
    if (model is None and clip is None) or comfy is None or folder_paths is None:
        return model, clip
    if not lora_name or lora_name in ("(none)", "None"):
        return model, clip
    if strength_model == 0 and strength_clip == 0:
        return model, clip

    lora_path = folder_paths.get_full_path("loras", lora_name)
    if lora_path is None:
        # Try matching basename if alias omitted directory or included/omitted .safetensors
        candidates = folder_paths.get_filename_list("loras")
        target_low = lora_name.lower()
        target_stem = os.path.splitext(target_low)[0]
        for cand in candidates:
            cand_base = os.path.basename(cand).lower()
            if cand.lower() == target_low or cand_base == target_low or os.path.splitext(cand_base)[0] == target_stem:
                lora_path = folder_paths.get_full_path("loras", cand)
                break

    if lora_path is None:
        raise FileNotFoundError(f"[H3_ScriptWriter] LoRA '{lora_name}' not found in models/loras.")

    lora_sd = comfy.utils.load_torch_file(lora_path, safe_load=True)
    return comfy.sd.load_lora_for_models(model, clip, lora_sd, strength_model, strength_clip)


def apply_active_loras(model, clip, active_loras):
    if model is None and clip is None:
        return model, clip

    for item in active_loras:
        eff_m = float(item.get("effective_strength_model", 1.0))
        eff_c = float(item.get("effective_strength_clip", 1.0))
        data = item.get("data")
        lora_name = item.get("lora_name") or item.get("alias", "")

        if isinstance(data, dict) and data.get("_h3_asset_entry"):
            if data.get("lora_name") and data["lora_name"] != "(none)":
                model, clip = _apply_lora_spec(model, clip, data["lora_name"], eff_m, eff_c)
            elif isinstance(data.get("data"), list):
                stack = data["data"]
                for tup in stack:
                    if isinstance(tup, (list, tuple)) and len(tup) >= 3:
                        if len(stack) == 1:
                            model, clip = _apply_lora_spec(model, clip, tup[0], eff_m, eff_c)
                        else:
                            model, clip = _apply_lora_spec(model, clip, tup[0], float(tup[1]) * eff_m, float(tup[2]) * eff_c)
        elif isinstance(data, list):
            # Standard LORA_STACK: list of (lora_name, strength_model, strength_clip)
            for tup in data:
                if isinstance(tup, (list, tuple)) and len(tup) >= 3:
                    if len(data) == 1:
                        model, clip = _apply_lora_spec(model, clip, tup[0], eff_m, eff_c)
                    else:
                        model, clip = _apply_lora_spec(model, clip, tup[0], float(tup[1]) * eff_m, float(tup[2]) * eff_c)
        elif isinstance(data, str) and data.strip():
            model, clip = _apply_lora_spec(model, clip, data.strip(), eff_m, eff_c)
        elif lora_name:
            model, clip = _apply_lora_spec(model, clip, lora_name, eff_m, eff_c)

    return model, clip


def build_refmod_stack(active_refmods):
    stack = []
    for item in active_refmods:
        eff_w = max(0.0, float(item.get("effective_weight", 1.0)))
        if eff_w <= 0.0:
            continue
        data = item.get("data")
        if isinstance(data, dict) and data.get("_h3_asset_entry"):
            data = data.get("data")

        if isinstance(data, list):
            # H3_REF_MODS: list of (H3RefMod, strength) tuples
            if len(data) == 1 and isinstance(data[0], (list, tuple)) and len(data[0]) >= 2:
                stack.append((data[0][0], min(1.0, eff_w)))
            else:
                for entry in data:
                    if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                        stack.append((entry[0], max(0.0, min(1.0, float(entry[1]) * eff_w))))
                    elif entry is not None:
                        stack.append((entry, min(1.0, eff_w)))
        elif data is not None:
            stack.append((data, min(1.0, eff_w)))
    return stack


def _list_lora_names():
    if folder_paths is None:
        return ["(none)"]
    try:
        return ["(none)"] + sorted(folder_paths.get_filename_list("loras"))
    except Exception:
        return ["(none)"]


class DynamicAssetOptionalDict(dict):
    """Allows unlimited dynamic `asset_1` .. `asset_N` inputs on H3_ReferenceRegistry."""

    def __contains__(self, key):
        if super().__contains__(key):
            return True
        return isinstance(key, str) and bool(re.match(r"^asset_\d+$", key))

    def __getitem__(self, key):
        if super().__contains__(key):
            return super().__getitem__(key)
        if isinstance(key, str) and re.match(r"^asset_\d+$", key):
            return (ASSET_SOCKET_TYPES, {})
        raise KeyError(key)

    def get(self, key, default=None):
        if key in self:
            return self[key]
        return default


class H3_ReferenceEntry:
    """Optional helper node producing an H3_ASSET_ENTRY for LoRAs, RefMods, or media assets."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "asset_type": (["AUTO", "IMAGE", "VIDEO", "AUDIO", "LORA", "REFMOD"], {"default": "AUTO"}),
                "alias": ("STRING", {"default": "", "multiline": False}),
                "lora_name": (_list_lora_names(), {"default": "(none)"}),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
                "weight": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
            },
            "optional": {
                "media": ("IMAGE,VIDEO,AUDIO,LORA_STACK,REFMOD,H3_REF_MODS",),
            },
        }

    RETURN_TYPES = ("H3_ASSET_ENTRY",)
    RETURN_NAMES = ("asset_entry",)
    FUNCTION = "create_entry"
    CATEGORY = "MiniMax_H3/ScriptWriter"

    def create_entry(
        self,
        asset_type="AUTO",
        alias="",
        lora_name="(none)",
        strength_model=1.0,
        strength_clip=1.0,
        weight=1.0,
        media=None,
    ):
        resolved_type = asset_type
        if resolved_type == "AUTO":
            if lora_name and lora_name != "(none)" and media is None:
                resolved_type = "LORA"
            elif isinstance(media, dict) and "waveform" in media:
                resolved_type = "AUDIO"
            elif isinstance(media, list) and media and isinstance(media[0], (list, tuple)):
                first_item = media[0][0]
                resolved_type = "LORA" if isinstance(first_item, str) else "REFMOD"
            elif media is not None and callable(getattr(media, "get_components", None)):
                resolved_type = "VIDEO"
            elif torch is not None and isinstance(media, torch.Tensor) and media.ndim == 4 and media.shape[0] > 1:
                resolved_type = "VIDEO"
            else:
                resolved_type = "IMAGE"

        clean_alias = str(alias or "").strip()
        if not clean_alias and resolved_type == "LORA" and lora_name and lora_name != "(none)":
            clean_alias = os.path.basename(lora_name)

        return ({
            "_h3_asset_entry": True,
            "alias": clean_alias,
            "type": resolved_type,
            "lora_name": lora_name if lora_name != "(none)" else "",
            "strength_model": float(strength_model),
            "strength_clip": float(strength_clip),
            "weight": float(weight),
            "data": media,
        },)


class H3_ReferenceRegistry:
    """Node 1: Global Header Controller mapping 1:1 to # HEADER -> ## REGISTRY."""

    @classmethod
    def INPUT_TYPES(cls):
        optional = DynamicAssetOptionalDict({
            "asset_1": (ASSET_SOCKET_TYPES,),
        })
        return {
            "required": {
                "registry_state": ("STRING", {"default": "[]", "multiline": False}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("H3_REGISTRY_BUS",)
    RETURN_NAMES = ("registry_bus",)
    FUNCTION = "build_registry"
    CATEGORY = "MiniMax_H3/ScriptWriter"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def build_registry(self, registry_state="[]", **kwargs):
        try:
            parsed_rows = json.loads(registry_state or "[]")
            if not isinstance(parsed_rows, list):
                parsed_rows = []
        except Exception:
            parsed_rows = []

        row_by_slot = {
            str(r.get("slot_name", "")): r
            for r in parsed_rows
            if isinstance(r, dict) and r.get("slot_name")
        }

        # Collect connected asset_N inputs in numeric slot order
        slot_keys = sorted(
            [k for k in kwargs.keys() if re.match(r"^asset_\d+$", k) and kwargs[k] is not None],
            key=lambda name: int(name.split("_", 1)[1]),
        )

        assets = []
        used_aliases = set()

        for idx, slot_key in enumerate(slot_keys):
            raw_val = kwargs[slot_key]
            row_cfg = row_by_slot.get(slot_key, {})

            inferred_type = "IMAGE"
            lora_name = ""
            payload_data = raw_val

            if isinstance(raw_val, dict) and raw_val.get("_h3_asset_entry"):
                inferred_type = str(raw_val.get("type", "IMAGE")).upper()
                lora_name = raw_val.get("lora_name", "")
            elif isinstance(raw_val, dict) and "waveform" in raw_val:
                inferred_type = "AUDIO"
            elif isinstance(raw_val, list):
                if raw_val and isinstance(raw_val[0], (list, tuple)) and len(raw_val[0]) >= 2:
                    if isinstance(raw_val[0][0], str):
                        inferred_type = "LORA"
                    else:
                        inferred_type = "REFMOD"
                else:
                    inferred_type = str(row_cfg.get("type") or "REFMOD").upper()
            elif callable(getattr(raw_val, "get_components", None)):
                inferred_type = "VIDEO"
            elif torch is not None and isinstance(raw_val, torch.Tensor):
                cfg_type = str(row_cfg.get("type", "")).upper()
                if cfg_type in ("IMAGE", "VIDEO"):
                    inferred_type = cfg_type
                elif raw_val.ndim == 4 and raw_val.shape[0] > 1:
                    inferred_type = "VIDEO"
                else:
                    inferred_type = "IMAGE"

            rtype = str(row_cfg.get("type") or inferred_type).upper()
            if rtype not in CATEGORY_ORDER:
                rtype = inferred_type

            alias = str(row_cfg.get("alias") or "").strip()
            if not alias and isinstance(raw_val, dict) and raw_val.get("_h3_asset_entry"):
                alias = str(raw_val.get("alias") or "").strip()
            if not alias:
                alias = f"Asset_{slot_key.split('_', 1)[1]}"

            # Disambiguate if duplicate alias
            base_alias = alias
            suffix = 2
            while alias.lower() in used_aliases:
                alias = f"{base_alias}_{suffix}"
                suffix += 1
            used_aliases.add(alias.lower())

            default_active = bool(row_cfg.get("default_active", True))
            default_slot = _normalize_slot_token(row_cfg.get("default_slot", "Auto"), rtype)

            default_sm = float(
                row_cfg.get(
                    "strength_model",
                    raw_val.get("strength_model", 1.0) if isinstance(raw_val, dict) else 1.0,
                )
            )
            default_sc = float(
                row_cfg.get(
                    "strength_clip",
                    raw_val.get("strength_clip", 1.0) if isinstance(raw_val, dict) else 1.0,
                )
            )
            default_w = float(
                row_cfg.get(
                    "weight",
                    raw_val.get("weight", 1.0) if isinstance(raw_val, dict) else 1.0,
                )
            )

            assets.append({
                "slot_name": slot_key,
                "index": idx,
                "alias": alias,
                "type": rtype,
                "default_active": default_active,
                "default_slot": default_slot,
                "strength_model": default_sm,
                "strength_clip": default_sc,
                "weight": default_w,
                "lora_name": lora_name,
                "data": payload_data,
            })

        return ({"assets": assets},)


class H3_SegmentOverride:
    """Node 2: Active Segment Mixer combining H3_REGISTRY_BUS with per-segment diff overrides."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "registry_bus": ("H3_REGISTRY_BUS",),
                "override_state": ("STRING", {"default": "{}", "multiline": False}),
            },
        }

    RETURN_TYPES = ("H3_SEGMENT_BUS",)
    RETURN_NAMES = ("segment_bus",)
    FUNCTION = "apply_overrides"
    CATEGORY = "MiniMax_H3/ScriptWriter"

    def apply_overrides(self, registry_bus, override_state="{}"):
        try:
            overrides = json.loads(override_state or "{}")
            if not isinstance(overrides, dict):
                overrides = {}
        except Exception:
            overrides = {}

        assets = []
        if isinstance(registry_bus, dict):
            assets = list(registry_bus.get("assets") or [])

        return ({
            "assets": assets,
            "overrides": overrides,
        },)


class H3_ScriptWriter:
    """Node 3: Master Prompt Editor, Transport & Router for MiniMax H3."""

    NUM_PICTURES = 9
    NUM_VIDEOS = 3
    NUM_AUDIOS = 3

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "script_path": ("STRING", {"default": "example_script.md", "multiline": False}),
                "segment_select": (["1: Arrival at the Cabin", "+ New Segment"], {"default": "1: Arrival at the Cabin"}),
                "segment_title": ("STRING", {"default": "Arrival at the Cabin", "multiline": False}),
                "duration_sec": ("INT", {"default": 8, "min": 1, "max": 120, "step": 1}),
                "mode": (["Draft", "Production"], {"default": "Draft"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": False}),
                "draft_res": ("STRING", {"default": "640x360", "multiline": False}),
                "prod_res": ("STRING", {"default": "1280x720", "multiline": False}),
                "draft_steps": ("INT", {"default": 15, "min": 1, "max": 200, "step": 1}),
                "prod_steps": ("INT", {"default": 30, "min": 1, "max": 200, "step": 1}),
                "cfg": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "run_nonce": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF}),
                "subject_definitions": ("STRING", {"default": "", "multiline": False}),
                "summary": ("STRING", {"default": "", "multiline": False}),
                "retention_analysis": ("STRING", {"default": "", "multiline": False}),
                "detailed_description": ("STRING", {"default": "", "multiline": False}),
                "overall_soundscape": ("STRING", {"default": "", "multiline": False}),
                "non_diegetic_music": ("STRING", {"default": "None.", "multiline": False}),
            },
            "optional": {
                "segment_bus": ("H3_SEGMENT_BUS",),
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = (
        ("STRING", "MODEL", "CLIP", REFMOD_SOCKET_TYPES, "INT", "INT", "INT", "FLOAT", "INT", "INT", "INT")
        + ("IMAGE",) * NUM_PICTURES
        + (VIDEO_OUT_TYPES,) * NUM_VIDEOS
        + ("AUDIO",) * NUM_AUDIOS
    )
    RETURN_NAMES = (
        ("clean_prompt", "model", "clip", "refmod_stack", "width", "height", "steps", "cfg", "seed", "frame_count", "duration")
        + tuple(f"ref_image_{i}" for i in range(1, NUM_PICTURES + 1))
        + tuple(f"ref_video_{i}" for i in range(1, NUM_VIDEOS + 1))
        + tuple(f"ref_audio_{i}" for i in range(1, NUM_AUDIOS + 1))
    )
    FUNCTION = "route_segment"
    CATEGORY = "MiniMax_H3/ScriptWriter"

    @classmethod
    def VALIDATE_INPUTS(cls, segment_select=None):
        return True

    @classmethod
    def IS_CHANGED(cls, run_nonce=0, **kwargs):
        return int(run_nonce)

    def route_segment(
        self,
        script_path="example_script.md",
        segment_select="",
        segment_title="",
        duration_sec=8,
        mode="Draft",
        seed=0,
        draft_res="640x360",
        prod_res="1280x720",
        draft_steps=15,
        prod_steps=30,
        cfg=6.0,
        run_nonce=0,
        subject_definitions="",
        summary="",
        retention_analysis="",
        detailed_description="",
        overall_soundscape="",
        non_diegetic_music="None.",
        segment_bus=None,
        model=None,
        clip=None,
    ):
        del script_path, segment_select, segment_title, run_nonce

        assets = []
        overrides = {}
        if isinstance(segment_bus, dict):
            assets = segment_bus.get("assets") or []
            overrides = segment_bus.get("overrides") or {}

        resolved = resolve_segment_assets(assets, overrides)

        prompt_sections = {
            "subject_definitions": subject_definitions,
            "summary": summary,
            "retention_analysis": retention_analysis,
            "detailed_description": detailed_description,
            "overall_soundscape": overall_soundscape,
            "non_diegetic_music": non_diegetic_music,
        }
        clean_prompt = compile_h3_prompt(
            prompt_sections,
            resolved["slot_map"],
            resolved["all_aliases"],
        )

        patched_model, patched_clip = apply_active_loras(model, clip, resolved["active_loras"])
        refmod_stack = build_refmod_stack(resolved["active_refmods"])

        is_prod = str(mode).strip().lower() == "production"
        if is_prod:
            width, height = parse_resolution(prod_res, fallback=(1280, 720))
            steps = int(prod_steps)
        else:
            width, height = parse_resolution(draft_res, fallback=(640, 360))
            steps = int(draft_steps)

        frame_count = snap_h3_frames(duration_sec, fps=24)

        image_outputs = [_unwrap_asset_data(item) for item in resolved["image_slots"]]
        video_outputs = [_normalize_video_value(_unwrap_asset_data(item)) for item in resolved["video_slots"]]
        audio_outputs = [_unwrap_asset_data(item) for item in resolved["audio_slots"]]

        return (
            clean_prompt,
            patched_model,
            patched_clip,
            refmod_stack,
            int(width),
            int(height),
            int(steps),
            float(cfg),
            int(seed),
            int(frame_count),
            int(duration_sec),
            *image_outputs,
            *video_outputs,
            *audio_outputs,
        )


def register_h3_writer_routes(server_instance):
    if server_instance is None or web is None:
        return
    if getattr(server_instance, "_h3_writer_routes_registered", False):
        return
    server_instance._h3_writer_routes_registered = True

    @server_instance.routes.get("/h3_writer/token")
    async def h3_get_token(request):
        return web.json_response({"ok": True, "token": _WRITER_CSRF_TOKEN})

    @server_instance.routes.get("/h3_writer/load_script")
    async def h3_load_script(request):
        raw_path = request.rel_url.query.get("path", "").strip()
        if not raw_path:
            return web.json_response(
                {"ok": False, "error": "Missing 'path' query parameter.", "token": _WRITER_CSRF_TOKEN},
                status=400,
            )
        try:
            resolved = resolve_safe_script_path(raw_path, for_write=False)
        except ValueError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc), "token": _WRITER_CSRF_TOKEN},
                status=400,
            )

        if not os.path.isfile(resolved):
            return web.json_response({
                "ok": True,
                "exists": False,
                "resolved_path": resolved,
                "token": _WRITER_CSRF_TOKEN,
                "header": _default_header(),
                "segments": [],
            })

        try:
            with open(resolved, "r", encoding="utf-8") as fh:
                ast = parse_script_text(fh.read())
            return web.json_response({
                "ok": True,
                "exists": True,
                "resolved_path": resolved,
                "token": _WRITER_CSRF_TOKEN,
                "header": ast["header"],
                "segments": ast["segments"],
            })
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": f"Failed to read script: {exc}", "token": _WRITER_CSRF_TOKEN},
                status=500,
            )

    @server_instance.routes.post("/h3_writer/save_all")
    async def h3_save_all(request):
        req_token = request.headers.get(TOKEN_HEADER, "")
        if not req_token or not secrets.compare_digest(req_token, _WRITER_CSRF_TOKEN):
            return web.json_response(
                {"ok": False, "error": "Invalid or missing session token. Reload script first."},
                status=403,
            )

        try:
            payload = await request.json()
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"Invalid JSON body: {exc}"}, status=400)

        raw_path = str(payload.get("script_path", "")).strip()
        header_payload = payload.get("header") or {}
        segment_payload = payload.get("segment") or {}
        segments_payload = payload.get("segments")
        registry_connected = bool(payload.get("registry_connected", True))

        if not raw_path:
            return web.json_response({"ok": False, "error": "Missing 'script_path'."}, status=400)

        try:
            resolved_path, updated_ast = save_script_update(
                raw_path,
                header_payload,
                segment_payload,
                registry_connected=registry_connected,
                segments_payload=segments_payload,
            )
            return web.json_response({
                "ok": True,
                "resolved_path": resolved_path,
                "header": updated_ast["header"],
                "segments": updated_ast["segments"],
            })
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"ok": False, "error": f"Failed to save script: {exc}"}, status=500)


SUITE_NODE_CLASS_MAPPINGS = {
    "H3_ReferenceEntry": H3_ReferenceEntry,
    "H3_ReferenceRegistry": H3_ReferenceRegistry,
    "H3_SegmentOverride": H3_SegmentOverride,
    "H3_ScriptWriter": H3_ScriptWriter,
}

SUITE_NODE_DISPLAY_NAME_MAPPINGS = {
    "H3_ReferenceEntry": "MiniMax H3 Reference Entry",
    "H3_ReferenceRegistry": "MiniMax H3 Reference Registry",
    "H3_SegmentOverride": "MiniMax H3 Segment Override",
    "H3_ScriptWriter": "MiniMax H3 Script Writer",
}
