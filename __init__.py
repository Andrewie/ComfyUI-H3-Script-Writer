import os
import re
import math
import random

try:
    import torch
    import numpy as np
    from PIL import Image, ImageOps
except ImportError:
    torch = None
    np = None
    Image = None
    ImageOps = None

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    import nodes
    BasePreviewImage = nodes.PreviewImage
except Exception:
    class BasePreviewImage:
        def __init__(self):
            self.output_dir = ""
            self.type = "temp"
            self.prefix_append = "_temp_"
            self.compress_level = 1

        def save_images(self, images=None, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
            return {"ui": {"images": []}, "result": (images,)}

# Media cache to prevent redundant disk I/O across executions
# Key: (normalized_path, mtime) -> loaded tensor / audio dict
_MEDIA_CACHE = {}


def _resolve_path(raw_path):
    """Resolve relative or absolute file paths across ComfyUI search locations."""
    if not raw_path:
        return None, []
    raw_path = raw_path.strip().strip('"').strip("'")

    candidates = [
        raw_path,
        os.path.abspath(raw_path),
    ]

    sub_paths = [raw_path]
    if raw_path.lower().startswith("input/") or raw_path.lower().startswith("input\\"):
        sub_paths.append(raw_path[6:])
    elif not os.path.isabs(raw_path):
        sub_paths.append(os.path.join("input", raw_path))

    # 1. Check ComfyUI input folder and ComfyUI root if folder_paths is available
    if folder_paths is not None:
        try:
            input_dir = folder_paths.get_input_directory()
            for sp in sub_paths:
                candidates.append(os.path.join(input_dir, sp))
            comfy_root = os.path.dirname(os.path.abspath(input_dir))
            for sp in sub_paths:
                candidates.append(os.path.join(comfy_root, sp))
        except Exception:
            pass

    # 2. Check custom node directory
    node_dir = os.path.dirname(os.path.abspath(__file__))
    for sp in sub_paths:
        candidates.append(os.path.join(node_dir, sp))

    searched_paths = []
    seen = set()
    for c in candidates:
        norm = os.path.normpath(c)
        if norm not in seen:
            seen.add(norm)
            searched_paths.append(norm)
            if os.path.exists(norm):
                return norm, searched_paths

    return None, searched_paths


def _load_image(path, alias=""):
    if Image is None or torch is None or np is None:
        raise RuntimeError("[H3SegmentParser] Missing required dependencies (PIL, torch, numpy) for image loading.")
    try:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)  # [1, H, W, 3]
    except Exception as exc:
        raise RuntimeError(
            f"[H3SegmentParser] Failed to load/decode reference image for alias '{alias}' from '{path}': {exc}"
        )


def _load_video(path, alias="", max_frames=None):
    if torch is None or np is None:
        raise RuntimeError("[H3SegmentParser] Missing required dependencies (torch, numpy) for video loading.")
    try:
        import av
    except ImportError:
        raise RuntimeError("[H3SegmentParser] PyAV (av) is required for video loading but is not installed.")
    try:
        container = av.open(path)
        frames = []
        for frame in container.decode(video=0):
            img = frame.to_image().convert("RGB")
            arr = np.array(img).astype(np.float32) / 255.0
            frames.append(arr)
            if max_frames and len(frames) >= max_frames:
                break
        container.close()
        if not frames:
            raise RuntimeError(f"No video frames decoded from '{path}'.")
        return torch.from_numpy(np.stack(frames))  # [T, H, W, 3]
    except Exception as exc:
        raise RuntimeError(
            f"[H3SegmentParser] Failed to load/decode reference video for alias '{alias}' from '{path}': {exc}"
        )


def _load_audio(path, alias=""):
    if torch is None:
        raise RuntimeError("[H3SegmentParser] PyTorch is required for audio loading.")
    errors = []
    try:
        import torchaudio
        waveform, sr = torchaudio.load(path)
        if waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)  # [1, C, N]
        return {"waveform": waveform, "sample_rate": sr}
    except Exception as exc:
        errors.append(f"torchaudio: {exc}")
    try:
        import av
        container = av.open(path)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=32000)
        frames = []
        for frame in container.decode(audio=0):
            resampled = resampler.resample(frame)
            if resampled:
                frames.append(resampled.to_ndarray())
        container.close()
        if frames:
            audio_data = np.concatenate(frames, axis=1)
            waveform = torch.from_numpy(audio_data).unsqueeze(0)
            return {"waveform": waveform, "sample_rate": 32000}
        else:
            errors.append("PyAV: no audio frames decoded")
    except Exception as exc:
        errors.append(f"PyAV: {exc}")
    raise RuntimeError(
        f"[H3SegmentParser] Failed to load/decode reference audio for alias '{alias}' from '{path}': " + "; ".join(errors)
    )


def _get_cached_asset(raw_path, category, alias=""):
    resolved, searched = _resolve_path(raw_path)
    if not resolved:
        searched_formatted = "\n  - " + "\n  - ".join(searched[:6])
        raise FileNotFoundError(
            f"\n[H3SegmentParser] ERROR: Reference {category} file not found for alias '{alias}'!\n"
            f"Specified path in script header: '{raw_path}'\n"
            f"Locations searched:{searched_formatted}\n"
            f"Please check for typos in the script header or verify that the source file exists."
        )

    try:
        mtime = os.path.getmtime(resolved)
    except OSError:
        mtime = 0
    cache_key = (resolved, mtime)
    if cache_key in _MEDIA_CACHE:
        return _MEDIA_CACHE[cache_key]

    data = None
    if category == "image":
        data = _load_image(resolved, alias)
    elif category == "video":
        data = _load_video(resolved, alias)
    elif category == "audio":
        data = _load_audio(resolved, alias)

    if data is None:
        raise RuntimeError(
            f"[H3SegmentParser] ERROR: Failed to decode reference {category} for alias '{alias}' from '{resolved}'."
        )

    _MEDIA_CACHE[cache_key] = data
    return data


_LAST_CACHED_HEADER_TEXT = ""


def _auto_find_script_header(segment_text):
    """
    Search ComfyUI input directory and workspace for a script file that contains
    the header references for this segment, in case an isolated segment was passed
    without wiring script_header.
    """
    search_dirs = []
    if folder_paths is not None:
        try:
            inp = folder_paths.get_input_directory()
            if inp and os.path.exists(inp):
                search_dirs.append(inp)
        except Exception:
            pass

    node_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_dir = os.path.abspath(os.path.join(node_dir, "..", ".."))
    for d in (node_dir, workspace_dir):
        if os.path.exists(d) and d not in search_dirs:
            search_dirs.append(d)

    # Extract segment number and title keywords
    seg_m = re.search(r"#?SEGMENT\s+(\d+)", segment_text, re.I)
    seg_num = seg_m.group(1) if seg_m else None

    first_line = segment_text.strip().splitlines()[0] if segment_text.strip() else ""
    first_line_clean = re.sub(r"^[#\s]+", "", first_line).strip()

    for s_dir in search_dirs:
        for root, _, files in os.walk(s_dir):
            for f in files:
                if f.endswith(".txt"):
                    f_path = os.path.join(root, f)
                    try:
                        with open(f_path, "r", encoding="utf-8", errors="ignore") as fp:
                            content = fp.read()
                        if (
                            "[IMAGE_REFERENCES]" in content
                            or "[VIDEO_REFERENCES]" in content
                            or "[AUDIO_REFERENCES]" in content
                        ):
                            if (first_line_clean and first_line_clean in content) or (
                                seg_num and re.search(rf"^\s*#?SEGMENT\s+{seg_num}\b", content, re.M | re.I)
                            ):
                                header_part = re.split(r"(?=^\s*#?SEGMENT\s+\d+)", content, flags=re.M | re.I)[0]
                                return header_part.strip(), f_path
                    except Exception:
                        pass
    return None, None


def parse_header_references(header_text):
    """
    Parse reference declarations from script header text.
    Returns: dict of alias -> {'alias': str, 'path': str, 'category': str, 'default': bool}
    """
    if not header_text:
        return {}

    VALID_EXTS = {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff",
        ".mp4", ".mov", ".mkv", ".webm", ".avi",
        ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"
    }

    references = {}
    current_category = "image"
    in_registry_section = False

    lines = header_text.splitlines()
    for line in lines:
        raw_line = line.strip().strip("|").strip()
        # Clean leading list bullets, numbers, or dashes
        raw_line = re.sub(r"^[\s\*\-\d\.]+", "", raw_line).strip()
        if not raw_line:
            continue

        # Check section headers
        sec_match = re.search(r"\[([a-zA-Z0-9_\s]+)\]", raw_line)
        if sec_match:
            sec_name = sec_match.group(1).lower()
            if "video" in sec_name:
                current_category = "video"
                in_registry_section = True
            elif "audio" in sec_name:
                current_category = "audio"
                in_registry_section = True
            elif "image" in sec_name or "picture" in sec_name:
                current_category = "image"
                in_registry_section = True
            continue

        # Skip non-reference markdown headers (e.g. **CHARACTERS**, **WORKFLOW SPECIFICATION**)
        if raw_line.startswith("**") and ("path" not in raw_line.lower() and not any(ext in raw_line.lower() for ext in VALID_EXTS)):
            continue

        # Parse boolean default
        default_val = None
        m_def = re.search(r"\bdefault\s*=\s*(true|false|1|0|on|off|yes|no)\b", raw_line, re.I)
        if m_def:
            default_val = m_def.group(1).lower() in ("true", "1", "on", "yes")
            raw_line = raw_line[:m_def.start()] + raw_line[m_def.end():]

        # Parse explicit path attribute if specified
        path = None
        m_path = re.search(r'\bpath\s*=\s*["\']?([^"\'|,;]+)["\']?', raw_line, re.I)
        if m_path:
            path = m_path.group(1).strip()
            raw_line = raw_line[:m_path.start()] + raw_line[m_path.end():]

        parts = [p.strip().strip('"').strip("'") for p in re.split(r"[:|,\t]", raw_line) if p.strip()]

        if default_val is None:
            for p in list(reversed(parts)):
                if p.lower() in ("true", "false", "1", "0", "on", "off", "yes", "no"):
                    default_val = p.lower() in ("true", "1", "on", "yes")
                    parts.remove(p)
                    break
        if default_val is None:
            default_val = False

        alias = None
        if path is None:
            for p in list(parts):
                ext = os.path.splitext(p.lower())[1]
                if ext in VALID_EXTS or "/" in p or "\\" in p:
                    path = p
                    parts.remove(p)
                    break

        if parts:
            alias = parts[0].strip().strip("*").strip("_").strip("`").strip()
        elif path:
            alias = os.path.splitext(os.path.basename(path))[0]

        # A valid reference line MUST have both alias and a path with a recognized media extension
        if not alias or not path:
            continue
        ext = os.path.splitext(path.lower())[1]
        if ext not in VALID_EXTS and not in_registry_section:
            continue

        cat = current_category
        if ext in (".mp4", ".mov", ".mkv", ".webm", ".avi"):
            cat = "video"
        elif ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
            cat = "audio"
        elif ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"):
            cat = "image"

        references[alias] = {
            "alias": alias,
            "path": path,
            "category": cat,
            "default": default_val,
        }

    return references


def parse_segment_switches_and_clean_prompt(segment_text, known_aliases=None):
    """
    Extract per-segment on/off switches and return (switches, clean_prompt).
    Switches: list of (alias, bool) in encounter order.
    """
    lines = segment_text.splitlines()
    remaining_lines = []
    switches = []
    in_ref_block = False

    known_lower = {a.lower(): a for a in known_aliases} if known_aliases else {}

    for line in lines:
        stripped = line.strip()

        # Check for [REFERENCES] or [SWITCHES] block header
        if re.match(r"^\[(REFERENCES|SWITCHES|MEDIA_SWITCHES)\]\s*$", stripped, re.I):
            in_ref_block = True
            continue

        # If in ref block and hits another section header or prompt section, exit block
        if in_ref_block and (stripped.startswith("[") or re.match(r"^[a-z_]+:\s*$", stripped)):
            in_ref_block = False

        # Match switch pattern: Alias[:=] (1|0|true|false|on|off)
        m = re.match(r"^([a-zA-Z0-9_\-\s]+?)[:=]\s*(1|0|true|false|on|off)\s*$", stripped, re.I)
        if not m and in_ref_block:
            m = re.match(r"^([a-zA-Z0-9_\-\s]+?)\s+(1|0|true|false|on|off)\s*$", stripped, re.I)

        if m:
            raw_alias = m.group(1).strip()
            raw_val = m.group(2).strip().lower()
            val = raw_val in ("1", "true", "on", "yes")

            if known_lower:
                if raw_alias.lower() in known_lower:
                    actual_alias = known_lower[raw_alias.lower()]
                    switches.append((actual_alias, val))
                    continue
                elif in_ref_block:
                    switches.append((raw_alias, val))
                    continue
            else:
                switches.append((raw_alias, val))
                continue

        if in_ref_block and not stripped:
            continue

        remaining_lines.append(line)

    clean_prompt = "\n".join(remaining_lines).strip()
    return switches, clean_prompt


class H3SegmentParser:
    NUM_PICTURES = 9
    NUM_VIDEOS = 3
    NUM_AUDIOS = 3

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "segment_text": ("STRING", {"multiline": True, "forceInput": True}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "snap_to_h3_grid": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "segment_index": ("INT", {"default": 1, "min": 0, "max": 999}),
                "script_header": ("STRING", {"multiline": True, "forceInput": True, "default": ""}),
            },
        }

    RETURN_TYPES = (
        ("STRING", "INT", "INT", "STRING")
        + ("IMAGE",) * NUM_PICTURES
        + ("IMAGE",) * NUM_VIDEOS
        + ("AUDIO",) * NUM_AUDIOS
    )
    RETURN_NAMES = (
        ("clean_prompt", "frames_24fps", "seconds", "filename_prefix")
        + tuple(f"ref_image_{i}" for i in range(1, NUM_PICTURES + 1))
        + tuple(f"ref_video_{i}" for i in range(1, NUM_VIDEOS + 1))
        + tuple(f"ref_audio_{i}" for i in range(1, NUM_AUDIOS + 1))
    )
    FUNCTION = "parse_segment"
    CATEGORY = "MiniMax_H3/Utils"

    def parse_segment(
        self,
        segment_text,
        fps=24,
        snap_to_h3_grid=True,
        segment_index=1,
        script_header="",
    ):
        global _LAST_CACHED_HEADER_TEXT
        header_text = script_header or ""

        # Check if segment_text is a file path on disk
        if isinstance(segment_text, str) and len(segment_text) < 1000 and os.path.isfile(segment_text):
            try:
                with open(segment_text, "r", encoding="utf-8", errors="ignore") as f:
                    segment_text = f.read()
            except Exception:
                pass

        # Check if segment_text contains multiple segments or a full script
        seg_split_pattern = r"(?=^\s*#?SEGMENT\s+\d+)"
        parts = re.split(seg_split_pattern, segment_text, flags=re.IGNORECASE | re.MULTILINE)

        target_segment_text = segment_text
        if len(parts) > 1:
            # First part before the first #SEGMENT is the script header
            if not header_text and parts[0].strip():
                header_text = parts[0].strip()

            segments_found = parts[1:]
            selected_segment = None

            # Attempt matching requested segment_index
            target_num_pattern = rf"^\s*#?SEGMENT\s+{segment_index}\b"
            for seg in segments_found:
                if re.search(target_num_pattern, seg, flags=re.IGNORECASE | re.MULTILINE):
                    selected_segment = seg
                    break

            if selected_segment is None:
                # Fallback: 1-indexed position in found segments
                idx = max(0, min(len(segments_found) - 1, segment_index - 1))
                selected_segment = segments_found[idx]

            target_segment_text = selected_segment

        # If header_text is still missing, attempt auto-finding the script header or using cached header
        has_ref_tags = any(k in header_text for k in ("[IMAGE_REFERENCES]", "[VIDEO_REFERENCES]", "[AUDIO_REFERENCES]", "[REFERENCES]"))
        if not header_text or not has_ref_tags:
            auto_hdr, auto_path = _auto_find_script_header(target_segment_text)
            if auto_hdr:
                header_text = auto_hdr
                _LAST_CACHED_HEADER_TEXT = auto_hdr
            elif _LAST_CACHED_HEADER_TEXT:
                header_text = _LAST_CACHED_HEADER_TEXT
        else:
            _LAST_CACHED_HEADER_TEXT = header_text

        # Parse header reference declarations
        header_refs = parse_header_references(header_text)
        known_aliases = set(header_refs.keys())

        # Match segment header line flexibly: e.g.
        # #SEGMENT 1 (12s): Arrival at the cabin
        # SEGMENT 1 (12s): Arrival
        # SEGMENT 1 - Arrival
        pattern = r"^\s*#?SEGMENT\s+(\d+)(?:\s*\((\d+)s\))?(?:\s*[:\-]\s*([^\r\n]+))?\r?\n?"
        match = re.search(pattern, target_segment_text, flags=re.IGNORECASE | re.MULTILINE)

        if match:
            seg_num = int(match.group(1))
            seconds = int(match.group(2)) if match.group(2) else 5
            raw_title = match.group(3).strip() if match.group(3) else f"segment_{seg_num}"
            # Strip the matched header line from the segment body
            body_text = target_segment_text[:match.start()] + target_segment_text[match.end():]
        else:
            seg_num = segment_index or 0
            seconds = 5
            raw_title = "untitled"
            body_text = target_segment_text

        # Sanitize title for safe filenames
        safe_title = re.sub(r"[^a-zA-Z0-9]+", "_", raw_title).strip("_")
        filename_prefix = f"Segment_{seg_num:02d}_{safe_title}"

        # Extract per-segment switches and clean prompt
        switches, clean_prompt = parse_segment_switches_and_clean_prompt(body_text, known_aliases)

        # Calculate frame length
        raw_frames = seconds * fps
        if snap_to_h3_grid:
            # MiniMax H3 native frame grid: 17k + 5 frames
            k = max(1, math.ceil((raw_frames - 5) / 17.0))
            frames = 17 * k + 5
        else:
            frames = raw_frames

        # State resolution: start with header defaults in declared order
        active_by_cat = {"image": [], "video": [], "audio": []}
        alias_to_ref = {k.lower(): v for k, v in header_refs.items()}

        for alias, ref in header_refs.items():
            cat = ref.get("category", "image")
            if ref.get("default", False):
                if alias not in active_by_cat[cat]:
                    active_by_cat[cat].append(alias)

        # Check for switches when no header reference declarations were found
        if len(switches) > 0 and len(header_refs) == 0:
            sw_names = ", ".join([s[0] for s in switches])
            raise ValueError(
                f"\n[H3SegmentParser] ERROR: Found reference switches [{sw_names}] in segment, "
                f"but no script header declarations ([IMAGE_REFERENCES], etc.) were found!\n\n"
                f"This happens when an isolated segment text is fed into the node without its header.\n"
                f"To resolve this, choose one of these options in your workflow:\n"
                f"  1. Recommended: Connect your full script text directly to 'segment_text' "
                f"(the node will automatically parse the header and use 'segment_index' to select segment {segment_index}).\n"
                f"  2. Or connect the script header (or Item 0 from your split list) into the optional 'script_header' input on H3SegmentParser.\n"
            )

        # Apply segment on/off switches in order
        for alias, state in switches:
            ref = alias_to_ref.get(alias.lower())
            if not ref:
                avail = ", ".join(list(header_refs.keys()))
                raise KeyError(
                    f"\n[H3SegmentParser] ERROR: Unknown reference alias '{alias}' in segment switches!\n"
                    f"Please check for typos. Available aliases declared in header: [{avail}]"
                )

            canon_alias = ref["alias"]
            cat = ref.get("category", "image")

            if state:  # Turn ON
                if canon_alias not in active_by_cat[cat]:
                    active_by_cat[cat].append(canon_alias)
            else:  # Turn OFF
                if canon_alias in active_by_cat[cat]:
                    active_by_cat[cat].remove(canon_alias)

        # Map to output slots
        def _populate_slots(cat, max_slots):
            active_list = active_by_cat[cat]
            if len(active_list) > max_slots:
                print(
                    f"[H3SegmentParser] Warning: {len(active_list)} active {cat} references "
                    f"exceeds maximum output slots ({max_slots}). Truncating to first {max_slots}."
                )
                active_list = active_list[:max_slots]

            outputs = []
            for alias in active_list:
                ref_obj = header_refs[alias]
                asset = _get_cached_asset(ref_obj["path"], cat, alias=alias)
                outputs.append(asset)

            # Fill remaining unactivated slots with None
            while len(outputs) < max_slots:
                outputs.append(None)
            return outputs

        image_slots = _populate_slots("image", self.NUM_PICTURES)
        video_slots = _populate_slots("video", self.NUM_VIDEOS)
        audio_slots = _populate_slots("audio", self.NUM_AUDIOS)

        return (clean_prompt, frames, seconds, filename_prefix, *image_slots, *video_slots, *audio_slots)


class SafePreviewImage(BasePreviewImage):
    """
    A None-safe image preview node that safely skips execution without crashing
    if an unactivated reference slot outputs None, while displaying standard
    previews for active image tensors.
    """
    def __init__(self):
        if hasattr(super(), "__init__"):
            super().__init__()
        if folder_paths is not None:
            self.output_dir = folder_paths.get_temp_directory()
        else:
            self.output_dir = ""
        self.type = "temp"
        self.prefix_append = "_temp_" + "".join(random.choice("abcdefghijklmnopqrstupvxyz") for _ in range(5))
        self.compress_level = 1

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "images": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "MiniMax_H3/Utils"
    DESCRIPTION = "Safely previews images or gracefully skips without crashing when receiving None from unactivated slots."

    def save_images(self, images=None, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
        if images is None:
            return {"ui": {"images": []}, "result": (None,)}
        if hasattr(images, "__len__") and len(images) == 0:
            return {"ui": {"images": []}, "result": (None,)}
        if isinstance(images, (list, tuple)) and images[0] is None:
            return {"ui": {"images": []}, "result": (None,)}

        if hasattr(super(), "save_images"):
            return super().save_images(images, filename_prefix=filename_prefix, prompt=prompt, extra_pnginfo=extra_pnginfo)
        return {"ui": {"images": []}, "result": (images,)}

    def preview(self, images=None, **kwargs):
        """Method alias for compatibility."""
        return self.save_images(images=images, **kwargs)


try:
    from .h3_script_core import (
        SUITE_NODE_CLASS_MAPPINGS,
        SUITE_NODE_DISPLAY_NAME_MAPPINGS,
        register_h3_writer_routes,
    )
except ImportError:
    from h3_script_core import (
        SUITE_NODE_CLASS_MAPPINGS,
        SUITE_NODE_DISPLAY_NAME_MAPPINGS,
        register_h3_writer_routes,
    )

try:
    from server import PromptServer
    if PromptServer.instance is not None:
        register_h3_writer_routes(PromptServer.instance)
except Exception:
    pass

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "H3SegmentParser": H3SegmentParser,
    "SafePreviewImage": SafePreviewImage,
    **SUITE_NODE_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3SegmentParser": "MiniMax H3 Segment Parser",
    "SafePreviewImage": "Safe Preview Image",
    **SUITE_NODE_DISPLAY_NAME_MAPPINGS,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
