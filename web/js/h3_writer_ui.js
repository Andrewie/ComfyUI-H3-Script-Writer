import { app } from "/scripts/app.js";
import {
    ASSET_SOCKET_TYPES,
    CATEGORY_ORDER,
    MAX_SLOTS_BY_TYPE,
    H3StateSync,
    findDownstreamNodes,
    findInactiveReferencedAliases,
    findUpstreamNode,
    generateRandomSeed,
    getNodeClass,
    guardDomWidgetWidth,
    hideBackingWidget,
    loadScriptFromServer,
    normalizeSlotToken,
    resolveInputOrigin,
    resolveSegmentSlots,
    saveAllToServer,
    snapH3Frames,
} from "./h3_state_sync.js";

const SECTION_META = [
    {
        key: "subject_definitions",
        label: "1. subject_definitions",
        hint: "1 sentence/asset • Bind <Alias> slots to <Subject N> • Zero action, weather, or emotion",
        placeholder: "<Subject 1> is the weathered log cabin with a wooden porch shown in <Cabin_Exterior>.\n<Subject 2> is the bearded man in his 40s from <Jonathan_Portrait>, wearing the olive wool coat from <Jonathan_Coat>.",
        rows: 3,
        chips: ["<Subject 1>", "<Subject 2>", "<Subject 3>"],
    },
    {
        key: "summary",
        label: "2. summary",
        hint: "Task prefix + 1 global sentence • No shot cuts or timestamps",
        placeholder: "[reference generation + audio reference] Outside <Subject 1>, <Subject 2> walks onto the porch following the camera motion of <Step_Climb_Cam> and speaks with the vocal timbre of <Jonathan_Gravelly>.",
        rows: 2,
        chips: [
            "[reference generation] ",
            "[reference generation + audio reference] ",
            "[keyframe completion + reference generation] ",
        ],
    },
    {
        key: "retention_analysis",
        label: "3. retention_analysis",
        hint: "Firewall rules per asset • Add (never a video frame) on prop/garment photos",
        placeholder: "<Subject 1>: partially_preserved - retain cabin logs and porch layout from <Cabin_Exterior>.\n<Subject 2>: fully_preserved - lock facial features from <Jonathan_Portrait>.\n<Jonathan_Coat> (never a video frame): attribute_transfer - transfer coat fabric and cut only.",
        rows: 3,
        chips: [
            "fully_preserved",
            "partially_preserved",
            "attribute_transfer",
            "weak_reference",
            "(never a video frame)",
            "reference",
            "fully_copy",
        ],
    },
    {
        key: "detailed_description",
        label: "4. detailed_description",
        hint: "Style/lens first • [Shot 1] (no 00:00.000) • Hard cuts • 1 camera move/shot • (S1) speech • 1s end buffer",
        placeholder: "Live-action, 35mm lens, cold blue twilight. [Shot 1] A medium shot opens on <Subject 1>. <Subject 2> (S1) climbs the wooden steps... At 00:02.500, <Subject 2> (S1) says: \"[English] The fire is still burning.\" [Shot 2] At 00:05.500, the camera cuts to a close-up...",
        rows: 5,
        chips: [
            "[Shot 1] ",
            "[Shot 2] At 00:05.500, the camera cuts to ",
            "(S1)",
            "\"[English] \"",
        ],
    },
    {
        key: "overall_soundscape",
        label: "5. overall_soundscape",
        hint: "1–3 sentences • Concrete [material + surface] foley & room tone • Never repeat dialogue or music",
        placeholder: "Heavy leather boots thudding on hollow wooden steps, thick wool coat rustling in the breeze, cold wind whistling through pine branches, and clear close-mic speech for (S1).",
        rows: 2,
        chips: ["clear close-mic speech for (S1)."],
    },
    {
        key: "non_diegetic_music",
        label: "6. non_diegetic_music",
        hint: "Named instrument + entry timestamp + mix level — or write None. (never leave blank)",
        placeholder: "None.",
        rows: 2,
        chips: ["None."],
    },
];

function injectSuiteStyles() {
    if (document.getElementById("h3-writer-suite-styles")) return;
    const style = document.createElement("style");
    style.id = "h3-writer-suite-styles";
    style.textContent = `
        .h3w-panel {
            --h3w-bg: color-mix(in srgb, var(--comfy-menu-bg, #1e1f24) 94%, #0f172a);
            --h3w-card: color-mix(in srgb, var(--comfy-input-bg, #14171f) 88%, #1e293b);
            --h3w-border: color-mix(in srgb, var(--border-color, #4b5563) 72%, #64748b);
            --h3w-text: var(--input-text, #e5e7eb);
            --h3w-muted: color-mix(in srgb, var(--h3w-text) 58%, transparent);
            --h3w-accent: #3b82f6;
            --h3w-img: #38bdf8;
            --h3w-vid: #a855f7;
            --h3w-aud: #f59e0b;
            --h3w-lora: #10b981;
            --h3w-refmod: #ec4899;
            --h3w-warn: #ef4444;
            box-sizing: border-box;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
            border: 1px solid var(--h3w-border);
            border-radius: 8px;
            background: var(--h3w-bg);
            color: var(--h3w-text);
            font: 12px/1.35 system-ui, -apple-system, Segoe UI, sans-serif;
            overflow: hidden;
        }
        .h3w-panel *, .h3w-panel *::before, .h3w-panel *::after {
            box-sizing: border-box;
        }
        .h3w-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding-bottom: 4px;
            border-bottom: 1px solid color-mix(in srgb, var(--h3w-border) 55%, transparent);
            flex-shrink: 0;
        }
        .h3w-header-title {
            font-weight: 700;
            font-size: 11px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: var(--h3w-muted);
        }
        .h3w-scroll {
            flex: 1 1 auto;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding-right: 2px;
        }
        .h3w-empty {
            padding: 14px 10px;
            text-align: center;
            color: var(--h3w-muted);
            border: 1px dashed color-mix(in srgb, var(--h3w-border) 60%, transparent);
            border-radius: 6px;
            font-size: 11.5px;
        }
        .h3w-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 4px 8px;
            min-height: 25px;
            border-radius: 5px;
            border: 1px solid var(--h3w-border);
            background: var(--h3w-card);
            color: var(--h3w-text);
            font: inherit;
            font-size: 11.5px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
            transition: border-color 0.12s, background 0.12s;
        }
        .h3w-btn:hover {
            border-color: var(--h3w-accent);
            background: color-mix(in srgb, var(--h3w-accent) 16%, var(--h3w-card));
        }
        .h3w-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
        .h3w-btn-primary {
            border-color: color-mix(in srgb, var(--h3w-accent) 80%, #fff);
            background: color-mix(in srgb, var(--h3w-accent) 28%, var(--h3w-card));
        }
        .h3w-btn-save {
            border-color: color-mix(in srgb, #10b981 80%, #fff);
            background: color-mix(in srgb, #10b981 26%, var(--h3w-card));
        }
        .h3w-btn-save:hover {
            border-color: #10b981;
            background: color-mix(in srgb, #10b981 38%, var(--h3w-card));
        }
        .h3w-input, .h3w-select {
            min-height: 24px;
            padding: 2px 6px;
            border-radius: 5px;
            border: 1px solid var(--h3w-border);
            background: var(--comfy-input-bg, #11131a);
            color: var(--h3w-text);
            font: inherit;
            font-size: 11.5px;
            min-width: 0;
        }
        .h3w-input:focus, .h3w-select:focus, .h3w-textarea:focus {
            outline: none;
            border-color: var(--h3w-accent);
        }
        .h3w-row {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 6px 7px;
            border-radius: 6px;
            border: 1px solid color-mix(in srgb, var(--h3w-border) 60%, transparent);
            background: var(--h3w-card);
        }
        .h3w-row-overridden {
            border-color: color-mix(in srgb, var(--h3w-accent) 75%, var(--h3w-border));
            background: color-mix(in srgb, var(--h3w-accent) 9%, var(--h3w-card));
        }
        .h3w-row-main {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .h3w-row-sub {
            display: flex;
            align-items: center;
            gap: 6px;
            padding-top: 2px;
            font-size: 11px;
            color: var(--h3w-muted);
            flex-wrap: wrap;
        }
        .h3w-badge {
            display: inline-flex;
            align-items: center;
            padding: 1px 5px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.03em;
            border: 1px solid currentColor;
            background: color-mix(in srgb, currentColor 14%, transparent);
            flex-shrink: 0;
        }
        .h3w-badge-clickable {
            cursor: pointer;
        }
        .h3w-type-IMAGE { color: var(--h3w-img); }
        .h3w-type-VIDEO { color: var(--h3w-vid); }
        .h3w-type-AUDIO { color: var(--h3w-aud); }
        .h3w-type-LORA { color: var(--h3w-lora); }
        .h3w-type-REFMOD { color: var(--h3w-refmod); }
        .h3w-toggle {
            min-width: 40px;
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid var(--h3w-border);
            font-size: 10.5px;
            font-weight: 700;
            cursor: pointer;
            text-align: center;
        }
        .h3w-toggle-on {
            color: #34d399;
            border-color: color-mix(in srgb, #10b981 70%, var(--h3w-border));
            background: color-mix(in srgb, #10b981 18%, transparent);
        }
        .h3w-toggle-off {
            color: var(--h3w-muted);
            background: transparent;
        }
        .h3w-group-hdr {
            font-size: 10.5px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            padding: 4px 2px 1px;
            color: var(--h3w-muted);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .h3w-alias-label {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 600;
        }
        .h3w-hdr-meta {
            font-weight: 400;
            font-size: 10.5px;
            color: var(--h3w-muted);
            margin-left: 5px;
        }
        .h3w-slider {
            flex: 1 1 70px;
            min-width: 60px;
            accent-color: var(--h3w-accent);
            cursor: pointer;
        }
        .h3w-num {
            width: 52px;
            text-align: right;
        }
        .h3w-transport {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            padding: 6px;
            border-radius: 6px;
            background: var(--h3w-card);
            border: 1px solid color-mix(in srgb, var(--h3w-border) 65%, transparent);
            flex-shrink: 0;
        }
        .h3w-status-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 11px;
            color: var(--h3w-muted);
            padding: 0 2px;
            flex-shrink: 0;
        }
        .h3w-status-msg {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .h3w-status-ok { color: #34d399; }
        .h3w-status-err { color: var(--h3w-warn); }
        .h3w-pillbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            padding: 6px 7px;
            border-radius: 6px;
            background: var(--h3w-card);
            border: 1px solid color-mix(in srgb, var(--h3w-border) 60%, transparent);
            flex-shrink: 0;
        }
        .h3w-pill {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 7px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 600;
            border: 1px solid currentColor;
            background: color-mix(in srgb, currentColor 13%, transparent);
            cursor: pointer;
            user-select: none;
        }
        .h3w-pill:hover {
            background: color-mix(in srgb, currentColor 25%, transparent);
        }
        .h3w-pill-arrow {
            opacity: 0.7;
            font-weight: 400;
        }
        .h3w-pill-warn {
            color: var(--h3w-warn);
            border-style: dashed;
            cursor: default;
        }
        .h3w-sec-card {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 6px 7px;
            border-radius: 6px;
            background: var(--h3w-card);
            border: 1px solid color-mix(in srgb, var(--h3w-border) 55%, transparent);
        }
        .h3w-sec-top {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 6px;
            flex-wrap: wrap;
        }
        .h3w-sec-title {
            font-weight: 700;
            font-size: 11.5px;
            color: color-mix(in srgb, var(--h3w-text) 85%, var(--h3w-accent));
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        .h3w-sec-hint {
            font-size: 10.5px;
            color: var(--h3w-muted);
        }
        .h3w-chip-row {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }
        .h3w-chip {
            padding: 1px 6px;
            border-radius: 4px;
            border: 1px solid color-mix(in srgb, var(--h3w-border) 65%, transparent);
            background: color-mix(in srgb, var(--comfy-input-bg, #11131a) 85%, transparent);
            color: var(--h3w-muted);
            font-size: 10.5px;
            font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            cursor: pointer;
        }
        .h3w-chip:hover {
            color: var(--h3w-text);
            border-color: var(--h3w-accent);
        }
        .h3w-textarea {
            width: 100%;
            resize: vertical;
            padding: 6px 8px;
            border-radius: 5px;
            border: 1px solid var(--h3w-border);
            background: var(--comfy-input-bg, #10131a);
            color: var(--h3w-text);
            font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        }
    `;
    document.head.appendChild(style);
}

function isolateDomEvents(el) {
    for (const evName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        el.addEventListener(evName, (ev) => ev.stopPropagation());
    }
    el.addEventListener("keydown", (ev) => {
        const isSave = (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key?.toLowerCase() === "s";
        const isQueue = (ev.ctrlKey || ev.metaKey) && ev.key === "Enter";
        if (!isSave && !isQueue) ev.stopPropagation();
    });
    el.addEventListener("keyup", (ev) => ev.stopPropagation());
    el.addEventListener("wheel", (ev) => {
        ev.stopPropagation();
    }, { passive: true });
}

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name) ?? null;
}

function setWidgetValue(node, name, value) {
    const w = getWidget(node, name);
    if (!w) return;
    w.value = value;
}

function insertAtCursor(textarea, snippet) {
    if (!textarea) return;
    textarea.focus();
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + snippet + after;
    const caret = start + snippet.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function inferUpstreamAssetMeta(origin) {
    if (!origin?.node) {
        return { type: "IMAGE", suggestedAlias: "", sm: 1.0, sc: 1.0, w: 1.0, canToggleImgVid: false };
    }
    const upNode = origin.node;
    const upCls = getNodeClass(upNode);
    const outType = String(origin.outputSlot?.type || "").toUpperCase();
    const outName = String(origin.outputSlot?.name || "").toLowerCase();

    if (upCls === "H3_ReferenceEntry") {
        const kindW = getWidget(upNode, "asset_type");
        const aliasW = getWidget(upNode, "alias");
        const loraW = getWidget(upNode, "lora_name");
        const smW = getWidget(upNode, "strength_model");
        const scW = getWidget(upNode, "strength_clip");
        const wW = getWidget(upNode, "weight");

        let rtype = String(kindW?.value || "AUTO").toUpperCase();
        if (rtype === "AUTO") {
            const mediaOrigin = resolveInputOrigin(upNode, 0);
            if (loraW?.value && loraW.value !== "(none)" && !mediaOrigin) {
                rtype = "LORA";
            } else if (mediaOrigin) {
                rtype = inferUpstreamAssetMeta(mediaOrigin).type;
            } else {
                rtype = "IMAGE";
            }
        }
        let suggested = String(aliasW?.value || "").trim();
        if (!suggested && rtype === "LORA" && loraW?.value && loraW.value !== "(none)") {
            suggested = String(loraW.value).split(/[\\/]/).pop();
        }
        return {
            type: rtype,
            suggestedAlias: suggested,
            sm: Number(smW?.value ?? 1.0),
            sc: Number(scW?.value ?? 1.0),
            w: Number(wW?.value ?? 1.0),
            canToggleImgVid: rtype === "IMAGE" || rtype === "VIDEO",
        };
    }

    let type = "IMAGE";
    let canToggleImgVid = false;
    if (outType.includes("AUDIO")) {
        type = "AUDIO";
    } else if (outType.includes("LORA_STACK")) {
        type = "LORA";
    } else if (outType.includes("REFMOD") || outType.includes("H3_REF_MODS")) {
        type = "REFMOD";
    } else if (outType === "VIDEO" || /video/i.test(upCls) || outName.includes("video")) {
        type = "VIDEO";
        canToggleImgVid = outType.includes("IMAGE");
    } else if (outType.includes("IMAGE")) {
        type = "IMAGE";
        canToggleImgVid = true;
    }

    let suggestedAlias = "";
    const defaultTitle = upNode.constructor?.title || upCls;
    if (upNode.title && upNode.title !== defaultTitle && upNode.title !== upCls) {
        suggestedAlias = upNode.title.trim().replace(/\s+/g, "_");
    } else {
        for (const wName of ["image", "video", "audio", "file", "lora_name", "mod_1"]) {
            const fw = getWidget(upNode, wName);
            if (fw?.value && typeof fw.value === "string" && fw.value !== "(none)") {
                const base = fw.value.split(/[\\/]/).pop();
                suggestedAlias = type === "LORA" ? base : base.replace(/\.[^.]+$/, "");
                break;
            }
        }
    }

    return { type, suggestedAlias, sm: 1.0, sc: 1.0, w: 1.0, canToggleImgVid };
}

/* ============================================================================
 * NODE 1: H3_ReferenceRegistry
 * ========================================================================== */

function mountReferenceRegistry(node) {
    if (node._h3RegistryMounted || typeof node.addDOMWidget !== "function") return;
    const stateWidget = getWidget(node, "registry_state");
    if (!stateWidget) return;
    node._h3RegistryMounted = true;

    injectSuiteStyles();
    hideBackingWidget(stateWidget);

    let rowMap = new Map(); // slot_name -> row config

    function loadFromWidget() {
        try {
            const parsed = JSON.parse(stateWidget.value || "[]");
            if (Array.isArray(parsed)) {
                rowMap = new Map();
                for (const item of parsed) {
                    if (item?.slot_name) rowMap.set(String(item.slot_name), { ...item });
                }
            }
        } catch {
            rowMap = new Map();
        }
    }

    function syncSocketsAndState() {
        const assetInputs = (node.inputs || [])
            .map((inp, idx) => ({ inp, idx, m: String(inp.name).match(/^asset_(\d+)$/) }))
            .filter((x) => x.m);

        let maxConnectedNum = 0;
        for (const item of assetInputs) {
            const num = Number(item.m[1]);
            if (item.inp.link != null && num > maxConnectedNum) {
                maxConnectedNum = num;
            }
        }

        const targetCount = Math.max(1, maxConnectedNum + 1);
        const existingNums = new Set(assetInputs.map((x) => Number(x.m[1])));

        for (let n = 1; n <= targetCount; n++) {
            if (!existingNums.has(n)) {
                node.addInput(`asset_${n}`, ASSET_SOCKET_TYPES);
            }
        }

        // Prune trailing disconnected sockets beyond targetCount from back to front
        for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
            const inp = node.inputs[i];
            const m = String(inp?.name || "").match(/^asset_(\d+)$/);
            if (m && Number(m[1]) > targetCount && inp.link == null) {
                node.removeInput(i);
            }
        }

        // Reconcile connected slots into ordered declarations
        const connectedSlots = [];
        for (let i = 0; i < (node.inputs?.length || 0); i++) {
            const inp = node.inputs[i];
            const m = String(inp?.name || "").match(/^asset_(\d+)$/);
            if (!m || inp.link == null) continue;
            const slotName = inp.name;
            const slotNum = Number(m[1]);
            const origin = resolveInputOrigin(node, i);
            const meta = inferUpstreamAssetMeta(origin);

            const prev = rowMap.get(slotName);
            let rtype = prev?.type || meta.type;
            if (!meta.canToggleImgVid && meta.type !== rtype) {
                rtype = meta.type;
            }
            const alias = (prev?.alias !== undefined && prev.alias !== "")
                ? prev.alias
                : (meta.suggestedAlias || `Asset_${slotNum}`);

            const row = {
                slot_name: slotName,
                slot_num: slotNum,
                alias,
                type: rtype,
                can_toggle_img_vid: meta.canToggleImgVid,
                default_active: prev?.default_active !== undefined ? Boolean(prev.default_active) : true,
                default_slot: normalizeSlotToken(prev?.default_slot ?? "Auto", rtype),
                strength_model: Number(prev?.strength_model ?? meta.sm ?? 1.0),
                strength_clip: Number(prev?.strength_clip ?? meta.sc ?? 1.0),
                weight: Number(prev?.weight ?? meta.w ?? 1.0),
            };
            rowMap.set(slotName, row);
            connectedSlots.push(row);
        }

        connectedSlots.sort((a, b) => a.slot_num - b.slot_num);
        return connectedSlots;
    }

    const panel = document.createElement("div");
    panel.className = "h3w-panel";
    isolateDomEvents(panel);

    const headerEl = document.createElement("div");
    headerEl.className = "h3w-header";
    const titleEl = document.createElement("span");
    titleEl.className = "h3w-header-title";
    titleEl.textContent = "Header Reference Registry";
    const countEl = document.createElement("span");
    countEl.className = "h3w-sec-hint";
    headerEl.append(titleEl, countEl);

    const listEl = document.createElement("div");
    listEl.className = "h3w-scroll";
    panel.append(headerEl, listEl);

    const domWidget = node.addDOMWidget("h3_registry_ui", "h3-registry-ui", panel, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 180,
    });
    guardDomWidgetWidth(domWidget);
    domWidget.serialize = false;

    function persistAndBroadcast(connectedRows) {
        const cleanRows = connectedRows.map((r) => ({
            slot_name: r.slot_name,
            alias: String(r.alias || "").trim() || `Asset_${r.slot_num}`,
            type: r.type,
            default_active: Boolean(r.default_active),
            default_slot: normalizeSlotToken(r.default_slot, r.type),
            strength_model: Number(r.strength_model ?? 1.0),
            strength_clip: Number(r.strength_clip ?? 1.0),
            weight: Number(r.weight ?? 1.0),
            default_weight: Number(r.weight ?? 1.0),
        }));
        stateWidget.value = JSON.stringify(cleanRows);
        countEl.textContent = `${cleanRows.length} connected`;

        H3StateSync.emit("h3:registry_updated", {
            registryNodeId: node.id,
            assets: cleanRows,
        });

        const downstreamOverrides = findDownstreamNodes(node, 0, "H3_SegmentOverride");
        for (const ovNode of downstreamOverrides) {
            ovNode._h3ReceiveRegistry?.(cleanRows);
        }
        node.setDirtyCanvas?.(true, true);
    }

    function renderRegistryUI() {
        const connectedRows = syncSocketsAndState();
        listEl.replaceChildren();

        if (connectedRows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "h3w-empty";
            empty.textContent = "Connect IMAGE, VIDEO, AUDIO, LORA_STACK, REFMOD, or H3_ReferenceEntry wires to asset_1+ to populate the global header registry.";
            listEl.appendChild(empty);
            persistAndBroadcast([]);
            return;
        }

        for (const row of connectedRows) {
            const rowEl = document.createElement("div");
            rowEl.className = "h3w-row";

            const mainLine = document.createElement("div");
            mainLine.className = "h3w-row-main";

            const idxSpan = document.createElement("span");
            idxSpan.className = "h3w-sec-hint";
            idxSpan.textContent = `#${row.slot_num}`;

            const typeBadge = document.createElement("span");
            typeBadge.className = `h3w-badge h3w-type-${row.type}${row.can_toggle_img_vid ? " h3w-badge-clickable" : ""}`;
            typeBadge.textContent = row.type;
            if (row.can_toggle_img_vid) {
                typeBadge.title = "Click to toggle IMAGE / VIDEO frame batch";
                typeBadge.addEventListener("click", () => {
                    row.type = row.type === "IMAGE" ? "VIDEO" : "IMAGE";
                    row.default_slot = normalizeSlotToken(row.default_slot, row.type);
                    rowMap.set(row.slot_name, row);
                    renderRegistryUI();
                });
            }

            const aliasInput = document.createElement("input");
            aliasInput.type = "text";
            aliasInput.className = "h3w-input";
            aliasInput.style.flex = "1 1 120px";
            aliasInput.placeholder = "Alias (e.g. Jonathan_Portrait)";
            aliasInput.value = row.alias;
            aliasInput.addEventListener("input", () => {
                row.alias = aliasInput.value;
                rowMap.set(row.slot_name, row);
                persistAndBroadcast(connectedRows);
            });

            const activeBtn = document.createElement("button");
            activeBtn.type = "button";
            const syncActiveBtn = () => {
                activeBtn.className = `h3w-toggle ${row.default_active ? "h3w-toggle-on" : "h3w-toggle-off"}`;
                activeBtn.textContent = row.default_active ? "ON" : "OFF";
                activeBtn.title = "Default header state";
            };
            syncActiveBtn();
            activeBtn.addEventListener("click", () => {
                row.default_active = !row.default_active;
                rowMap.set(row.slot_name, row);
                syncActiveBtn();
                persistAndBroadcast(connectedRows);
            });

            const slotSelect = document.createElement("select");
            slotSelect.className = "h3w-select";
            const maxS = MAX_SLOTS_BY_TYPE[row.type] ?? 0;
            const slotOpts = ["Auto"];
            for (let s = 1; s <= maxS; s++) slotOpts.push(`@${s}`);
            for (const opt of slotOpts) {
                const o = document.createElement("option");
                o.value = opt;
                o.textContent = opt;
                slotSelect.appendChild(o);
            }
            slotSelect.value = slotOpts.includes(row.default_slot) ? row.default_slot : "Auto";
            slotSelect.disabled = maxS === 0;
            slotSelect.title = "Default slot assignment";
            slotSelect.addEventListener("change", () => {
                row.default_slot = slotSelect.value;
                rowMap.set(row.slot_name, row);
                persistAndBroadcast(connectedRows);
            });

            mainLine.append(idxSpan, typeBadge, aliasInput, activeBtn, slotSelect);
            rowEl.appendChild(mainLine);

            if (row.type === "LORA") {
                const subLine = document.createElement("div");
                subLine.className = "h3w-row-sub";

                const mLbl = document.createElement("span");
                mLbl.textContent = "Model:";
                const mInput = document.createElement("input");
                mInput.type = "number";
                mInput.step = "0.05";
                mInput.className = "h3w-input h3w-num";
                mInput.value = Number(row.strength_model).toFixed(2);

                const cLbl = document.createElement("span");
                cLbl.textContent = "CLIP:";
                const cInput = document.createElement("input");
                cInput.type = "number";
                cInput.step = "0.05";
                cInput.className = "h3w-input h3w-num";
                cInput.value = Number(row.strength_clip).toFixed(2);

                const updateLora = () => {
                    row.strength_model = Number(mInput.value || 0);
                    row.strength_clip = Number(cInput.value || 0);
                    rowMap.set(row.slot_name, row);
                    persistAndBroadcast(connectedRows);
                };
                mInput.addEventListener("change", updateLora);
                cInput.addEventListener("change", updateLora);

                subLine.append(mLbl, mInput, cLbl, cInput);
                rowEl.appendChild(subLine);
            } else if (row.type === "REFMOD") {
                const subLine = document.createElement("div");
                subLine.className = "h3w-row-sub";

                const wLbl = document.createElement("span");
                wLbl.textContent = "Default Weight:";
                const wInput = document.createElement("input");
                wInput.type = "number";
                wInput.step = "0.05";
                wInput.min = "0";
                wInput.max = "2";
                wInput.className = "h3w-input h3w-num";
                wInput.value = Number(row.weight).toFixed(2);
                wInput.addEventListener("change", () => {
                    row.weight = Number(wInput.value || 0);
                    rowMap.set(row.slot_name, row);
                    persistAndBroadcast(connectedRows);
                });

                subLine.append(wLbl, wInput);
                rowEl.appendChild(subLine);
            }

            listEl.appendChild(rowEl);
        }

        persistAndBroadcast(connectedRows);
    }

    node.getRegistryDeclarations = () => {
        try {
            return JSON.parse(stateWidget.value || "[]");
        } catch {
            return [];
        }
    };

    node._h3RefreshRegistry = () => {
        loadFromWidget();
        renderRegistryUI();
    };

    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const res = origConn?.apply(this, arguments);
        setTimeout(() => renderRegistryUI(), 0);
        return res;
    };

    loadFromWidget();
    renderRegistryUI();
    node.setSize?.([
        Math.max(Number(node.size?.[0]) || 430, 430),
        Math.max(Number(node.size?.[1]) || 300, 300),
    ]);
}

/* ============================================================================
 * NODE 2: H3_SegmentOverride
 * ========================================================================== */

function mountSegmentOverride(node) {
    if (node._h3OverrideMounted || typeof node.addDOMWidget !== "function") return;
    const overrideWidget = getWidget(node, "override_state");
    if (!overrideWidget) return;
    node._h3OverrideMounted = true;

    injectSuiteStyles();
    hideBackingWidget(overrideWidget);

    let liveRegistry = [];
    let fallbackRegistry = [];
    let overrides = {}; // alias -> { state, weight_inherited, strength_model, strength_clip, weight }

    function loadOverridesFromWidget() {
        try {
            const parsed = JSON.parse(overrideWidget.value || "{}");
            overrides = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
            overrides = {};
        }
    }

    function effectiveRegistryList() {
        return liveRegistry.length > 0 ? liveRegistry : fallbackRegistry;
    }

    function saveDiffOverrides() {
        const regList = effectiveRegistryList();
        const regByAlias = new Map(regList.map((r) => [r.alias, r]));
        const pruned = {};

        for (const [alias, ov] of Object.entries(overrides)) {
            if (!ov || typeof ov !== "object") continue;
            const state = String(ov.state || "Inherit");
            const rtype = String(regByAlias.get(alias)?.type || ov.type || "IMAGE").toUpperCase();
            const weightInherited = ov.weight_inherited !== false;

            if (state === "Inherit" && (weightInherited || (rtype !== "LORA" && rtype !== "REFMOD"))) {
                continue;
            }
            const clean = { state, weight_inherited: weightInherited };
            if (!weightInherited) {
                if (rtype === "LORA") {
                    clean.strength_model = Number(ov.strength_model ?? 1.0);
                    clean.strength_clip = Number(ov.strength_clip ?? 1.0);
                } else if (rtype === "REFMOD") {
                    clean.weight = Number(ov.weight ?? 1.0);
                }
            }
            pruned[alias] = clean;
        }
        overrides = pruned;
        overrideWidget.value = JSON.stringify(pruned);
    }

    function pushSlotPreviewDownstream() {
        const resolved = resolveSegmentSlots(effectiveRegistryList(), overrides);
        H3StateSync.emit("h3:slot_preview_updated", {
            overrideNodeId: node.id,
            resolved,
        });
        const writers = findDownstreamNodes(node, 0, "H3_ScriptWriter");
        for (const wNode of writers) {
            wNode.updateLiveSlotPreview?.(resolved);
        }
    }

    const panel = document.createElement("div");
    panel.className = "h3w-panel";
    isolateDomEvents(panel);

    const headerEl = document.createElement("div");
    headerEl.className = "h3w-header";
    const titleEl = document.createElement("span");
    titleEl.className = "h3w-header-title";
    titleEl.textContent = "Active Segment Overrides";

    const resetAllBtn = document.createElement("button");
    resetAllBtn.type = "button";
    resetAllBtn.className = "h3w-btn";
    resetAllBtn.textContent = "Reset All to Header Defaults";
    resetAllBtn.addEventListener("click", () => {
        overrides = {};
        saveDiffOverrides();
        renderOverrideRows();
        pushSlotPreviewDownstream();
    });

    headerEl.append(titleEl, resetAllBtn);
    const listEl = document.createElement("div");
    listEl.className = "h3w-scroll";
    panel.append(headerEl, listEl);

    const domWidget = node.addDOMWidget("h3_override_ui", "h3-override-ui", panel, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 240,
    });
    guardDomWidgetWidth(domWidget);
    domWidget.serialize = false;

    function formatHeaderIndicator(item) {
        const onOff = item.default_active ? "ON" : "OFF";
        if (item.type === "LORA") {
            return `(Header: ${onOff} m=${Number(item.strength_model ?? 1).toFixed(2)}, c=${Number(item.strength_clip ?? 1).toFixed(2)})`;
        }
        if (item.type === "REFMOD") {
            return `(Header: ${onOff} w=${Number(item.weight ?? 1).toFixed(2)})`;
        }
        return `(Header: ${onOff} ${item.default_slot || "Auto"})`;
    }

    function renderOverrideRows() {
        const regList = effectiveRegistryList();
        listEl.replaceChildren();

        if (regList.length === 0) {
            const empty = document.createElement("div");
            empty.className = "h3w-empty";
            empty.textContent = "Connect H3_ReferenceRegistry (or load a script in H3_ScriptWriter) to mix per-segment reference overrides.";
            listEl.appendChild(empty);
            return;
        }

        for (const cat of CATEGORY_ORDER) {
            const groupItems = regList.filter((r) => String(r.type || "IMAGE").toUpperCase() === cat);
            if (groupItems.length === 0) continue;

            const grpHdr = document.createElement("div");
            grpHdr.className = "h3w-group-hdr";
            const badge = document.createElement("span");
            badge.className = `h3w-badge h3w-type-${cat}`;
            badge.textContent = cat;
            const grpTxt = document.createElement("span");
            grpTxt.textContent = `${groupItems.length} asset${groupItems.length > 1 ? "s" : ""}`;
            grpHdr.append(badge, grpTxt);
            listEl.appendChild(grpHdr);

            for (const item of groupItems) {
                const alias = item.alias;
                const curOv = overrides[alias] || { state: "Inherit", weight_inherited: true };
                const isModified = curOv.state !== "Inherit" || curOv.weight_inherited === false;

                const rowEl = document.createElement("div");
                rowEl.className = `h3w-row${isModified ? " h3w-row-overridden" : ""}`;

                const mainLine = document.createElement("div");
                mainLine.className = "h3w-row-main";

                const lbl = document.createElement("div");
                lbl.className = "h3w-alias-label";
                lbl.title = `${alias} ${formatHeaderIndicator(item)}`;
                const nameSpan = document.createElement("span");
                nameSpan.textContent = alias;
                const metaSpan = document.createElement("span");
                metaSpan.className = "h3w-hdr-meta";
                metaSpan.textContent = formatHeaderIndicator(item);
                lbl.append(nameSpan, metaSpan);

                const stateSelect = document.createElement("select");
                stateSelect.className = "h3w-select";
                const opts = ["Inherit", "ON (Auto)", "OFF"];
                const maxSlots = MAX_SLOTS_BY_TYPE[cat] ?? 0;
                for (let s = 1; s <= maxSlots; s++) opts.push(`@${s}`);
                for (const opt of opts) {
                    const o = document.createElement("option");
                    o.value = opt;
                    o.textContent = opt;
                    stateSelect.appendChild(o);
                }
                stateSelect.value = opts.includes(curOv.state) ? curOv.state : "Inherit";
                stateSelect.addEventListener("change", () => {
                    const existing = overrides[alias] || { weight_inherited: true };
                    overrides[alias] = {
                        ...existing,
                        type: cat,
                        state: stateSelect.value,
                    };
                    saveDiffOverrides();
                    renderOverrideRows();
                    pushSlotPreviewDownstream();
                });

                mainLine.append(lbl, stateSelect);
                rowEl.appendChild(mainLine);

                if (cat === "LORA") {
                    const subLine = document.createElement("div");
                    subLine.className = "h3w-row-sub";
                    const wInh = curOv.weight_inherited !== false;
                    const smVal = wInh ? Number(item.strength_model ?? 1.0) : Number(curOv.strength_model ?? item.strength_model ?? 1.0);
                    const scVal = wInh ? Number(item.strength_clip ?? 1.0) : Number(curOv.strength_clip ?? item.strength_clip ?? 1.0);

                    const mTxt = document.createElement("span");
                    mTxt.textContent = `Model: ${smVal.toFixed(2)}`;
                    const mSlider = document.createElement("input");
                    mSlider.type = "range";
                    mSlider.min = "-2.0";
                    mSlider.max = "2.0";
                    mSlider.step = "0.05";
                    mSlider.className = "h3w-slider";
                    mSlider.value = String(smVal);

                    const cTxt = document.createElement("span");
                    cTxt.textContent = `CLIP: ${scVal.toFixed(2)}`;
                    const cSlider = document.createElement("input");
                    cSlider.type = "range";
                    cSlider.min = "-2.0";
                    cSlider.max = "2.0";
                    cSlider.step = "0.05";
                    cSlider.className = "h3w-slider";
                    cSlider.value = String(scVal);

                    const resetWBtn = document.createElement("button");
                    resetWBtn.type = "button";
                    resetWBtn.className = "h3w-btn";
                    resetWBtn.textContent = wInh ? "Inherited" : "Reset";
                    resetWBtn.disabled = wInh;

                    const onLoraSlide = () => {
                        const nm = Number(mSlider.value);
                        const nc = Number(cSlider.value);
                        mTxt.textContent = `Model: ${nm.toFixed(2)}`;
                        cTxt.textContent = `CLIP: ${nc.toFixed(2)}`;
                        const existing = overrides[alias] || { state: "Inherit" };
                        overrides[alias] = {
                            ...existing,
                            type: "LORA",
                            weight_inherited: false,
                            strength_model: nm,
                            strength_clip: nc,
                        };
                        resetWBtn.disabled = false;
                        resetWBtn.textContent = "Reset";
                        rowEl.classList.add("h3w-row-overridden");
                        saveDiffOverrides();
                        pushSlotPreviewDownstream();
                    };
                    mSlider.addEventListener("input", onLoraSlide);
                    cSlider.addEventListener("input", onLoraSlide);

                    resetWBtn.addEventListener("click", () => {
                        const existing = overrides[alias] || { state: "Inherit" };
                        overrides[alias] = {
                            state: existing.state || "Inherit",
                            weight_inherited: true,
                        };
                        saveDiffOverrides();
                        renderOverrideRows();
                        pushSlotPreviewDownstream();
                    });

                    subLine.append(mTxt, mSlider, cTxt, cSlider, resetWBtn);
                    rowEl.appendChild(subLine);
                } else if (cat === "REFMOD") {
                    const subLine = document.createElement("div");
                    subLine.className = "h3w-row-sub";
                    const wInh = curOv.weight_inherited !== false;
                    const wVal = wInh ? Number(item.weight ?? 1.0) : Number(curOv.weight ?? item.weight ?? 1.0);

                    const wTxt = document.createElement("span");
                    wTxt.textContent = `Weight: ${wVal.toFixed(2)}`;
                    const wSlider = document.createElement("input");
                    wSlider.type = "range";
                    wSlider.min = "0.0";
                    wSlider.max = "1.5";
                    wSlider.step = "0.05";
                    wSlider.className = "h3w-slider";
                    wSlider.value = String(wVal);

                    const resetWBtn = document.createElement("button");
                    resetWBtn.type = "button";
                    resetWBtn.className = "h3w-btn";
                    resetWBtn.textContent = wInh ? "Inherited" : "Reset";
                    resetWBtn.disabled = wInh;

                    wSlider.addEventListener("input", () => {
                        const nw = Number(wSlider.value);
                        wTxt.textContent = `Weight: ${nw.toFixed(2)}`;
                        const existing = overrides[alias] || { state: "Inherit" };
                        overrides[alias] = {
                            ...existing,
                            type: "REFMOD",
                            weight_inherited: false,
                            weight: nw,
                        };
                        resetWBtn.disabled = false;
                        resetWBtn.textContent = "Reset";
                        rowEl.classList.add("h3w-row-overridden");
                        saveDiffOverrides();
                        pushSlotPreviewDownstream();
                    });

                    resetWBtn.addEventListener("click", () => {
                        const existing = overrides[alias] || { state: "Inherit" };
                        overrides[alias] = {
                            state: existing.state || "Inherit",
                            weight_inherited: true,
                        };
                        saveDiffOverrides();
                        renderOverrideRows();
                        pushSlotPreviewDownstream();
                    });

                    subLine.append(wTxt, wSlider, resetWBtn);
                    rowEl.appendChild(subLine);
                }

                listEl.appendChild(rowEl);
            }
        }
    }

    function pullFromUpstreamRegistry() {
        const regNode = findUpstreamNode(node, "registry_bus", "H3_ReferenceRegistry");
        liveRegistry = regNode?.getRegistryDeclarations ? regNode.getRegistryDeclarations() : [];
        saveDiffOverrides();
        renderOverrideRows();
        pushSlotPreviewDownstream();
    }

    node._h3ReceiveRegistry = (assets) => {
        liveRegistry = Array.isArray(assets) ? assets : [];
        saveDiffOverrides();
        renderOverrideRows();
        pushSlotPreviewDownstream();
    };

    node.applySegmentState = (segmentRefs, scriptHeaderRegistry = null) => {
        if (Array.isArray(scriptHeaderRegistry)) {
            fallbackRegistry = scriptHeaderRegistry;
        }
        const regList = effectiveRegistryList();
        const ciAliasMap = new Map(regList.map((r) => [r.alias.toLowerCase(), r.alias]));

        overrides = {};
        for (const [rawAlias, ov] of Object.entries(segmentRefs || {})) {
            if (!ov || typeof ov !== "object") continue;
            const canonAlias = ciAliasMap.get(rawAlias.toLowerCase()) || rawAlias;
            overrides[canonAlias] = { ...ov };
        }
        saveDiffOverrides();
        renderOverrideRows();
        pushSlotPreviewDownstream();
        node.setDirtyCanvas?.(true, true);
    };

    node.getDiffOverrides = () => {
        saveDiffOverrides();
        return { ...overrides };
    };

    node.getResolvedSlotState = () => resolveSegmentSlots(effectiveRegistryList(), overrides);

    const unsub = H3StateSync.on("h3:registry_updated", (detail) => {
        const regNode = findUpstreamNode(node, "registry_bus", "H3_ReferenceRegistry");
        if (regNode && regNode.id === detail?.registryNodeId) {
            node._h3ReceiveRegistry(detail.assets);
        }
    });

    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        unsub();
        return origRemoved?.apply(this, arguments);
    };

    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const res = origConn?.apply(this, arguments);
        setTimeout(() => pullFromUpstreamRegistry(), 0);
        return res;
    };

    node._h3RefreshOverride = () => {
        loadOverridesFromWidget();
        pullFromUpstreamRegistry();
    };

    loadOverridesFromWidget();
    pullFromUpstreamRegistry();
    node.setSize?.([
        Math.max(Number(node.size?.[0]) || 450, 450),
        Math.max(Number(node.size?.[1]) || 360, 360),
    ]);
}

/* ============================================================================
 * NODE 3: H3_ScriptWriter
 * ========================================================================== */

function mountScriptWriter(node) {
    if (node._h3WriterMounted || typeof node.addDOMWidget !== "function") return;
    const nonceWidget = getWidget(node, "run_nonce");
    if (!nonceWidget) return;
    node._h3WriterMounted = true;

    injectSuiteStyles();
    hideBackingWidget(nonceWidget);

    // Ensure ComfyUI never attaches or runs control_after_generate on seed
    for (const w of node.widgets || []) {
        if (w.name === "control_after_generate") {
            w.value = "fixed";
            hideBackingWidget(w);
        }
    }

    const sectionWidgets = {};
    for (const meta of SECTION_META) {
        const w = getWidget(node, meta.key);
        if (w) {
            hideBackingWidget(w);
            sectionWidgets[meta.key] = w;
        }
    }

    let cachedAst = null;
    let activeSegmentNumber = 1;
    let activeTextarea = null;
    let currentResolved = {
        slotMap: {},
        activePills: [],
        activeLoras: [],
        activeRefmods: [],
        allAliases: [],
    };
    const sectionTextareas = {};

    const panel = document.createElement("div");
    panel.className = "h3w-panel";
    isolateDomEvents(panel);

    // 1. Transport Action Bar
    const transportBar = document.createElement("div");
    transportBar.className = "h3w-transport";

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "h3w-btn";
    loadBtn.textContent = "Load Script";
    loadBtn.title = "Load .md / .txt script from script_path";

    const genDraftBtn = document.createElement("button");
    genDraftBtn.type = "button";
    genDraftBtn.className = "h3w-btn h3w-btn-primary";
    genDraftBtn.textContent = "Generate Draft";
    genDraftBtn.title = "Set mode = Draft, bypass cache, and queue prompt";

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "h3w-btn";
    retryBtn.textContent = "Retry";
    retryBtn.title = "Keep current seed & mode, increment nonce, and queue prompt";

    const retryRandBtn = document.createElement("button");
    retryRandBtn.type = "button";
    retryRandBtn.className = "h3w-btn";
    retryRandBtn.textContent = "Retry (Random Seed)";
    retryRandBtn.title = "Roll new random seed, set mode = Draft, and queue prompt";

    const acceptSaveBtn = document.createElement("button");
    acceptSaveBtn.type = "button";
    acceptSaveBtn.className = "h3w-btn h3w-btn-save";
    acceptSaveBtn.textContent = "Accept & Save";
    acceptSaveBtn.title = "Save entire script (Header + all Segments) to .md file and switch to Production";

    transportBar.append(loadBtn, genDraftBtn, retryBtn, retryRandBtn, acceptSaveBtn);

    // Status + Live Frame/Res Specs Bar
    const statusBar = document.createElement("div");
    statusBar.className = "h3w-status-bar";
    const specsSpan = document.createElement("span");
    const statusMsg = document.createElement("span");
    statusMsg.className = "h3w-status-msg";
    statusBar.append(specsSpan, statusMsg);

    function setStatus(text, kind = "info") {
        statusMsg.textContent = text;
        statusMsg.className = `h3w-status-msg${kind === "ok" ? " h3w-status-ok" : kind === "err" ? " h3w-status-err" : ""}`;
    }

    function updateSpecsReadout() {
        const modeVal = String(getWidget(node, "mode")?.value || "Draft");
        const dur = Number(getWidget(node, "duration_sec")?.value || 8);
        const res = modeVal === "Production"
            ? String(getWidget(node, "prod_res")?.value || "1280x720")
            : String(getWidget(node, "draft_res")?.value || "640x360");
        const steps = modeVal === "Production"
            ? Number(getWidget(node, "prod_steps")?.value || 30)
            : Number(getWidget(node, "draft_steps")?.value || 15);
        const frames = snapH3Frames(dur, 24);
        specsSpan.textContent = `${modeVal} • ${res} • ${steps} steps • ${frames} frames (${dur}s @ 24fps)`;
    }

    // 2. Live Tag Helper Pill Bar
    const pillBar = document.createElement("div");
    pillBar.className = "h3w-pillbar";

    function currentPromptValues() {
        const vals = {};
        for (const meta of SECTION_META) {
            vals[meta.key] = sectionTextareas[meta.key]?.value ?? sectionWidgets[meta.key]?.value ?? "";
        }
        return vals;
    }

    function renderPillBar() {
        pillBar.replaceChildren();
        const { activePills, activeLoras, activeRefmods, slotMap, allAliases } = currentResolved;

        if (activePills.length === 0 && activeLoras.length === 0 && activeRefmods.length === 0) {
            const hint = document.createElement("span");
            hint.className = "h3w-sec-hint";
            hint.textContent = "Live Tag Helper: No active reference slots resolved yet.";
            pillBar.appendChild(hint);
            return;
        }

        for (const pill of activePills) {
            const pEl = document.createElement("span");
            pEl.className = `h3w-pill h3w-type-${pill.type}`;
            pEl.title = `Click to insert <${pill.alias}> (Shift+Click to insert <${pill.slotLabel}>)`;

            const aliasPart = document.createElement("span");
            aliasPart.textContent = `<${pill.alias}>`;
            const arrowPart = document.createElement("span");
            arrowPart.className = "h3w-pill-arrow";
            arrowPart.textContent = `→ ${pill.slotLabel}`;
            pEl.append(aliasPart, arrowPart);

            pEl.addEventListener("click", (ev) => {
                const targetTa = activeTextarea || sectionTextareas.subject_definitions;
                const token = ev.shiftKey ? `<${pill.slotLabel}>` : `<${pill.alias}>`;
                insertAtCursor(targetTa, token);
            });
            pillBar.appendChild(pEl);
        }

        for (const lora of activeLoras) {
            const lEl = document.createElement("span");
            lEl.className = "h3w-badge h3w-type-LORA";
            lEl.textContent = `LoRA: ${lora.alias} (${lora.strength_model.toFixed(2)}/${lora.strength_clip.toFixed(2)})`;
            pillBar.appendChild(lEl);
        }

        for (const rm of activeRefmods) {
            const rEl = document.createElement("span");
            rEl.className = "h3w-badge h3w-type-REFMOD";
            rEl.textContent = `RefMod: ${rm.alias} (${rm.weight.toFixed(2)})`;
            pillBar.appendChild(rEl);
        }

        const inactiveUsed = findInactiveReferencedAliases(currentPromptValues(), slotMap, allAliases);
        for (const offAlias of inactiveUsed) {
            const wEl = document.createElement("span");
            wEl.className = "h3w-pill h3w-pill-warn";
            wEl.textContent = `⚠ <${offAlias}> is OFF`;
            wEl.title = `<${offAlias}> is referenced in the prompt, but currently inactive in Segment Override!`;
            pillBar.appendChild(wEl);
        }
    }

    // 3. Six Structured Prompt Section Editors
    const sectionsScroll = document.createElement("div");
    sectionsScroll.className = "h3w-scroll";

    for (const meta of SECTION_META) {
        const card = document.createElement("div");
        card.className = "h3w-sec-card";

        const topRow = document.createElement("div");
        topRow.className = "h3w-sec-top";
        const title = document.createElement("span");
        title.className = "h3w-sec-title";
        title.textContent = `${meta.label}:`;
        const hint = document.createElement("span");
        hint.className = "h3w-sec-hint";
        hint.textContent = meta.hint;
        topRow.append(title, hint);
        card.appendChild(topRow);

        const ta = document.createElement("textarea");
        ta.className = "h3w-textarea";
        ta.rows = meta.rows;
        ta.placeholder = meta.placeholder;
        ta.value = String(sectionWidgets[meta.key]?.value ?? "");
        sectionTextareas[meta.key] = ta;

        ta.addEventListener("focus", () => {
            activeTextarea = ta;
        });
        ta.addEventListener("input", () => {
            if (sectionWidgets[meta.key]) {
                sectionWidgets[meta.key].value = ta.value;
            }
            renderPillBar();
        });

        if (meta.chips?.length) {
            const chipRow = document.createElement("div");
            chipRow.className = "h3w-chip-row";
            for (const chipText of meta.chips) {
                const chip = document.createElement("button");
                chip.type = "button";
                chip.className = "h3w-chip";
                chip.textContent = chipText.trim();
                chip.title = `Insert "${chipText}"`;
                chip.addEventListener("click", () => insertAtCursor(ta, chipText));
                chipRow.appendChild(chip);
            }
            card.appendChild(chipRow);
        }

        card.appendChild(ta);
        sectionsScroll.appendChild(card);
    }

    panel.append(transportBar, statusBar, pillBar, sectionsScroll);

    const domWidget = node.addDOMWidget("h3_writer_studio", "h3-writer-studio", panel, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 560,
    });
    guardDomWidgetWidth(domWidget);
    domWidget.serialize = false;

    function syncTextareasFromWidgets() {
        for (const meta of SECTION_META) {
            if (sectionTextareas[meta.key] && sectionWidgets[meta.key]) {
                sectionTextareas[meta.key].value = String(sectionWidgets[meta.key].value ?? "");
            }
        }
        renderPillBar();
    }

    function setPromptBoxes(promptObj) {
        for (const meta of SECTION_META) {
            const val = String(promptObj?.[meta.key] ?? (meta.key === "non_diegetic_music" ? "None." : ""));
            if (sectionWidgets[meta.key]) sectionWidgets[meta.key].value = val;
            if (sectionTextareas[meta.key]) sectionTextareas[meta.key].value = val;
        }
    }

    function parseSelectedSegmentNumber(selectVal) {
        const s = String(selectVal || "").trim();
        if (s === "+ New Segment") {
            const maxNum = (cachedAst?.segments || []).reduce((m, seg) => Math.max(m, Number(seg.number || 0)), 0);
            return maxNum + 1;
        }
        const m = s.match(/^(\d+)\s*:/);
        return m ? Number(m[1]) : 1;
    }

    function updateSegmentComboOptions(segments, targetSelection = null) {
        const segW = getWidget(node, "segment_select");
        if (!segW) return;
        const opts = (segments || []).map((s) => `${s.number}: ${s.title}`);
        opts.push("+ New Segment");
        segW.options = { ...(segW.options || {}), values: opts };

        if (targetSelection && opts.includes(targetSelection)) {
            segW.value = targetSelection;
        } else if (!opts.includes(segW.value)) {
            segW.value = opts[0];
        }
    }

    function buildActiveSegmentSnapshot(segNum = activeSegmentNumber) {
        const num = Number(segNum) || 1;
        const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
        const existingSeg = (cachedAst?.segments || []).find((s) => Number(s.number) === num);
        const refs = ovNode?.getDiffOverrides
            ? JSON.parse(JSON.stringify(ovNode.getDiffOverrides()))
            : JSON.parse(JSON.stringify(existingSeg?.references || {}));
        return {
            number: num,
            title: String(getWidget(node, "segment_title")?.value || "").trim() || `Segment ${num}`,
            duration: Number(getWidget(node, "duration_sec")?.value || 8),
            seed: Number(getWidget(node, "seed")?.value || 0),
            cfg: Number(getWidget(node, "cfg")?.value || 6.0),
            references: refs,
            prompt: { ...currentPromptValues() },
        };
    }

    function commitCurrentSegmentToAst() {
        if (!cachedAst) {
            cachedAst = { header: { metadata: {}, registry: [] }, segments: [] };
        }
        const num = Number(activeSegmentNumber) || 1;
        const snap = buildActiveSegmentSnapshot(num);
        const idx = (cachedAst.segments || []).findIndex((s) => Number(s.number) === num);
        if (idx >= 0) {
            cachedAst.segments[idx] = snap;
        } else {
            cachedAst.segments.push(snap);
            cachedAst.segments.sort((a, b) => Number(a.number) - Number(b.number));
        }
        return snap;
    }

    function applySegmentToUI(segVal, applyHeaderMeta = false, { skipCommit = false } = {}) {
        if (!cachedAst) return;

        if (!skipCommit && activeSegmentNumber != null && (cachedAst.segments || []).length > 0) {
            commitCurrentSegmentToAst();
        }

        if (applyHeaderMeta && cachedAst.header?.metadata) {
            const m = cachedAst.header.metadata;
            if (m.draft_res) setWidgetValue(node, "draft_res", String(m.draft_res));
            if (m.prod_res) setWidgetValue(node, "prod_res", String(m.prod_res));
            if (m.draft_steps != null) setWidgetValue(node, "draft_steps", Number(m.draft_steps));
            if (m.prod_steps != null) setWidgetValue(node, "prod_steps", Number(m.prod_steps));
            if (m.cfg != null) setWidgetValue(node, "cfg", Number(m.cfg));
        }

        const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
        const headerReg = cachedAst.header?.registry || [];

        if (segVal === "+ New Segment") {
            const prevSeg =
                (cachedAst.segments || []).find((s) => Number(s.number) === Number(activeSegmentNumber)) ||
                (cachedAst.segments || [])[cachedAst.segments.length - 1] ||
                buildActiveSegmentSnapshot(1);
            const nextNum = parseSelectedSegmentNumber("+ New Segment");
            const copiedSeg = {
                number: nextNum,
                title: String(prevSeg?.title || `Segment ${nextNum}`).trim() || `Segment ${nextNum}`,
                duration: Number(prevSeg?.duration ?? 8),
                seed: Number(prevSeg?.seed ?? 0),
                cfg: Number(prevSeg?.cfg ?? getWidget(node, "cfg")?.value ?? 6.0),
                references: JSON.parse(JSON.stringify(prevSeg?.references || {})),
                prompt: { ...(prevSeg?.prompt || { non_diegetic_music: "None." }) },
            };

            cachedAst.segments.push(copiedSeg);
            cachedAst.segments.sort((a, b) => Number(a.number) - Number(b.number));
            activeSegmentNumber = nextNum;

            const newLabel = `${copiedSeg.number}: ${copiedSeg.title}`;
            updateSegmentComboOptions(cachedAst.segments, newLabel);

            setWidgetValue(node, "segment_title", copiedSeg.title);
            setWidgetValue(node, "duration_sec", copiedSeg.duration);
            setWidgetValue(node, "seed", copiedSeg.seed);
            setWidgetValue(node, "cfg", copiedSeg.cfg);
            setPromptBoxes(copiedSeg.prompt);
            ovNode?.applySegmentState?.(copiedSeg.references, headerReg);
            if (!ovNode) {
                currentResolved = resolveSegmentSlots(headerReg, copiedSeg.references);
            }
            updateSpecsReadout();
            renderPillBar();
            node.setDirtyCanvas?.(true, true);
            setStatus(`Created Segment ${nextNum} (copied from Segment ${prevSeg?.number ?? 1})`, "info");
            return;
        }

        const segNum = parseSelectedSegmentNumber(segVal);
        const segData = (cachedAst.segments || []).find((s) => Number(s.number) === segNum);
        if (!segData) return;

        activeSegmentNumber = Number(segData.number);
        setWidgetValue(node, "segment_title", String(segData.title || `Segment ${segNum}`));
        setWidgetValue(node, "duration_sec", Number(segData.duration || 8));
        setWidgetValue(node, "seed", Number(segData.seed || 0));
        if (segData.cfg != null) {
            setWidgetValue(node, "cfg", Number(segData.cfg));
        }
        setPromptBoxes(segData.prompt || {});

        if (ovNode?.applySegmentState) {
            ovNode.applySegmentState(segData.references || {}, headerReg);
        } else {
            currentResolved = resolveSegmentSlots(headerReg, segData.references || {});
        }
        updateSpecsReadout();
        renderPillBar();
        node.setDirtyCanvas?.(true, true);
        setStatus(`Loaded Segment ${segData.number}: ${segData.title}`, "ok");
    }

    async function loadScriptAndSync({ preserveCurrentBoxes = false, selectSegment = null } = {}) {
        const scriptPath = String(getWidget(node, "script_path")?.value || "").trim();
        if (!scriptPath) {
            setStatus("Enter a script_path (.md)", "err");
            return;
        }
        try {
            setStatus("Loading script...", "info");
            const data = await loadScriptFromServer(scriptPath);
            cachedAst = { header: data.header, segments: data.segments || [] };
            updateSegmentComboOptions(cachedAst.segments, selectSegment);

            const allEmpty = SECTION_META.every((m) => {
                const v = String(sectionWidgets[m.key]?.value || "").trim();
                return !v || (m.key === "non_diegetic_music" && v === "None.");
            });

            if (!preserveCurrentBoxes || allEmpty) {
                const segW = getWidget(node, "segment_select");
                applySegmentToUI(segW?.value, true, { skipCommit: true });
            } else {
                const segW = getWidget(node, "segment_select");
                if (segW?.value && segW.value !== "+ New Segment") {
                    activeSegmentNumber = parseSelectedSegmentNumber(segW.value);
                    commitCurrentSegmentToAst();
                }
                const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
                if (ovNode?.getResolvedSlotState) {
                    currentResolved = ovNode.getResolvedSlotState();
                } else if (cachedAst.header?.registry) {
                    currentResolved = resolveSegmentSlots(cachedAst.header.registry, {});
                }
                renderPillBar();
                setStatus(data.exists ? `Synced ${cachedAst.segments.length} segments` : "New script path ready", "ok");
            }
        } catch (err) {
            setStatus(err.message || String(err), "err");
        }
    }

    function bumpNonceAndQueue() {
        nonceWidget.value = (Number(nonceWidget.value) || 0) + 1;
        updateSpecsReadout();
        node.setDirtyCanvas?.(true, true);
        app.queuePrompt(0, 1);
    }

    // Button handlers
    loadBtn.addEventListener("click", () => {
        loadScriptAndSync({ preserveCurrentBoxes: false });
    });

    genDraftBtn.addEventListener("click", () => {
        setWidgetValue(node, "mode", "Draft");
        setStatus("Queued Draft generation", "ok");
        bumpNonceAndQueue();
    });

    retryBtn.addEventListener("click", () => {
        setStatus(`Retrying (${getWidget(node, "mode")?.value || "Draft"})`, "ok");
        bumpNonceAndQueue();
    });

    retryRandBtn.addEventListener("click", () => {
        const newSeed = generateRandomSeed();
        setWidgetValue(node, "seed", newSeed);
        setWidgetValue(node, "mode", "Draft");
        setStatus(`Queued Draft with seed ${newSeed}`, "ok");
        bumpNonceAndQueue();
    });

    acceptSaveBtn.addEventListener("click", async () => {
        const scriptPath = String(getWidget(node, "script_path")?.value || "").trim();
        if (!scriptPath) {
            setStatus("Set script_path before saving", "err");
            return;
        }

        const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
        const regNode = ovNode ? findUpstreamNode(ovNode, "registry_bus", "H3_ReferenceRegistry") : null;

        const registryDecls = regNode?.getRegistryDeclarations ? regNode.getRegistryDeclarations() : [];
        const registryConnected = Boolean(regNode && registryDecls.length > 0);

        const segSelectVal = getWidget(node, "segment_select")?.value;
        if (segSelectVal && segSelectVal !== "+ New Segment") {
            activeSegmentNumber = parseSelectedSegmentNumber(segSelectVal);
        }
        const activeSnap = commitCurrentSegmentToAst();
        const cfgVal = Number(getWidget(node, "cfg")?.value || 6.0);

        const payload = {
            script_path: scriptPath,
            registry_connected: registryConnected,
            header: {
                metadata: {
                    draft_res: String(getWidget(node, "draft_res")?.value || "640x360"),
                    prod_res: String(getWidget(node, "prod_res")?.value || "1280x720"),
                    draft_steps: Number(getWidget(node, "draft_steps")?.value || 15),
                    prod_steps: Number(getWidget(node, "prod_steps")?.value || 30),
                    cfg: cfgVal,
                },
                registry: registryDecls,
            },
            segment: activeSnap,
            segments: cachedAst.segments,
        };

        try {
            acceptSaveBtn.disabled = true;
            setStatus("Saving script...", "info");
            const saved = await saveAllToServer(payload);
            cachedAst = { header: saved.header, segments: saved.segments || [] };
            const label = `${activeSnap.number}: ${activeSnap.title}`;
            updateSegmentComboOptions(cachedAst.segments, label);
            setWidgetValue(node, "mode", "Production");
            updateSpecsReadout();
            node.setDirtyCanvas?.(true, true);
            setStatus(`Saved entire script (${cachedAst.segments.length} segments) → switched to Production`, "ok");
        } catch (err) {
            setStatus(err.message || String(err), "err");
        } finally {
            acceptSaveBtn.disabled = false;
        }
    });

    // Hook standard widget callbacks
    const pathW = getWidget(node, "script_path");
    if (pathW) {
        const origCb = pathW.callback;
        pathW.callback = function (...args) {
            const r = origCb?.apply(this, args);
            loadScriptAndSync({ preserveCurrentBoxes: false });
            return r;
        };
    }

    const segW = getWidget(node, "segment_select");
    if (segW) {
        const origCb = segW.callback;
        segW.callback = function (...args) {
            const r = origCb?.apply(this, args);
            if (cachedAst) {
                applySegmentToUI(segW.value, false);
            } else {
                loadScriptAndSync({ preserveCurrentBoxes: false, selectSegment: segW.value });
            }
            return r;
        };
    }

    const titleW = getWidget(node, "segment_title");
    if (titleW) {
        const origCb = titleW.callback;
        titleW.callback = function (...args) {
            const r = origCb?.apply(this, args);
            if (cachedAst) {
                const snap = commitCurrentSegmentToAst();
                updateSegmentComboOptions(cachedAst.segments, `${snap.number}: ${snap.title}`);
            }
            return r;
        };
    }

    for (const wName of ["duration_sec", "mode", "draft_res", "prod_res", "draft_steps", "prod_steps", "cfg"]) {
        const w = getWidget(node, wName);
        if (w) {
            const origCb = w.callback;
            w.callback = function (...args) {
                const r = origCb?.apply(this, args);
                updateSpecsReadout();
                return r;
            };
        }
    }

    node.updateLiveSlotPreview = (resolved) => {
        if (resolved) {
            currentResolved = resolved;
            renderPillBar();
        }
    };

    const unsubPreview = H3StateSync.on("h3:slot_preview_updated", (detail) => {
        const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
        if (ovNode && ovNode.id === detail?.overrideNodeId) {
            node.updateLiveSlotPreview(detail.resolved);
        }
    });

    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        unsubPreview();
        return origRemoved?.apply(this, arguments);
    };

    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const res = origConn?.apply(this, arguments);
        setTimeout(() => {
            const ovNode = findUpstreamNode(node, "segment_bus", "H3_SegmentOverride");
            if (ovNode?.getResolvedSlotState) {
                node.updateLiveSlotPreview(ovNode.getResolvedSlotState());
            }
        }, 0);
        return res;
    };

    node._h3RefreshWriter = () => {
        syncTextareasFromWidgets();
        updateSpecsReadout();
        loadScriptAndSync({ preserveCurrentBoxes: true });
    };

    syncTextareasFromWidgets();
    updateSpecsReadout();
    loadScriptAndSync({ preserveCurrentBoxes: true });

    node.setSize?.([
        Math.max(Number(node.size?.[0]) || 680, 680),
        Math.max(Number(node.size?.[1]) || 880, 880),
    ]);
}

/* ============================================================================
 * Extension Registration
 * ========================================================================== */

app.registerExtension({
    name: "MiniMaxH3.ScriptWriterSuite",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "H3_ReferenceRegistry") {
            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                setTimeout(() => mountReferenceRegistry(this), 0);
                return r;
            };
            const origConf = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = origConf?.apply(this, arguments);
                setTimeout(() => this._h3RefreshRegistry?.(), 0);
                return r;
            };
        } else if (nodeData.name === "H3_SegmentOverride") {
            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                setTimeout(() => mountSegmentOverride(this), 0);
                return r;
            };
            const origConf = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = origConf?.apply(this, arguments);
                setTimeout(() => this._h3RefreshOverride?.(), 0);
                return r;
            };
        } else if (nodeData.name === "H3_ScriptWriter") {
            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                setTimeout(() => mountScriptWriter(this), 0);
                return r;
            };
            const origConf = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = origConf?.apply(this, arguments);
                setTimeout(() => this._h3RefreshWriter?.(), 0);
                return r;
            };
        } else if (nodeData.name === "H3_ReferenceEntry") {
            // Propagate H3_ReferenceEntry widget edits downstream to H3_ReferenceRegistry
            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                setTimeout(() => {
                    for (const w of this.widgets || []) {
                        const prevCb = w.callback;
                        w.callback = (...args) => {
                            const res = prevCb?.apply(w, args);
                            const regs = findDownstreamNodes(this, 0, "H3_ReferenceRegistry");
                            for (const regNode of regs) regNode._h3RefreshRegistry?.();
                            return res;
                        };
                    }
                }, 0);
                return r;
            };
        }
    },

    async afterConfigureGraph() {
        for (const node of app.graph?._nodes || []) {
            const cls = getNodeClass(node);
            if (cls === "H3_ReferenceRegistry") setTimeout(() => node._h3RefreshRegistry?.(), 0);
            else if (cls === "H3_SegmentOverride") setTimeout(() => node._h3RefreshOverride?.(), 10);
            else if (cls === "H3_ScriptWriter") setTimeout(() => node._h3RefreshWriter?.(), 20);
        }
    },
});

