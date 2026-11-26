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
[IMAGE] auto | Hearth_Embers | false
[IMAGE] auto | Fire_Poker_Macro | false
[VIDEO] @1 | Step_Climb_Cam | true
[VIDEO] auto | Door_Glide_Cam | false
[VIDEO] auto | Crane_Tilt_Cam | false
[AUDIO] @1 | Jonathan_Gravelly | true

# SEGMENT 1
## SETTINGS
title: Arrival at the Cabin
duration: 8
seed: 41892031104
cfg: 6.0

## REFERENCES
# Only differences from HEADER are saved here:
Brass_Latch_Closeup: true

## PROMPT
subject_definitions:
<Subject 1> is the weathered log cabin with a wooden porch shown in <Cabin_Exterior>.
<Subject 2> is the bearded man in his 40s from <Jonathan_Portrait>, wearing the olive wool coat from <Jonathan_Coat>.
<Subject 3> is the heavy brass door latch shown in <Brass_Latch_Closeup>.
<Step_Climb_Cam> is a handheld tracking clip of a person climbing outdoor steps.
<Jonathan_Gravelly> is a low, gravelly male voice recording.

summary:
[reference generation + audio reference] Outside <Subject 1>, <Subject 2> walks onto the porch following the camera motion of <Step_Climb_Cam> and speaks with the vocal timbre of <Jonathan_Gravelly>.

retention_analysis:
<Subject 1>: partially_preserved - retain cabin logs and porch layout from <Cabin_Exterior>; shift daylight to dusk.
<Subject 2>: fully_preserved - lock facial features from <Jonathan_Portrait> and wool coat from <Jonathan_Coat>.
<Jonathan_Coat> (never a video frame): attribute_transfer - transfer coat fabric and cut only.
<Subject 3> (never a video frame): fully_preserved - retain brass latch shape from <Brass_Latch_Closeup>.
<Step_Climb_Cam>: attribute_transfer - transfer camera path and walking cadence only; ignore original actor and street background.
<Jonathan_Gravelly>: reference - match vocal timbre only; do not copy original spoken words.

detailed_description:
Live-action, 35mm lens, cold blue twilight with warm porch lantern light. [Shot 1] A medium shot opens on <Subject 1>. <Subject 2> (S1) climbs the wooden steps, exhales a visible plume of white vapor into the freezing air, and rests a gloved hand on the timber railing, matching the climbing cadence from <Step_Climb_Cam>. The camera tracks backward at chest height with small amplitude at slow speed. At 00:02.500, <Subject 2> (S1) looks toward the cabin door and says: "[English] The fire is still burning." [Shot 2] At 00:05.500, the camera cuts to a close-up of <Subject 2> reaching for <Subject 3>, holding a focused, calm expression until 00:07.000.

overall_soundscape:
Heavy leather boots thudding on hollow wooden steps, thick wool coat rustling in the breeze, cold wind whistling through subalpine pine branches, a crisp metallic latch click, and clear close-mic speech for (S1).

non_diegetic_music:
A single sustained low cello note enters softly at 00:05.500 on the cut to close-up, mixed restrained beneath the ambient wind.

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

## PROMPT
subject_definitions:
<Subject 1> is the rustic cabin foyer and doorway shown in <Cabin_Foyer>.
<Subject 2> is the bearded man in his 40s from <Jonathan_Portrait>, wearing the olive wool coat from <Jonathan_Coat>.
<Door_Glide_Cam> is a smooth forward tracking shot gliding through an opening doorway.
<Jonathan_Gravelly> is a low, gravelly male voice recording.

summary:
[reference generation + audio reference] In <Subject 1>, <Subject 2> unlocks and opens the heavy timber door following the camera movement of <Door_Glide_Cam> and speaks with the vocal timbre of <Jonathan_Gravelly>.

retention_analysis:
<Subject 1>: fully_preserved - lock timber wall textures and stone floor layout from <Cabin_Foyer>.
<Subject 2>: fully_preserved - lock facial identity from <Jonathan_Portrait> and wardrobe silhouette from <Jonathan_Coat>.
<Jonathan_Coat> (never a video frame): attribute_transfer - transfer olive wool texture and horn button details only.
<Door_Glide_Cam>: attribute_transfer - transfer doorway tracking trajectory and speed only; ignore original environment.
<Jonathan_Gravelly>: reference - preserve gravelly vocal timbre and natural resonance; do not replicate source words.

detailed_description:
Live-action, 35mm anamorphic lens, deep dusk shadow outside with warm amber light spilling from within. [Shot 1] A medium-wide shot opens inside <Subject 1> looking toward the solid timber door. The heavy door unlatches and swings slowly inward as <Subject 2> (S1) steps across the threshold, cold mist billowing around his boots, mirroring the forward tracking momentum of <Door_Glide_Cam>. The camera tracks forward at eye level with moderate amplitude at slow speed. At 00:03.500, <Subject 2> (S1) pauses in the doorway, casts his eyes across the empty foyer, and calls out: "[English] Anyone still here?" [Shot 2] At 00:07.000, the camera cuts to a medium over-the-shoulder shot framing <Subject 2> as he pushes the door shut behind him, pausing motion until 00:09.000.

overall_soundscape:
Heavy wooden door creaking slowly open on iron hinges, damp boots scuffing over rough stone flooring, faint wind dying down as the door shuts, a muffled latch engagement, and resonant indoor speech for (S1).

non_diegetic_music:
A quiet, bowed double-bass drone swells gently at 00:03.500 underneath the spoken dialogue, holding a low tense tone until the clip finishes.

# SEGMENT 3
## SETTINGS
title: Rekindling the Hearth
duration: 8
seed: 64109823415
cfg: 6.0

## REFERENCES
# Only differences from HEADER are saved here:
Cabin_Exterior: false
Cabin_Foyer: @3
Hearth_Embers: true
Fire_Poker_Macro: true
Step_Climb_Cam: false
Crane_Tilt_Cam: @1

## PROMPT
subject_definitions:
<Subject 1> is the stone fireplace hearth shown in <Cabin_Foyer>.
<Subject 2> is the bearded man in his 40s from <Jonathan_Portrait>, wearing the olive wool coat from <Jonathan_Coat>.
<Subject 3> is the glowing ember bed shown in <Hearth_Embers>.
<Subject 4> is the blackened iron fire poker shown in <Fire_Poker_Macro>.
<Crane_Tilt_Cam> is a slow downward crane shot moving toward a low hearth.
<Jonathan_Gravelly> is a low, gravelly male voice recording.

summary:
[reference generation + audio reference] At <Subject 1>, <Subject 2> kneels beside the stone hearth following the camera arc of <Crane_Tilt_Cam> and speaks with the vocal timbre of <Jonathan_Gravelly>.

retention_analysis:
<Subject 1>: fully_preserved - lock cobblestone fireplace shape, iron grate, and hearth dimensions from <Cabin_Foyer>.
<Subject 2>: fully_preserved - preserve facial identity from <Jonathan_Portrait> and olive coat appearance from <Jonathan_Coat>.
<Jonathan_Coat> (never a video frame): attribute_transfer - transfer fabric drape and coat texture only.
<Subject 3> (never a video frame): fully_preserved - retain glowing ember texture and heat coloration from <Hearth_Embers>.
<Subject 4> (never a video frame): fully_preserved - lock forged iron poker geometry from <Fire_Poker_Macro>.
<Crane_Tilt_Cam>: attribute_transfer - transfer downward crane angle and smooth deceleration; ignore source subjects.
<Jonathan_Gravelly>: reference - match low vocal timbre and close acoustic dryness; do not copy original speech.

detailed_description:
Live-action, 50mm prime lens, moody firelight illumination with soft golden rim light across stone masonry. [Shot 1] A medium shot opens on <Subject 1>. <Subject 2> (S1) walks forward into the warm light, drops to one knee beside the hearth, and picks up <Subject 4>, matching the descent timing from <Crane_Tilt_Cam>. The camera tilts downward with small amplitude at slow speed. At 00:02.000, <Subject 2> (S1) stirs <Subject 3>, sending a shower of faint orange sparks into the chimney flue, and murmurs quietly: "[English] We have time." [Shot 2] At 00:05.500, the camera cuts to a close profile shot of <Subject 2> watching the rising flame, amber glow flickering across his bearded face, holding a steady gaze until 00:07.000.

overall_soundscape:
Hearth embers softly hissing and crackling, iron poker clinking against cobblestone masonry, heavy wool coat shifting as knees touch stone, and intimate close-mic spoken dialogue for (S1).

non_diegetic_music:
A sparse, delicate acoustic guitar chord rings out softly at 00:05.500, lingering into warm natural decay until the clip ends.

