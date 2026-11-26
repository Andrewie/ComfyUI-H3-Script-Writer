# Technical Specification: ComfyUI MiniMax H3 Script Writer Suite (3-Node Architecture)

## 1. System Architecture & Data Flow
The suite consists of three primary interconnected nodes that manage a single Structured Markdown (`.md`) script file:

`[Asset Loaders / H3_ReferenceEntry]` ──► `[1. H3_ReferenceRegistry]` ──► `[2. H3_SegmentOverride]` ──► `[3. H3_ScriptWriter]` ──► `[MiniMax H3 Sampler / Conditioning]`

### Key Design Principles
1. **Single Source of Truth on Save:** `H3_ScriptWriter` owns the file path and "Accept & Save" action, serializing live widget states from itself, `H3_SegmentOverride`, and `H3_ReferenceRegistry` into the `.md` file.
2. **Bidirectional Canvas Sync:** Selecting a segment in `H3_ScriptWriter` dynamically updates the widgets in `H3_SegmentOverride` via LiteGraph JS events.
3. **Diff-Only Segment Persistence:** `H3_SegmentOverride` displays all header assets with an `Inherit` default. Only rows explicitly overridden by the user are written to the `# SEGMENT <N>` block in the script file.

---

## 2. Node Specifications

### Node 1: `H3_ReferenceRegistry` (Global Header Controller)
Defines all available project assets and maps 1:1 to `# HEADER -> ## REGISTRY` in the script file.
- **Dynamic Inputs (`onConnectionsChange`):**
  - Accepts unlimited connections of type `IMAGE`, `VIDEO`, `AUDIO`, `LORA_STACK`, `REFMOD`, or `H3_ASSET_ENTRY` (from optional helper nodes).
  - Connecting a wire to the last slot automatically spawns the next input slot (`asset_1`, `asset_2`, ... `asset_N`).
- **Per-Slot Inline Widget Row (Custom Canvas/DOM Row per connected input):**
  - `alias` (STRING): User-typed name (e.g., `Jonathan_Portrait`, `Cabin_Exterior`, `FilmGrain_LoRA`).
  - `default_active` (BOOLEAN): Default ON/OFF state in Header.
  - `default_slot` (COMBO: `["Auto", "@1", "@2", ... "@9"]`): `Auto` assigns index by vertical position in the node; `@N` pins a specific default slot.
  - `strength_model` / `strength_clip` / `weight` (FLOAT, shown only when input type is `LORA` or `REFMOD`).
- **Outputs:**
  - `registry_bus` (`H3_REGISTRY_BUS`): Python dict containing the ordered list of asset objects, their media tensors/paths, aliases, types, default slots, and default weights.

### Node 2: `H3_SegmentOverride` (Active Segment Mixer)
Populated dynamically from the connected `H3_ReferenceRegistry` and synced with the active segment selected in `H3_ScriptWriter`.
- **Inputs:**
  - `registry_bus` (`H3_REGISTRY_BUS` from `H3_ReferenceRegistry`).
- **Dynamic Frontend UI (Auto-generated from `registry_bus`):**
  - Renders a table/list of every alias present in `H3_ReferenceRegistry`, grouped by type (`IMAGE`, `VIDEO`, `AUDIO`, `LORA`, `REFMOD`).
  - Each row contains:
    1. **Label:** `<Alias> (Header: ON @1)` (read-only indicator of the header default).
    2. **State Override (COMBO):** `["Inherit", "ON (Auto)", "OFF", "@1", "@2", "@3", "@4", "@5", "@6", "@7", "@8", "@9"]` (max `@3` for Video/Audio).
    3. **Weight Override (FLOAT Slider, only for LoRA/RefMod):** Defaults to header strength. Includes a small `Reset` toggle to revert to `Inherit`.
  - **Header Action Button:** `Reset All to Header Defaults` (sets all rows back to `Inherit`).
- **Outputs:**
  - `segment_bus` (`H3_SEGMENT_BUS`): Combines `registry_bus` with the current segment override dictionary.

### Node 3: `H3_ScriptWriter` (Prompt Editor, Transport & Router)
The master controller that loads/saves the `.md` script, manages Draft vs. Production state, compiles the 6-section H3 prompt, and routes final outputs.
- **Inputs:**
  - `segment_bus` (`H3_SEGMENT_BUS` from `H3_SegmentOverride`).
  - `model` (MODEL, optional—if provided, automatically applies active segment LoRAs and outputs patched `MODEL`).
  - `clip` (CLIP, optional—if provided, applies active segment LoRAs and outputs patched `CLIP`).
- **Standard Widgets:**
  - `script_path` (STRING): File path to `.md` script.
  - `segment_select` (COMBO): Dynamically populated list of segments (`1: Arrival at the Cabin`, `2: Unlocking the Front Door`, `+ New Segment`). Selecting `+ New Segment` copies the previous segment (title, duration, seed, cfg, reference overrides, and all 6 prompt sections) into a new segment entry.
  - `segment_title` (STRING) & `duration_sec` (INT, default 8).
  - `mode` (COMBO: `["Draft", "Production"]`).
  - `seed` (INT, with ComfyUI `control_after_generate` disabled so transport buttons control it).
  - `draft_res` (STRING: `"640x360"`), `prod_res` (STRING: `"1280x720"`).
  - `draft_steps` (INT: 15), `prod_steps` (INT: 30), `cfg` (FLOAT: 6.0).
- **Prompt Editor UI:**
  - 6 structured text inputs matching the MiniMax H3 schema:
    1. `subject_definitions`
    2. `summary`
    3. `retention_analysis`
    4. `detailed_description`
    5. `overall_soundscape`
    6. `non_diegetic_music`
  - Live Tag Helper Pill Bar: Shows clickable pills for currently active references in the segment (e.g., `[<Jonathan_Portrait> -> Picture 1]`, `[<Cabin_Foyer> -> Picture 3]`) so the writer can click to insert `<Alias>` or see which `<Picture N>` slot an asset occupies in real time.
- **Transport Action Buttons (Frontend JS):**
  1. `Generate Draft`: Sets `mode = "Draft"`, increments internal `run_nonce` (to bypass ComfyUI cache), calls `app.queuePrompt()`.
  2. `Retry`: Keeps current `seed` and `mode`, increments `run_nonce`, calls `app.queuePrompt()`.
  3. `Retry (Random Seed)`: Generates a new random 64-bit seed into the `seed` widget, sets `mode = "Draft"`, calls `app.queuePrompt()`.
  4. `Accept & Save`:
     - Traverses upstream graph links to `H3_SegmentOverride` and `H3_ReferenceRegistry`.
     - Extracts all header asset declarations + default weights from `H3_ReferenceRegistry`.
     - Extracts all non-`Inherit` overrides + modified LoRA/RefMod weights from `H3_SegmentOverride`.
     - Extracts current `seed`, `cfg`, `duration_sec`, and the 6 prompt sections from `H3_ScriptWriter`.
     - Sends payload to `POST /h3_writer/save_all` to save the entire script (`# HEADER` and all `# SEGMENT <N>` blocks) to the `.md` file on disk.
     - Switches `mode` to `"Production"`.
- **Outputs:**
  - `clean_prompt` (STRING): Compiled 6-section prompt with `<Alias>` tags replaced by resolved `<Picture N>`, `<Video N>`, `<Audio N>` tags.
  - `model` (MODEL), `clip` (CLIP), `refmod_stack` (REFMOD_STACK).
  - `width` (INT), `height` (INT), `steps` (INT), `cfg` (FLOAT), `seed` (INT), `frame_count` (INT: `17k + 5` at 24fps), `duration` (INT: segment length in seconds).
  - `ref_image_1` .. `ref_image_9` (IMAGE, 9 slots).
  - `ref_video_1` .. `ref_video_3` (VIDEO, 3 slots).
  - `ref_audio_1` .. `ref_audio_3` (AUDIO, 3 slots).

---

## 3. Cross-Node Synchronization Protocol (LiteGraph JS)

Implement a shared frontend state manager in `web/js/h3_state_sync.js`:

### Event 1: Registry Changed (`H3_ReferenceRegistry` -> `H3_SegmentOverride`)
Whenever a wire is connected/disconnected or an alias/default is edited on `H3_ReferenceRegistry`:
1. `H3_ReferenceRegistry` emits a custom graph event `h3:registry_updated` with its current array of `{ alias, type, default_active, default_slot, default_weight }`.
2. Any downstream `H3_SegmentOverride` node listening to that link rebuilds its UI rows while preserving existing overrides for matching aliases.

### Event 2: Segment Switched (`H3_ScriptWriter` -> `H3_SegmentOverride`)
Whenever the user changes `segment_select` on `H3_ScriptWriter` (or loads a `.md` file):
1. `H3_ScriptWriter` fetches the parsed AST of the `.md` file from `GET /h3_writer/load_script`.
2. It populates its own 6 prompt boxes, `seed`, `duration_sec`, and `cfg`.
3. It walks upstream (`this.getInputNode(0)`) to find `H3_SegmentOverride` and calls `overrideNode.applySegmentState(segmentData.references)`.
4. `H3_SegmentOverride` sets all rows to `"Inherit"`, then applies the specific overrides (`ON`, `OFF`, `@N`, and custom LoRA/RefMod floats) defined in `segmentData.references`.

### Event 3: Live Slot Preview (`H3_SegmentOverride` -> `H3_ScriptWriter`)
Whenever the user toggles an override or changes a `@slot` in `H3_SegmentOverride`:
1. `H3_SegmentOverride` runs the slot resolution algorithm in JS and pushes the resolved slot map (`{ Jonathan_Portrait: "Picture 1", Cabin_Foyer: "Picture 3" }`) downstream to `H3_ScriptWriter`.
2. `H3_ScriptWriter` updates its Live Tag Helper Pill Bar immediately so the writer knows the exact slot assignments before even running a generation.

---

## 4. Markdown Serialization Format for LoRAs, RefMods & Slot Overrides

When `Accept & Save` writes to the `.md` file, it serializes `# HEADER` and `# SEGMENT <N>` as follows:

```markdown
# HEADER
## METADATA
draft_res: 640x360
prod_res: 1280x720
draft_steps: 15
prod_steps: 30
cfg: 6.0

## REGISTRY
[IMAGE] @1 | Jonathan_Portrait | true
[IMAGE] @2 | Jonathan_Coat | true
[IMAGE] @3 | Cabin_Exterior | true
[IMAGE] auto | Cabin_Foyer | false
[IMAGE] auto | Brass_Latch_Closeup | false
[VIDEO] @1 | Step_Climb_Cam | true
[VIDEO] auto | Door_Glide_Cam | false
[AUDIO] @1 | Jonathan_Gravelly | true
[LORA] auto | Anamorphic_Lens.safetensors | true | model=0.75, clip=0.75
[REFMOD] auto | Depth_Control | false | weight=1.00

# SEGMENT 2
## SETTINGS
title: Unlocking the Front Door
duration: 10
seed: 89412301923
cfg: 6.0

## REFERENCES
# Only differences from HEADER are saved here:
Cabin_Exterior: false
Cabin_Foyer: @3
Step_Climb_Cam: false
Door_Glide_Cam: @1
Anamorphic_Lens.safetensors: true | model=0.50, clip=0.50
Depth_Control: true | weight=0.85

## PROMPT
subject_definitions:
...