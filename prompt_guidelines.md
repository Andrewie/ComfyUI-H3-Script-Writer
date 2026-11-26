MiniMax H3 (`Hailuo 03`) uses a specialized **6-section production-brief prompt format** for its Reference-to-Video-and-Audio (`Ref2VA`) checkpoint. Because the H3 Omni-Transformer and tokenizer were trained directly on structured reference annotations, following the official schema from the **MiniMax-AI/MiniMax-H3** repository (`skills/h3-prompt-writing/SKILL.md` and `references/ref-en.txt`) significantly improves identity locking, motion transfer, and audio synchronization in ComfyUI.

---

## 1. The Official 6-Section Ref2VA Prompt Structure

In ComfyUI, your prompt must follow six named sections in exact order: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music`.

> **Note on angle brackets:** Inside your ComfyUI text prompt, reference tags use angle brackets (as shown inside the copy-paste code blocks below). The numbering (`Picture 1`, `Picture 2`, `Video 1`, `Audio 1`) must match the exact slot order wired into your ComfyUI `MiniMaxH3ReferenceToVideo` conditioning node.

### Blank Copy-Paste Template

```text
subject_definitions:
<Subject 1> is the [environment / location] shown in <Picture 1>, appearing as [brief description].
<Subject 2> is the [person / character Name] with the facial features, hair, and build from <Picture 2>, wearing the [garment details] from <Picture 3>.
<Video 1> is a [camera style / motion reference clip] showing [specific action or camera path].
<Audio 1> is a [male/female] voice recording for speaker timbre.

summary:
[reference generation + audio reference] In <Subject 1>, <Subject 2> performs [core action] following the camera rhythm of <Video 1> and speaks using the vocal timbre of <Audio 1>.

retention_analysis:
<Subject 1>: partially_preserved - retain the architectural layout and lighting mood from <Picture 1>.
<Subject 2>: fully_preserved - lock facial identity and hair from <Picture 2>, and attribute_transfer the jacket cut and fabric from <Picture 3> (never show <Picture 3> as a video frame).
<Video 1>: attribute_transfer - transfer camera movement trajectory and pacing only; ignore its actor, clothing, and background.
<Audio 1>: reference - match vocal timbre and speaking cadence only; do not copy its original spoken words.

detailed_description:
[Visual style, lighting, lens character]. [Shot 1] The scene opens in <Subject 1> with a [shot framing, e.g., medium shot]. In the foreground, <Subject 2> (S1) [observable physical action] using the movement timing from <Video 1>. The camera [motion verb + amplitude + speed, e.g., trucks right with small amplitude at slow speed]. At 00:02.500, <Subject 2> (S1) turns to the lens and says: "[English] Your exact dialogue line goes here." [Shot 2] At 00:06.000, the shot cuts to a close-up of <Subject 2> as [follow-up action], holding a calm expression until the clip ends.

overall_soundscape:
[Concrete diegetic/environmental sounds synchronized to actions, e.g., soft footsteps on concrete, fabric rustle, distant rain, and clear close-mic voice for (S1).]

non_diegetic_music:
[Score instrumentation, mood, tempo, and entry cue — or write "None." if you want no background music.]

```

---

## 2. Complete Populated Example (Multi-Image + Motion Video + Voice Audio)

This worked example combines a character headshot (`Picture 1`), a wardrobe/prop image (`Picture 2`), a camera/motion reference clip (`Video 1`), and a voice sample (`Audio 1`) for an 8-second generation:

```text
subject_definitions:
<Subject 1> is the woman Maya shown in <Picture 1>, with copper curls, dark brown eyes, and a warm complexion.
<Subject 2> is the matte-black ceramic espresso cup shown in <Picture 2>.
<Video 1> is a handheld medium tracking shot of a person walking down a sunlit corridor.
<Audio 1> is a warm, mid-register female voice clip.

summary:
[reference generation + audio reference] <Subject 1> walks through a sunlit brutalist concrete hallway carrying <Subject 2>, guided by the handheld camera motion of <Video 1> and speaking with the voice timbre of <Audio 1>.

retention_analysis:
<Subject 1>: fully_preserved - preserve facial identity, hairstyle, and proportions from <Picture 1>.
<Subject 2> (never a video frame): fully_preserved - retain the exact cup geometry and matte-black finish from <Picture 2>.
<Video 1>: attribute_transfer - transfer handheld tracking motion and walking cadence only; ignore its original subject and background wall color.
<Audio 1>: reference - preserve vocal timbre and natural warmth for (S1); do not copy its spoken words.

detailed_description:
Live-action, 35mm anamorphic lens, natural morning window light with soft dust motes. [Shot 1] A medium shot opens in a sunlit concrete corridor. <Subject 1> (S1) walks steadily forward in the mid-ground carrying <Subject 2> at waist height, matching the relaxed stride timing from <Video 1>. The camera tracks backward ahead of her at chest height with small amplitude at slow speed. At 00:02.000, <Subject 1> (S1) lifts <Subject 2> slightly, looks directly into the lens, and says: "[English] Take the morning at your own pace." [Shot 2] At 00:05.500, the camera cuts to a tight close-up of <Subject 1> taking a slow sip from <Subject 2> as warm sunlight catches her copper curls. She lowers the cup at 00:07.000 and smiles softly.

overall_soundscape:
Measured footsteps on polished concrete, subtle ceramic handling sound, quiet hallway room tone, and clear synchronized speech from (S1).

non_diegetic_music:
A single warm Rhodes electric-piano chord enters softly at 00:05.500 on the cut to close-up and sustains until the end.

```

---

## 3. Reference Labels, Task Prefixes & Retention Markers

MiniMax H3 distinguishes between **raw media slots** (`Picture N`, `Video N`, `Audio N`) and **extracted entities** (`Subject N`). A single image (`Picture 1`) can yield both a character (`Subject 1`) and a background environment (`Subject 2`), or you can reference `Picture 1` directly when locking it as an exact keyframe.

### Official Retention Keywords

Use these exact keywords in `retention_analysis` so the model knows what to keep and what to discard (preventing accidental background or actor bleed from motion videos):

| Modality | Retention Keyword | Exact Behavior in H3 Ref2VA |
| --- | --- | --- |
| **Visual** (`Picture N`, `Subject N`, `Video N`) | `fully_preserved` | Locks the defined identity, object geometry, or exact keyframe composition across its appearance. |
| **Visual** | `partially_preserved` | Retains specific named sub-features (e.g., room layout or a logo on a shirt) while allowing angle, lighting, or pose to change. |
| **Visual** | `attribute_transfer` | Transfers abstract properties only (e.g., clothing texture, color palette, camera path, or motion timing from `Video 1`) without copying the source subject. |
| **Visual** | `weak_reference` | Uses the asset only as a loose stylistic or mood inspiration. |
| **Audio** (`Audio N`) | `fully_copy` | Reproduces the reference audio track directly (e.g., an exact sound effect or music bed). |
| **Audio** | `partially_copy` | Keeps a core musical phrase or stem while adapting timing to the scene. |
| **Audio** | `reference` | Clones the speaker's vocal timbre and delivery style for new text dialogue without copying the original words. |
| **Audio** | `weak_reference` | Matches only broad acoustic ambiance or mood. |

### Summary Task-Type Prefixes

Start the `summary:` section with one of these bracketed tags:

* `[reference generation]` — Standard multi-image / video reference workflow.
* `[reference generation + audio reference]` — When including `Audio N` inputs for voice cloning or sound transfer.
* `[keyframe completion + reference generation]` — When using `Ref2VA` in ComfyUI to both lock a specific photo as an exact frame at a timestamp (e.g., `Picture 1 (at 0.00s): fully_preserved`) *and* inject separate reference assets (`Picture 2 (never a video frame): partially_preserved`).

---

## 4. Cheat-sheet
This cheat-sheet covers each of the six sections, ordered from top to bottom as they appear in your prompt.

---

### Quick Reference Matrix

| Section | Length Target | Style | Core Job |
| --- | --- | --- | --- |
| **1. `subject_definitions**` | 1 sentence / asset | Clinical inventory | Bind media slots (`Picture 1`) to entities (`Subject 1`) |
| **2. `summary**` | 1 sentence total | Sparse logline | Set task prefix and global relationship across all frames |
| **3. `retention_analysis**` | 1 line / asset | Firewall rules | Declare what to keep and what to discard (`keyword - rule`) |
| **4. `detailed_description**` | 60–70% of prompt | Observable action | Direct shots, camera vectors, physical motion, and `(S1)` speech |
| **5. `overall_soundscape**` | 1–3 sentences | Tactile nouns | Specify `[material + surface]` foley and room tone |
| **6. `non_diegetic_music**` | 1 sentence (or `None.`) | Technical cue | Specify score instrument, entry timestamp, and mix level |

---

### 1. `subject_definitions`

* **Rule:** State only **what the asset is** and **2–3 visible/auditory anchor traits**. Zero action, emotion, or lighting.
* **Formula:** `<Subject N> is the [noun + 2–3 physical traits] shown in <Picture N>.`

**Pattern (Do This):**

```text
subject_definitions:
<Subject 1> is the weathered log cabin with a wooden porch shown in <Picture 1>.
<Subject 2> is the bearded man in his 40s from <Picture 2>, wearing the olive wool coat from <Picture 3>.
<Video 1> is a handheld tracking clip of a person walking up stairs.
<Audio 1> is a low, gravelly male voice recording.

```

**Anti-Pattern (Avoid This):**

```text
subject_definitions:
<Subject 2> is a weary, heartbroken survivor in <Picture 2> who trudges slowly through the freezing snow toward the cabin.

```

* **Why it fails:** Putting motion (*"trudges"*), weather (*"snow"*), or internal emotion (*"heartbroken"*) into the identity registry confuses the vision extractor and causes facial identity drift.

---

### 2. `summary`

* **Rule:** Open with the **bracketed task tag**, followed by **one sentence** stating who interacts with what. Never include shot cuts or timestamps here.
* **Formula:** `[task prefix] In <Subject A>, <Subject B> performs [core action] with <Video 1> and <Audio 1>.`

**Pattern (Do This):**

```text
summary:
[reference generation + audio reference] Outside <Subject 1>, <Subject 2> walks onto the porch following the camera motion of <Video 1> and speaks with the vocal timbre of <Audio 1>.

```

**Anti-Pattern (Avoid This):**

```text
summary:
[reference generation] <Subject 2> walks up the steps in a wide shot, then at 00:05.000 cuts to a tight close-up as he grabs the frozen brass doorknob and whispers.

```

* **Why it fails:** `summary` weights every frame of the clip globally. Mentioning Shot 2's close-up or doorknob action here forces Shot 1 to start as a close-up on the doorknob too.

---

### 3. `retention_analysis`

* **Rule:** Use the exact **retention keyword**, add `(never a video frame)` on prop/garment photos, and explicitly state what to **ignore** from video/audio references.
* **Formula:** `<Tag> (optional guard): [keyword] - retain [X]; ignore [Y].`

**Pattern (Do This):**

```text
retention_analysis:
<Subject 1>: partially_preserved - retain cabin logs and porch layout from <Picture 1>; shift daylight to dusk.
<Subject 2>: fully_preserved - lock facial features from <Picture 2> and wool coat from <Picture 3>.
<Picture 3> (never a video frame): attribute_transfer - transfer coat fabric and cut only.
<Video 1>: attribute_transfer - transfer camera path and walking cadence only; ignore original actor and street background.
<Audio 1>: reference - match vocal timbre only; do not copy original spoken words.

```

**Anti-Pattern (Avoid This):**

```text
retention_analysis:
Keep the man looking like Picture 2 and use Video 1 for the handheld camera feel without copying the person in the video.

```

* **Why it fails:** Omitting strict keywords (`fully_preserved`, `attribute_transfer`) and `(never a video frame)` causes the actor from `Video 1` to bleed into your character and `Picture 3` to flash onscreen as a full frame.

---

### 4. `detailed_description`

* **Rule:** Commit to **one visual style** first. Open with `[Shot 1]` (no timestamp), use **hard cuts** (`[Shot 2] At MM:SS.mmm, the camera cuts to...`), write **one camera move per shot** (`verb + amplitude + speed`), describe **physical kinematics** instead of emotions, bind speakers as `<Subject N> (S1)`, and leave a **1.0s buffer** at the end.

**Pattern (Do This):**

```text
detailed_description:
Live-action, 35mm lens, cold blue twilight with warm porch lantern light. [Shot 1] A medium shot opens on <Subject 1>. <Subject 2> (S1) climbs the wooden steps, exhales a visible plume of breath, and rests a gloved hand on the railing. The camera tracks backward at chest height with small amplitude at slow speed. At 00:02.500, <Subject 2> (S1) looks toward the door and says: "[English] The fire is still burning." [Shot 2] At 00:05.500, the camera cuts to a close-up of <Subject 2> turning the brass knob, holding a calm expression until 00:07.000.

```

**Anti-Pattern (Avoid This):**

```text
detailed_description:
8k masterpiece, photorealistic anime. [Shot 1] At 00:00.000, <Subject 2> (John) feels a wave of deep relief as the camera pans left, zooms in, and orbits around him before dissolving into [Shot 2] where he speaks right up until 00:08.000.

```

* **Why it fails:**
* *"8k masterpiece, photorealistic anime"*: Wasted quality tokens + conflicting styles.
* *"At 00:00.000"* on Shot 1: Confuses shot-boundary parsing.
* *"(John)"*: Speaker tags must be `(S1)`, `(S2)`, never names.
* *"feels a wave of deep relief"*: Unobservable internal state (produces a frozen face).
* *"pans left, zooms in, and orbits"*: Stacked camera vectors cancel each other out.
* *"dissolving into"*: Transition words cause muddy morphing artifacts instead of clean cuts.



---

### 5. `overall_soundscape`

* **Rule:** Write 1–3 sentences using **material + surface** nouns synchronized to the physical actions in `detailed_description`. Never repeat spoken lines or music here.
* **Formula:** `[Footstep/impact material on surface], [cloth/prop foley], [ambient environment tone], and clear voice for (S1).`

**Pattern (Do This):**

```text
overall_soundscape:
Heavy leather boots thudding on hollow wooden steps, thick wool coat rustling, cold wind whistling through pine trees, a crisp metallic latch click, and clear close-mic speech for (S1).

```

**Anti-Pattern (Avoid This):**

```text
overall_soundscape:
Winter outdoor ambiance, walking sounds, sad background strings, and the man saying "The fire is still burning."

```

* **Why it fails:** Vague nouns (*"walking sounds"*) produce generic white noise, while putting music or dialogue here causes the AudioVAE to bake string reverb directly into the character's voice.

---

### 6. `non_diegetic_music`

* **Rule:** State **instrument + mood/tempo + entry timestamp + mix level**, or write `None.` explicitly. Never leave blank.
* **Formula:** `[Instrument] enters at [MM:SS.mmm], mixed [level] — OR None.`

**Pattern (Do This):**

```text
non_diegetic_music:
A single sustained low cello note enters softly at 00:05.500 on the cut to close-up, mixed restrained beneath the wind.

```

*(Or when no music is wanted):*

```text
non_diegetic_music:
None.

```

**Anti-Pattern (Avoid This):**

```text
non_diegetic_music:


```

*(Or writing: `"An epic, emotional cinematic soundtrack that builds tension."`)*

* **Why it fails:** Leaving the section empty causes H3's AudioVAE to hallucinate low-frequency static/hum; abstract mood words without named instruments generate distorted synth noise.