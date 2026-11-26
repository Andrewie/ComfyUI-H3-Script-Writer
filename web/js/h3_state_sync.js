import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const H3_PROMPT_SECTIONS = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
];

export const CATEGORY_ORDER = ["IMAGE", "VIDEO", "AUDIO", "LORA", "REFMOD"];

export const MAX_SLOTS_BY_TYPE = {
    IMAGE: 9,
    VIDEO: 3,
    AUDIO: 3,
};

export const SLOT_PREFIX_BY_TYPE = {
    IMAGE: "Picture",
    VIDEO: "Video",
    AUDIO: "Audio",
};

export const ASSET_SOCKET_TYPES = "IMAGE,VIDEO,AUDIO,LORA_STACK,REFMOD,H3_REF_MODS,H3_ASSET_ENTRY";

const TOKEN_HEADER = "X-H3-Writer-Token";
let csrfToken = "";

const busTarget = new EventTarget();

export const H3StateSync = {
    on(eventName, handler) {
        const listener = (ev) => handler(ev.detail);
        busTarget.addEventListener(eventName, listener);
        return () => busTarget.removeEventListener(eventName, listener);
    },

    emit(eventName, detail) {
        busTarget.dispatchEvent(new CustomEvent(eventName, { detail }));
    },
};

export function normalizeSlotToken(rawSlot, assetType = "IMAGE") {
    if (!rawSlot) return "Auto";
    const s = String(rawSlot).trim();
    if (s.toLowerCase() === "auto") return "Auto";
    const m = s.match(/^@(\d+)$/);
    if (m) {
        const idx = Number(m[1]);
        const maxSlot = MAX_SLOTS_BY_TYPE[String(assetType).toUpperCase()] ?? 9;
        if (idx >= 1 && idx <= maxSlot) return `@${idx}`;
    }
    return "Auto";
}

export function snapH3Frames(durationSec, fps = 24) {
    const raw = Math.max(5, Math.round(Number(durationSec || 8) * Number(fps || 24)));
    if (raw <= 5) return 5;
    const k = Math.max(0, Math.ceil((raw - 5) / 17.0));
    return 17 * k + 5;
}

export function generateRandomSeed() {
    // Max lossless seed in ComfyUI JS widgets (2^50 = 1,125,899,906,842,624)
    const arr = new Uint32Array(2);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(arr);
    } else {
        arr[0] = Math.floor(Math.random() * 0x100000000);
        arr[1] = Math.floor(Math.random() * 0x100000000);
    }
    const high18 = arr[0] & 0x3ffff;
    const seed = high18 * 4294967296 + arr[1];
    return Math.max(1, seed);
}

/**
 * Deterministic JS slot resolver matching h3_script_core.py:resolve_segment_assets 1:1.
 */
export function resolveSegmentSlots(registryAssets, overrides) {
    const assets = Array.isArray(registryAssets) ? registryAssets : [];
    const ovMap = overrides && typeof overrides === "object" ? overrides : {};
    const ovCi = new Map();
    for (const [k, v] of Object.entries(ovMap)) {
        if (v && typeof v === "object") ovCi.set(k.toLowerCase(), v);
    }

    const slotsByType = {
        IMAGE: new Array(MAX_SLOTS_BY_TYPE.IMAGE).fill(null),
        VIDEO: new Array(MAX_SLOTS_BY_TYPE.VIDEO).fill(null),
        AUDIO: new Array(MAX_SLOTS_BY_TYPE.AUDIO).fill(null),
    };
    const autoHeaderQueue = { IMAGE: [], VIDEO: [], AUDIO: [] };
    const autoSegmentQueue = { IMAGE: [], VIDEO: [], AUDIO: [] };
    const collisionQueue = { IMAGE: [], VIDEO: [], AUDIO: [] };

    const activeLoras = [];
    const activeRefmods = [];
    const allAliases = [];

    for (const asset of assets) {
        const alias = String(asset?.alias ?? "").trim();
        if (!alias) continue;
        allAliases.push(alias);

        let rtype = String(asset?.type ?? "IMAGE").toUpperCase();
        if (rtype === "PICTURE") rtype = "IMAGE";

        const ov = ovMap[alias] ?? ovCi.get(alias.toLowerCase()) ?? {};
        const state = String(ov.state ?? "Inherit").trim();
        const weightInherited = ov.weight_inherited !== false;

        const defaultActive = asset.default_active !== false;
        const defaultSlot = normalizeSlotToken(asset.default_slot ?? "Auto", rtype);

        let effActive = defaultActive;
        let effSlot = defaultSlot;
        let fromHeader = true;

        if (state === "Inherit") {
            effActive = defaultActive;
            effSlot = defaultSlot;
            fromHeader = true;
        } else if (state === "OFF") {
            effActive = false;
            effSlot = "Auto";
            fromHeader = false;
        } else if (state === "ON (Auto)") {
            effActive = true;
            effSlot = "Auto";
            fromHeader = false;
        } else if (state.startsWith("@")) {
            effActive = true;
            effSlot = normalizeSlotToken(state, rtype);
            fromHeader = false;
        }

        if (!effActive) continue;

        if (rtype === "LORA") {
            const sm = weightInherited
                ? Number(asset.strength_model ?? 1.0)
                : Number(ov.strength_model ?? asset.strength_model ?? 1.0);
            const sc = weightInherited
                ? Number(asset.strength_clip ?? 1.0)
                : Number(ov.strength_clip ?? asset.strength_clip ?? 1.0);
            activeLoras.push({
                alias,
                type: "LORA",
                strength_model: sm,
                strength_clip: sc,
            });
            continue;
        }

        if (rtype === "REFMOD") {
            const w = weightInherited
                ? Number(asset.weight ?? asset.default_weight ?? 1.0)
                : Number(ov.weight ?? asset.weight ?? asset.default_weight ?? 1.0);
            activeRefmods.push({
                alias,
                type: "REFMOD",
                weight: w,
            });
            continue;
        }

        if (!slotsByType[rtype]) continue;

        const maxS = MAX_SLOTS_BY_TYPE[rtype];
        if (effSlot.startsWith("@")) {
            const idx = Number(effSlot.slice(1)) - 1;
            if (idx >= 0 && idx < maxS && slotsByType[rtype][idx] === null) {
                slotsByType[rtype][idx] = asset;
            } else {
                collisionQueue[rtype].push(asset);
            }
        } else if (fromHeader) {
            autoHeaderQueue[rtype].push(asset);
        } else {
            autoSegmentQueue[rtype].push(asset);
        }
    }

    const slotMap = {};
    const activePills = [];

    for (const rtype of ["IMAGE", "VIDEO", "AUDIO"]) {
        const arr = slotsByType[rtype];
        const pending = [
            ...collisionQueue[rtype],
            ...autoHeaderQueue[rtype],
            ...autoSegmentQueue[rtype],
        ];
        let pIdx = 0;
        for (let sIdx = 0; sIdx < arr.length; sIdx++) {
            if (arr[sIdx] === null && pIdx < pending.length) {
                arr[sIdx] = pending[pIdx++];
            }
        }
        const prefix = SLOT_PREFIX_BY_TYPE[rtype];
        for (let sIdx = 0; sIdx < arr.length; sIdx++) {
            const item = arr[sIdx];
            if (item) {
                const resolvedLabel = `${prefix} ${sIdx + 1}`;
                slotMap[item.alias] = resolvedLabel;
                activePills.push({
                    alias: item.alias,
                    type: rtype,
                    slotLabel: resolvedLabel,
                    slotIndex: sIdx + 1,
                });
            }
        }
    }

    return {
        slotMap,
        activePills,
        activeLoras,
        activeRefmods,
        allAliases,
    };
}

export function findInactiveReferencedAliases(promptSections, slotMap, allAliases) {
    const activeSet = new Set(Object.keys(slotMap || {}).map((a) => a.toLowerCase()));
    const knownMap = new Map((allAliases || []).map((a) => [a.toLowerCase(), a]));
    const warnings = new Set();

    const combined = Object.values(promptSections || {}).join("\n");
    const tagRegex = /<([^<>]+)>/g;
    let match;
    while ((match = tagRegex.exec(combined)) !== null) {
        const inner = match[1].trim().toLowerCase();
        if (knownMap.has(inner) && !activeSet.has(inner)) {
            warnings.add(knownMap.get(inner));
        }
    }
    return [...warnings];
}

export function getNodeClass(node) {
    return node?.comfyClass || node?.type || "";
}

function getLinkById(graph, linkId) {
    if (!graph || linkId == null) return null;
    if (graph.links instanceof Map) return graph.links.get(linkId) ?? null;
    return graph.links?.[linkId] ?? null;
}

/**
 * Walk upstream from an input slot, transparently crossing Reroute nodes.
 */
export function findUpstreamNode(node, inputIndexOrName, expectedClass = null) {
    const graph = node?.graph || app.graph;
    if (!node || !graph) return null;

    let slotIndex = typeof inputIndexOrName === "number"
        ? inputIndexOrName
        : (node.inputs || []).findIndex((inp) => inp.name === inputIndexOrName);
    if (slotIndex < 0) return null;

    let current = node;
    let currentSlot = slotIndex;
    const visited = new Set();

    while (current) {
        const visitKey = `${current.id}:${currentSlot}`;
        if (visited.has(visitKey)) break;
        visited.add(visitKey);

        const inp = current.inputs?.[currentSlot];
        if (!inp || inp.link == null) return null;
        const link = getLinkById(graph, inp.link);
        if (!link) return null;

        const originNode = graph.getNodeById(link.origin_id);
        if (!originNode) return null;

        const cls = getNodeClass(originNode);
        if (!expectedClass || cls === expectedClass) {
            if (cls === "Reroute" || cls === "Reroute (rgthree)") {
                current = originNode;
                currentSlot = 0;
                continue;
            }
            return originNode;
        }
        if (cls === "Reroute" || cls === "Reroute (rgthree)") {
            current = originNode;
            currentSlot = 0;
            continue;
        }
        return null;
    }
    return null;
}

/**
 * Find direct upstream origin node & output slot for a specific input slot (crossing Reroutes).
 */
export function resolveInputOrigin(node, slotIndex) {
    const graph = node?.graph || app.graph;
    if (!node || !graph) return null;

    let current = node;
    let currentSlot = slotIndex;
    const visited = new Set();

    while (current) {
        const key = `${current.id}:${currentSlot}`;
        if (visited.has(key)) return null;
        visited.add(key);

        const inp = current.inputs?.[currentSlot];
        if (!inp || inp.link == null) return null;
        const link = getLinkById(graph, inp.link);
        if (!link) return null;

        const originNode = graph.getNodeById(link.origin_id);
        if (!originNode) return null;

        const cls = getNodeClass(originNode);
        if (cls === "Reroute" || cls === "Reroute (rgthree)") {
            current = originNode;
            currentSlot = 0;
            continue;
        }
        return {
            node: originNode,
            slotIndex: link.origin_slot,
            outputSlot: originNode.outputs?.[link.origin_slot] ?? null,
        };
    }
    return null;
}

/**
 * Walk downstream from output slot 0, transparently crossing Reroute nodes.
 */
export function findDownstreamNodes(node, outputIndex = 0, expectedClass = null) {
    const graph = node?.graph || app.graph;
    if (!node || !graph) return [];

    const results = [];
    const queue = [{ current: node, outSlot: outputIndex }];
    const visited = new Set();

    while (queue.length > 0) {
        const { current, outSlot } = queue.shift();
        const key = `${current.id}:${outSlot}`;
        if (visited.has(key)) continue;
        visited.add(key);

        const out = current.outputs?.[outSlot];
        const links = out?.links || [];
        for (const linkId of links) {
            const link = getLinkById(graph, linkId);
            if (!link) continue;
            const target = graph.getNodeById(link.target_id);
            if (!target) continue;
            const cls = getNodeClass(target);
            if (cls === "Reroute" || cls === "Reroute (rgthree)") {
                queue.push({ current: target, outSlot: 0 });
            } else if (!expectedClass || cls === expectedClass) {
                if (!results.includes(target)) results.push(target);
            }
        }
    }
    return results;
}

/**
 * Guard DOM widgets against LiteGraph legacy width persistence bug (#12443).
 */
export function guardDomWidgetWidth(widget) {
    if (!widget || typeof widget !== "object" || widget.__h3_width_guarded) return;
    const prev = Object.getOwnPropertyDescriptor(widget, "width");
    if (prev && !prev.configurable) return;

    let vueWidth = widget.width;
    Object.defineProperty(widget, "width", {
        configurable: true,
        enumerable: prev?.enumerable ?? true,
        get() {
            return Boolean(globalThis.LiteGraph?.vueNodesMode) ? vueWidth : undefined;
        },
        set(val) {
            vueWidth = Boolean(globalThis.LiteGraph?.vueNodesMode) ? val : undefined;
        },
    });
    widget.__h3_width_guarded = true;
}

export function hideBackingWidget(widget) {
    if (!widget || widget._h3BackingHidden) return;
    widget._h3BackingHidden = true;
    widget.hidden = true;
    widget.options = { ...(widget.options || {}), hidden: true };
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
}

async function ensureCsrfToken() {
    if (csrfToken) return csrfToken;
    const res = await api.fetchApi("/h3_writer/token", { method: "GET" });
    const data = await res.json();
    if (data?.token) csrfToken = data.token;
    return csrfToken;
}

export async function loadScriptFromServer(scriptPath) {
    const query = encodeURIComponent(String(scriptPath || "").trim());
    const res = await api.fetchApi(`/h3_writer/load_script?path=${query}`, { method: "GET" });
    const data = await res.json();
    if (data?.token) csrfToken = data.token;
    if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status} loading script`);
    }
    return data;
}

export async function saveAllToServer(payload) {
    const token = await ensureCsrfToken();
    const res = await api.fetchApi("/h3_writer/save_all", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            [TOKEN_HEADER]: token,
        },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status} saving script`);
    }
    return data;
}

