# Atlas Animator editor

## Run

A skeletal 2D animation editor: pose and key clips on a rig in the browser, rendered through the PixiJS renderer (`@atlas-animator/core/pixi`).
Quick start and data folders are in the top-level README; this page is the feature reference.

```sh
pnpm install
pnpm dev        # http://127.0.0.1:5211/
```

Options after `--`: `--sandbox` (throwaway data inside the checkout), `--port 5300`, `--data-dir <absolute folder>`, `--publish-dir <absolute folder>`.
Environment variables: `ATLAS_EDITOR_DATA_DIR` (data folder), `ATLAS_EDITOR_PUBLISH_DIR` (turns Publish on), `ATLAS_EDITOR_USER_DATA=1` (use the default user data folder when running vite directly).

Export: the **Export Spine** button in Ship writes a JSON skeleton readable by Spine-compatible runtimes (Spine is a trademark of Esoteric Software; this project is
unaffiliated), **Download** saves the clip or rig, and **Publish** copies a rig or clip into your project folder (when one is set).

Checks: `pnpm typecheck`, `pnpm test`, `pnpm build`. Rig art under `packages/animator/rigs` is released under CC BY 4.0 (see `LICENSE-ASSETS.md`).

## What it opens

- Rigs (`src/fixtures.ts`): the canonical stock player rig, `packages/animator/rigs/player/` (tank top, black pants):
  **Turned L** (the live walk / gather rig), **Turned R** (its mirrored twin) and **Front** (the straight idle rig).
  They share bones, bone ranges and IK; the buttons swap the document and atlas and keep the clip you are editing.
- Clips: the rig's own clips (`walk_in_place`, `idle_weight_shift`, `fk_ik_fk`, `arm_raise`, `flex`, `diag`,
  `sweep`); **Import fixtures/clips** turns `emote-bling.json` into rotate keys (procedural channels such as
  `knee`, `lift_*`, `chest.scaleX` are skipped and listed). `walk-front-chibi.json` is a set of walk
  parameters, not keys: its bake is the rig clip `walk_in_place`. **New** makes an empty 1 s loop.
- Saved clips from `<dataDir>/clips/`.

## Using it

| Do | How |
| --- | --- |
| Select a bone | click it in the list or on the canvas |
| Rotate | drag the bone, or drag inside the ring around the selected bone; the blue arc is its declared range; on a looping clip the angle clamps there and the limit flashes red, on any other clip it goes past with a warning |
| Type an angle | Rotate field in the detail pane (degrees from setup) |
| Key | Auto key (on) keys on release; **Set key** / `K` keys the selected bone at the playhead |
| Delete keys | **Delete key** / `Delete` removes the selected bone's keys at the playhead |
| Copy / paste a pose | **Copy pose** (`Ctrl+C`) / **Paste pose** (`Ctrl+V`, keys every bone that is animated or off setup) |
| Scrub | drag in the timeline; `Left` / `Right` step frames, `Home` / `End` |
| Play | **Play** or a Space tap; **30 fps held** shows held frames as the runtime draws them |
| Loop, length | **Loop** toggle, **Length** in seconds (snapped to frames; keys past the end are removed) |
| View | wheel zooms at the cursor, right/middle drag or Space + drag pans, **Fit** / `F`, background swatches, **Bones** overlay |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Save | **Save** / `Ctrl+S` writes `<dataDir>/clips/<clip>.clip.json`; **Export** downloads it |

Unkeyed gizmo changes (Auto key off) are dropped when the playhead moves.

## Layout: tabs, tooltips, status bar

- The right panel is tabbed: **Pose** (bone numbers, hand IK, compensate), **Keys** (curves and easing presets, events, arc, root and foot lock, smear), **Rig** (setup-mode tools and constraints, slots and draw order), **Skins**, **Preview** (layered preview, game-size preview, silhouette, onion skin, underlay), **Library** (pose library, copy and paste pose) and **Export** (save, export, apply, render, live gates). The last tab is remembered. Setup mode opens Rig and hides the other tabs. Panels keep their ids, so `#curvepanel` and friends are unchanged; `atlasEditor.showTab(id)` and `atlasEditor.reveal(selector)` open a tab from a script.
- Every button and field has a tooltip: a short description plus its hotkey, e.g. "Rotate: drag a bone to rotate it (R)". The table is `src/tooltips.ts`; the key text is looked up in `src/hotkeys.ts`, the table the ? cheat sheet is drawn from (the sheet also lists the tabs and the buttons), so they cannot drift. A control the table does not name (the panels build many of their own) gets its own title or one derived from its label. Add a line to `TIPS` to give a new control a hotkey in its tip.
- The status bar (bottom) shows the tool (and Compensate / Auto key when on), the selected bone(s), the clip, frame and time, and the save state (Saved, Unsaved, Autosaving; click Unsaved to save). The autosave feature reports itself through `atlasEditor.setAutosaving(true | false)`.
- Demo scripts call `revealTabs(page)` (scripts/tab-reveal.mjs) so a selector-based click or fill opens the tab that holds the control first.

## Clip file

A `.clip.json` is exactly one `atlas-anim@1` clip (`clipSchema` in `packages/animator/src/core/format.ts`,
one entry of a document's `animations`), with schema defaults left out. Paste it under a document's
`animations.<name>`, or apply it as `clip.add` + `key.set` commands. Loading then saving any clip of
the committed rigs gives the same clip (test `src/clipModel.test.ts`).

## Clean up keys

The **Clean up keys** panel (right pane) removes keys the runtime would reproduce from their neighbours (`src/keyReduce.ts`).
A key goes when the shortened track samples within a tolerance of the original at every key time and every frame of the clip's
fps, through the same curves (so eased and stepped keys are only removed when the poses stay the same). Tolerances are per channel
(rotate / shear in degrees, move in px, scale as a factor, IK mix); scope is the selected bones or the whole clip (IK constraints are
reduced only in the whole-clip scope). The first and last key of every track, event keys, slot attachment (swap) keys and draw-order
keys are never removed; slot colour, transform, physics and deform timelines are not touched. The panel shows the count before
**Remove N keys**, which is one undo step. Scripted: `atlasEditor.reduceKeys(options)` (preview, nothing changes),
`atlasEditor.applyReduceKeys(options)`, `atlasEditor.reducePanel`, with `options = { tolerances?, bones? }`.

## Facing right

The runtime draws and animates one facing, the left-facing turned view, and shows the right side as that same view mirrored.
**Preview facing right** (toolbar over the canvas) flips the whole character at its root (`scale.x = -1`), look-only (the bone
overlay is hidden and editing is paused until it is switched off). The **Facing right (mirror check)** section of Live gates lists what
breaks when mirrored (`src/facing.ts` `mirrorGates`, always warnings): bones that do not land on the mirror image of their pose
(posed through the runtime with the root flipped: IK bends, inherit modes that refuse a reflection), side pieces with no twin or a
different size, and weapon-hand assumptions (a weapon bone under a side hand). Pixel-level asymmetry (a logo, a scar) is not visible
to the check: use the toggle. Scripted: `atlasEditor.setFacing("left" | "right")`, `facing()`, `mirrorCheck()`.

Runtime contract for the render path and the Spine export (`exportSpine.ts`): facing right is the left-facing rig with its root
flipped, never a separate clip or a mirrored rig. In Pixi set `scale.x = -1` on the container holding the character
(`applyFacing(root, "right")`); in a Spine runtime set `skeleton.scaleX = -1` (`spineFacing("right")`). Clips, rig and atlas are
shared and untouched, and anything placed in screen space from the character (trails, hit effects) multiplies its x offset by
`facingSign(facing)`. The export writes the left-facing skeleton only.

Demo screenshots: `node packages/animator-editor/scripts/demo-reduce.mjs [outDir] [url]` (writes
`docs/plans/atlas-animator-demos/editor/reduce/`).

## Live gates

The right pane checks the pose under the playhead after every change (unkeyed edits as if keyed):
clip format and references (`clipSchema`, `findReferenceIssues`; always blocking), the user pose rules
(`src/poseRules.ts`: no arm behind the head, no upper arm thrown straight back, no limb stretch past 3%, head
scale within 3%) and the per-bone ranges. The pose rules and bone ranges are errors on a looping clip and
warnings on any other clip (combat swings), and the gizmo only clamps to a bone range on a loop. **Check clip** runs the same over every sample time of the clip; click a finding to jump.

## Files

`src/clipModel.ts` clip edits and writer (pure) · `src/channelImport.ts` fixtures import ·
`src/gates.ts` live gates · `src/poseRules.ts` pose rules · `src/fixtures.ts` rig and clip paths · `src/main.ts` UI · `vite.config.ts`
dev server (`/repo/*` read-only files, `/api/clips` save).

## Editor items 2 to 10 (plan section 7)

Slot rows (attachment swaps, draw order), per-key easing curves, the dopesheet (select, drag, box select, scale,
copy range, play range), your project-size preview (0.4 and 0.471, reference video or strip), the Move gizmo, onion skin
and the reference underlay, event markers (hit locked to the attack profile contact frame), Apply to rig / Render
sheets through the CLI, and Hand IK with a two-hand grip. Every action is on `window.atlasEditor`
(see the end of `src/main.ts`); `scripts/demo-items.mjs [slots|curves|dopesheet|preview|move|onion|events|apply|ik|all]`
drives each one with Playwright and writes screenshots to `docs/plans/atlas-animator-demos/editor/items/`
(`apply` rewrites a rig file and restores it afterwards).

## Animation helpers (rig brief 5.4 and 7)

Seven helpers for posing attacks, all on `window.atlasEditor`; `scripts/demo-helpers.mjs [arc|easing|draworder|poses|silhouette|footlock|smear|all]`
drives each one with Playwright (screenshots in `docs/plans/atlas-animator-demos/editor/helpers/`). They run on the **Turned L + axe**
outfit: the stock rig plus an in-memory stand-in weapon (`src/standInWeapon.ts`: `weapon` bone on `hand_r`, an axe region, `weapon_tip` and
`weapon_grip` point slots) until the real weapon bone lands. Apply to rig refuses clips that key the stand-in.

| Helper | Where | API |
| --- | --- | --- |
| Arc overlay: a fist, the weapon tip or any bone across the clip, one dot per frame (blue slow, red fast), stats for bulge and uneven spacing | Arc overlay panel (`src/arcModel.ts`) | `setArc("point:weapon_tip" \| "tip:hand_r" \| "bone:x" \| null)`, `arcInfo()` |
| Easing presets: anticipation hold, fast strike, overshoot then settle, damped settle (writes two extra keys) on the selected keys | Curve panel (`src/easingModel.ts`) | `applyEasing(id, [{ bone, frame }]?)` |
| Draw-order presets `arm_r_front`, `arm_l_behind`, `weapon_behind`, `cape_over_arms` keyed in one click, resolved by slot group against the rig | Slot panel (`src/drawOrderPresets.ts`) | `setDrawPreset(id \| "setup", frame?)`, `drawPresets()`, `drawOrderState()`, `slotOrder()` |
| Pose library: bones, attachment swaps and draw order, saved to `<dataDir>/poses/` with a 0.4 thumbnail, applied to any clip or rig (unknown bones and slots are skipped and reported) | Pose library panel (`src/poseModel.ts`) | `savePose(name)`, `applyPose(name, { frame, bones, attachments, order, only })`, `poses()`, `deletePose(name)` |
| Silhouette: flat black on a light ground, main view and game-size preview | Silhouette button (`src/silhouetteModel.ts`) | `setSilhouette(on?)`, `silhouetteReport()` |
| Root and foot lock: pins a foot across a frame range (leg IK mix keyed, target held on the spot), or holds the root | Root and foot lock panel (`src/footLockModel.ts`) | `lockFoot(side, a, b)`, `unlockFoot`, `lockRoot(a, b)`, `footDrift(side, a, b)`, `footLocks()` |
| Smear: the weapon at sub-steps spread evenly along the tip's arc (6, more on a long arc), unioned, stretched 15% along the arc, inked with the stock outline (`3a1001`, 10 px), written as `weapon__smear_<v>` and keyed on one frame; weapon slots only, trims no body stroke | Smear panel (`src/smearModel.ts`) | `makeSmear({ from, to, show, variant })`, `smearInfo()`; files in `<dataDir>/smears/` |

Stepped keys (attachment swaps, IK flags, draw order) are written with 5 decimals; the runtime counts them as reached within `KEY_TIME_EPSILON` (1e-4 s, `packages/animator/src/core/timelines.ts`), so a swap on frame N shows when sampled at N / fps in the editor, the render CLI and your project.

## Graph editor

**Graph** (button in the Keys row, or `G`) opens a value-over-time panel beside the dopesheet for the selected bone and the bones of the selected keys:
one curve per channel (Rotate, Move X / Y, Scale X / Y, Shear X / Y), keys as diamonds (linear), circles (bezier) and squares (stepped). The dopesheet and the graph share the
clip, the key selection, the playhead and the undo stack, so a key picked or moved in one is picked or moved in the other.

| Do | How |
| --- | --- |
| Pick keys | click a key (shift adds); the playhead and bone follow |
| Move a key | drag: time snaps to frames (every selected key moves), value follows the pointer; shift locks to one axis |
| Bezier handles | **Bezier** on the selected keys shows the handles of their segments; drag a handle (x stays inside the span, y may overshoot); **Linear** / **Stepped** switch back |
| Type a value | the field after the key buttons edits the last clicked key's value |
| Filter | channel chips show or hide a curve; **All** shows every channel |
| View | wheel zooms time at the cursor (shift: value, alt: both), right / middle drag pans, **Frame all** (or double-click) fits every shown curve (overshoot included), **Frame keys** fits the selected keys, **+ / -** zoom, click the ruler to scrub |

Per-channel curves need no format change: `atlas-anim@1` already lets a key's `curve` be one spec or an object per channel (`{ x, y }`, missing = linear). Easing one channel of a
vector key writes that object and collapses it back to a single spec when both channels match, so existing files read and save unchanged (`src/graphModel.ts`, test `src/graphModel.test.ts`).
`window.atlasEditor`: `graphOpen`, `graphChannels`, `graphFrameAll`, `graphFrameKeys`, `graphZoom`, `graphView`, `graphState`, `graphPoint`, `graphSetValue`, `graphSelect`, `graphInterp`;
`scripts/demo-graph.mjs` drives it with Playwright and writes `docs/plans/atlas-animator-demos/editor/graph/graph-editor.png`.

## Setup mode (rig building)

The **Mode** switch in the header toggles Animate / Setup. Setup shows the rig in its setup pose and edits the rig, not a clip.
Tools (HUD, keys V B T A): **Select**, **Create bone** (click-drag from the selected parent; Shift starts at its tip),
**Transform** (drag a bone's start, tip, or ring; "keep images" leaves children and images in place), **Image** (move / rotate /
scale the selected slot's image). The bone tree re-parents by drag (world position kept); Delete removes a bone and moves its
children, slots and images up. The right panel edits name, parent, setup transform, colour, helper flag, slots and default
images, attaches atlas images or imported PNGs, and lists IK / transform constraints (target, mix, bend, softness, offsets) with
**Add 2-bone IK** (mix 0, so clips keep their pose). Every edit is a command batch (`src/setupModel.ts`, `setupAttach.ts`,
`setupConstraints.ts`) on an undo stack (Ctrl+Z / Ctrl+Y); **Save rig** (Ctrl+S) writes the batches through the rig's command log
(`src/rigSave.ts`, `/api/rig/save`). Bone `color` and `helper` are optional editor-only bone fields.
Demo: `node packages/animator-editor/scripts/setup-demo.mjs` (writes `docs/plans/atlas-animator-demos/editor/setup/`, saves nothing).

## Hand IK: bake or live

The Hand IK tool has two modes (the **Keep IK live** checkbox in its panel, `atlasEditor.setIkLive(on)`):

- **Bake to FK** (default): dragging a fist solves the arm and writes plain rotate keys on the upper arm and forearm.
- **Live** : the rig's `hand_ik_<side>` constraint stays on. The first drag keys its mix to 1 at that frame (0 at the clip start, so earlier frames stay FK)
  and keys the `hand_<side>_target` bone where the hand stands; later drags move and key that target. In-betweens move the hand smoothly between target keys
  (`src/handIkLive.ts`). Needs a rig with hand IK constraints (the pro kit rigs); other rigs fall back to baking. `scripts/demo-hand-ik-live.mjs` checks both modes.

## Mirror pose and Breakdown

Both key the result at the playhead in one undo step, and both are on `window.atlasEditor` (`mirrorSelection({ limb?, from? })`, `mirrorLimb("arm" | "leg", "near" | "far")`, `flipPose()`, `mirrorPartners()`, `breakdown(percent?)`). Demo with checks and screenshots: `scripts/demo-mirror-breakdown.mjs` (output in `docs/plans/atlas-animator-demos/editor/mirror-breakdown/`).

- **Mirror selection (M)** copies the selected bones onto their partner on the other side (the side of the active bone is the source); "whole limb" brings everything below them. Spine, neck, head, hair and body bones mirror in place. **Flip pose (Shift+M)** swaps near and far for every bone and mirrors those centre bones. **Arm / Leg near to far, far to near** copy a whole limb with its IK target (and the IK mix when it differs).
- Bones pair by one side token in the name: `_near` / `_far`, `_l` / `_r`, also in the middle (`hand_near_target`, `hair_far_1`). A key holds an offset from setup, so the mirror places the partner where the source's total local transform (setup + offset) reflects over the character's vertical axis, and keys the difference from the partner's own setup (near clavicle -105.8 against far +105.8 and so on). A source at rest writes no key. Bones the pose cannot show (an IK chain that is on, a foot a plant constraint takes over) are left out; the IK target carries the pose. Held weapon bones have no partner and stay put. Details: `src/mirrorModel.ts`.
- **Breakdown (N, free key; B is the bone overlay)**: the slider (-50 to 150 %, 0 = previous key, 100 = next key, outside overshoots) and the buttons 0, 25, 33, 50, 66, 75, 100 key the selected bones at the playhead between their previous and next keys, per channel (rotate, translate, scale, shear). A key already on the playhead is not a neighbour, so repeats and slider drags are idempotent and a whole drag is one undo step; on a looping clip the neighbours wrap. N applies the slider's current value. Details: `src/breakdownModel.ts`.

## Integration notes

- **S** selects the Scale gizmo (`data-mode="scale"`), **G** the graph; both are in the `?` cheat sheet.
- Track preview mask presets (upper / lower / arms) match the pro rig (`thigh_near`, `upper_arm_near`, `clavicle_*`, `chest`) as well as the old `_l` / `_r` names.
- Skin edits (create, rename, wear-independent attachments, hides, setup placeholders) are written to the open rig document by **Save** and **Apply** (`POST /api/skins`, `mergeSkinsIntoRigText`), so they survive a reload. Setup mode's Save rig refetches the file hash afterwards.
- `demo-items.mjs` and `demo-helpers.mjs` key the old template bones (`hand_l`, `upper_arm_l`): they pin the old-rig outfit (`turned-l`) first; the default is the pro rig.

## Game view

**Game view** (button, or `V`) plays the clip as the runtime draws it, in a panel over the viewport (`src/gameView.ts`, pure parts and
tests in `src/gameViewModel.ts`). The character is the `AnimatorCharacter`, rendered into textures at the preview's
render resolution (`src/preview/renderQuality.ts`: full DPR, 2x to 3x; Low quality follows the preview's flag) at 0.4, 0.471
and a 1x close-up (each size can be switched off), on a ground colour (grass, dirt, sand, snow, stone) with a shadow under the feet.

- **Clock.** It plays on its own clock: Loop repeats the clip after a short rest, off plays once and holds the last frame; Replay
  restarts. Paused, it follows the editor's playhead. It redraws when you edit the clip, switch clip or rig.
- **Events drive it.** `trailOn` .. `trailOff` draw the slash trail along the weapon tip (the `weapon_tip` bone or point slot, else the weapon
  bone's end, else the hand), fading like the preview's slash arc (`swingEffects.ts`). On `hit` the preview's own hit-stop
  (`SwingEffectsState`: the attacker's sampling freezes `HIT_TUNING.swing.holdMs`, then catches up) holds the pose, and the training post
  at weapon range (on the side the weapon reaches) gets the preview's white flash, red tint, push and impact spark (`hitFeedback.ts`).
- **Walk under** plays `walk_in_place` (or any other clip with "walk" in its name) on the legs and body and the edited clip on the torso,
  arms, hand targets and weapon. **Mirror** faces the other way. **Target** and **Trail** can be turned off.
- Phone-size cells are as tall as the figure at that scale and widen when the swing reaches further than a phone is wide; the 1x cell is a
  520 x 620 close-up on the contact point.

`window.atlasEditor`: `gameView(open?)`, `gameViewOptions({ scales, loop, walkUnder, mirror, dummy, trail, ground })`, `gameViewPlay(on?)`,
`gameViewReplay()`, `gameViewSeek(seconds)` (restarts the cycle, steps your project clock in 1/60 s to that time, pauses there) and
`gameViewInfo()` (what it drew: hit-stop, flash, trail points, tip, target, events fired). `scripts/demo-gameview.mjs` drives it on
the "Side (pro)" rig and writes screenshots to `docs/plans/atlas-animator-demos/editor/gameview/`.

## Autosave, History and built-in poses

- **Autosave**: every 60 s and on a clip switch, the working clip and any unsaved skin or Setup edits are written to
  `<dataDir>/autosave/<clip>/<timestamp>.<flags>.<outfit>.json` (newest 30 per clip, nothing
  is written when nothing changed). Requests are asynchronous; the UI never waits for them.
- **Crash recovery**: at startup, an autosave newer than the saved clip file (or rig document) shows a **Restore** bar.
  Restore brings back the clip and the unsaved skin / Setup edits; **Dismiss** stops asking about those versions.
- **History panel**: lists the versions of the clip being edited; **Preview** shows one read-only (editing pauses),
  **Restore** makes it the working clip as one undo step (the state it replaces is autosaved first).
- **Built-in poses**: a pose file with `"builtin": true` is read-only (the server refuses to overwrite or delete it) and is listed first with a badge. None ship; the user's own poses can be marked built-in later (optionally with `"rig": "<outfit id>"` to show only on that rig).
- `window.atlasEditor`: `autosaveNow`, `autosaveInfo`, `setAutosaveInterval`, `autosaveVersions`, `previewVersion`,
  `exitPreview`, `previewing`, `restoreVersion`, `offerRestore`, `capturePose`; `poses()` also reports `builtin` / `rig`.
- Demo: `node scripts/demo-autosave.mjs` (dev server on a free port).

## Phone preview

Press **Phone preview** in the header (opt-in; off until pressed), scan the QR code with the phone camera (same Wi-Fi as the PC), and the phone plays the clip being edited at game size, updating within about a second. Tap the ground to pause; the bar has a facing toggle and a 0.4 / 0.471 scale toggle. It starts a second read-only server on the LAN (default port 5290, a free one if taken) guarded by a random token in the URL; Vite itself stays on 127.0.0.1. Windows may ask once to allow Node.js on private networks. Stop (in the popover) closes it. `ATLAS_PHONE_HOST` / `ATLAS_PHONE_PORT` override the bind address and port. Demo: `node packages/animator-editor/scripts/demo-phonelive.mjs`.
