# ComfyUI-H3-Script-Writer

A ComfyUI custom node suite for authoring, managing, and rendering multi-segment **MiniMax H3** video production scripts (`.md`).

Designed around an interactive **Draft → Review → Accept & Save → Production** loop, the suite lets you define a project-wide pool of up to 25 reference assets once, override active assets and weights per segment, write structured 6-section H3 prompts with semantic `<Alias>` tags that automatically compile to `<Picture N>`, `<Video N>`, and `<Audio N>`, and save all changes directly back to a human-readable Markdown script file on disk.

---

## Nodes Included

| Node | Category | Purpose |
| :--- | :--- | :--- |
| **H3 Reference Registry (Header)** (`H3_ReferenceRegistry`) | `MiniMax H3/Script Suite` | Project-wide registry of up to 25 assets (`IMAGE`, `VIDEO`, `AUDIO`, `LORA`, `REFMOD`) with semantic `<Alias>` names, default active states, default slot assignments (`Auto` or `@1`..`@9`), and default LoRA/RefMod weights. |
| **H3 Reference Entry** (`H3_ReferenceEntry`) | `MiniMax H3/Script Suite` | Optional typed wrapper node for explicitly tagging an upstream `IMAGE`, `VIDEO`, `AUDIO`, `LORA_STACK`, or `REFMOD` asset with an alias and weight before feeding into the Registry. |
| **H3 Segment Override** (`H3_SegmentOverride`) | `MiniMax H3/Script Suite` | Per-segment override matrix. Inherits defaults from the Registry and lets you toggle any asset (`Inherit`, `ON (Auto)`, `OFF`, `@1`..`@9`) or override LoRA/RefMod weights for the active segment. |
| **H3 Script Writer & Router** (`H3_ScriptWriter`) | `MiniMax H3/Script Suite` | Master `.md` script loader/saver, 6-section H3 prompt editor with clickable live `<Alias> → Slot` tag pills, transport buttons (`Load Script`, `Generate Draft`, `Retry`, `Retry (Random Seed)`, `Accept & Save`), automatic LoRA patching, and deterministic output routing. |
| **H3 Segment Parser** (`H3SegmentParser`) | `text/H3` | Standalone parser node for legacy `.txt` segment files. |
| **Safe Preview Image (H3)** (`SafePreviewImage`) | `image/H3` | Preview image node that safely ignores `None` (unconnected/inactive) image slots without errors. |

---

## Key Features

- **Semantic `<Alias>` Tag Compilation**: Write `<Jonathan_Portrait>` or `<Cabin_Foyer>` inside any of the 6 H3 prompt sections (`Subject Definitions`, `Summary`, `Retention Analysis`, `Detailed Description`, `Overall Soundscape`, `Non-Diegetic Music`). The node deterministically resolves active assets into contiguous hardware slots (`ref_image_1..9`, `ref_video_1..3`, `ref_audio_1..3`) and compiles `<Alias>` tags into `<Picture 1..9>`, `<Video 1..3>`, and `<Audio 1..3>`.
- **Live Tag Helper Pill Bar**: Shows active references and their resolved slot numbers in real time (`<Jonathan_Portrait> → Picture 1`). Click any pill to insert `<Alias>` at the cursor; warning pills highlight any `<Alias>` used in the prompt that is currently turned `OFF`.
- **Two-Pass Deterministic Slot Packing**:
  - **Pass 1**: Explicit pinned overrides and defaults (`@1`..`@9` for images, `@1`..`@3` for video/audio).
  - **Pass 2**: Remaining active (`ON (Auto)`) assets pack sequentially into the lowest available slots.
- **Draft vs. Production Workflow**:
  - **Generate Draft**: Queues generation at `draft_res` (e.g. `640x360`) and `draft_steps` (e.g. `15`).
  - **Retry / Retry (Random Seed)**: Re-runs the current seed or rolls a new 64-bit seed in Draft mode.
  - **Accept & Save**: Saves the entire script (`# HEADER` and all `# SEGMENT <N>` blocks, including overrides, seeds, durations, and prompts) to disk and switches `mode` to `Production` (`prod_res`, `prod_steps`).
- **Copy on `+ New Segment`**: Selecting `+ New Segment` in the segment dropdown automatically copies the previous segment (title, duration, seed, CFG, reference overrides, and all 6 prompt sections) as the starting point for the next scene.
- **MiniMax H3 Frame Grid Snapping**: Automatically computes `frame_count` snapped to the MiniMax H3 valid frame grid (`17k + 5` at 24 fps, e.g. `8s → 192 frames`, `10s → 243 frames`) alongside a raw `duration` (`INT` seconds) output.

---

## Installation

Clone this repository into your `ComfyUI/custom_nodes/` folder:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Andrewie/ComfyUI-H3-Script-Writer.git
```

Restart ComfyUI and refresh your browser tab. No additional Python packages are required beyond standard ComfyUI dependencies.

---

## Repository Contents

- [`__init__.py`](./__init__.py) — ComfyUI node mappings, web extension export, and legacy parser/preview nodes.
- [`h3_script_core.py`](./h3_script_core.py) — Markdown AST parser/serializer, slot resolver, prompt compiler, node classes, and local `/h3_writer/*` endpoints.
- [`web/js/h3_state_sync.js`](./web/js/h3_state_sync.js) — Frontend state bus, Reroute-aware graph link traversal, and JS slot resolution mirror.
- [`web/js/h3_writer_ui.js`](./web/js/h3_writer_ui.js) — Custom LiteGraph DOM interfaces for Registry, Segment Override, and Script Writer.
- [`example_script.md`](./example_script.md) — Complete 3-segment example script in `.md` format.
- [`prompt_guidelines.md`](./prompt_guidelines.md) — MiniMax H3 prompt architecture and reference syntax guide.
- [`DEVELOPMENT_SPECIFICATION.md`](./DEVELOPMENT_SPECIFICATION.md) — Technical architecture specification.
