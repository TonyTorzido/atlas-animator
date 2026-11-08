# Atlas Animator: CLI and command reference

Original 2D skeletal animation system, written from scratch. A rig is one JSON document, `<name>.anim.json` (`atlas-anim@1`),
plus an atlas (`<name>.atlas.json` + page PNGs). Canvas pixels, y down; angles in degrees,
clockwise positive; times in seconds.

Run the CLI from the repo root: `pnpm --filter @atlas-animator/core animator <command> ...`
(or `npx tsx packages/animator/src/cli/animator.ts ...`). Paths are relative to
`packages/animator` with pnpm, so prefer absolute paths. Exit codes: 0 ok, 1 failed or
rejected, 2 usage.

## The rule: every edit is a command

Edits are JSON commands (`{"op": "bone.set", "name": "chest", "rotation": 5}`). Each batch is
checked (a command that adds a format or reference error is rejected with the reason and nothing
is written), turned into an RFC 6902 patch plus its exact inverse, appended to
`<name>.anim.log.ndjson`, then written. Undo/redo replay the logged inverses. Never hand-edit
the document while working through the CLI: an outside edit is recorded as an `external` entry
and undo stops there. Documents are written in canonical JSON (the first edit of a hand-formatted
file reformats it).

## Workflow

```sh
animator info rig.anim.json                 # names: bones (tree), slots, skins, constraints, clips + key times
animator ops [family.] [--json]             # the vocabulary below, with an example per command
animator apply rig.anim.json '{"op":"clip.add","name":"idle","duration":2.4,"loop":true}' '{...}'
animator apply-script rig.anim.json idle.jsonl --check end [--limits reject] [--dry-run]   # the fast path
animator validate rig.anim.json [--outfits tunic+cape]  # format, weights, limits, budgets, clipping, tears; body, body + each item, each declared combination
animator render rig.anim.json --clip idle --mp4 idle.mp4 --sheet idle.png
animator diff rig.anim.json --git HEAD      # what changed, in rig terms
animator undo rig.anim.json [--steps N]     # redo likewise; log shows history
```

- `apply` takes one or more commands (or one JSON array). `apply-script` takes JSON Lines (one
  command per line; `#` and `//` lines are comments) or a JSON array. A batch is atomic and is
  one undo step. `--dry-run` prints the patch without writing. `--check end` validates once at
  the end instead of after each command (for scripts that pass through invalid states).
- **Pose limits are live** (). Key commands (`key.*`, `clip.duration`, `clip.copy`) are
  checked against the document's `poseLimits`: the keyed pose and the in-betweens, sampled through
  the runtime (key times and 8 steps between, so curves, IK and constraints count). A command is
  blamed only for poses it moved outside. `--limits warn` (CLI default) applies and prints
  `warning [limits] command 9 (key.set forearm_l rotate t 0.45s): clip 'swing': the keyed pose and
  10 in-between poses outside pose limit 'hand_head_raise_elbow' (...); nearest legal pose:
  upper_arm_l 80.8, forearm_l 48.7`; `--limits reject` refuses that command (nothing written, exit 1);
  `--limits off` skips the check. The nearest legal pose is the drivers projected onto the limit
  polygons: key those values (offsets from setup) to fix it.
- **Fast path for scripts: `apply-script <doc> <script> --check end --limits reject`.** Format and
  pose limits are checked once, on the whole clip, at the end. A format error still refuses the
  batch; a pose-limit failure keeps it (written and logged, nothing reverted) and exits 1 with the
  findings, so fix forward with more `key.set` commands or `undo`. Run `validate` before rendering.
- `new <doc> --name <n> --size WxH [--origin X,Y]` creates an empty rig (root bone only).
- `log <doc> [--last N] [--json]` prints entries; `watch <doc>` prints them as they land.
- `rig <figure.png> --name <rig> --out <dir> [--review <dir>]` auto-rigs the humanoid template.
- `atlas split <in.png> --line X1,Y1,X2,Y2 --seed X,Y --out <rest.png> --part <part.png> [--overlap 14]`
  cuts an appendage (a tail) off along a line, original pixels only (approved for appendages;
  no AI fill): import the part first (it draws behind), trace it with a finer `--spacing`, then
  `weights.seam {skin, slot, name, bone, line: [[x1, y1], [x2, y2]], hard?, soft?}` on both meshes
  with the bone they hang from, so the seam stays shut.
- `atlas trim <in.png> <out.png> [--pad 16]` crops a source PNG to its opaque bounds plus a pad and
  prints the `--size` to give `new`; `atlas import` then packs it.
- `bone add <doc> <name> [--parent P] --world X,Y [--tip X,Y] [--limits MIN,MAX]` is `bone.add` from
  canvas points without JSON (no shell quoting; Windows PowerShell 5.1 strips quotes from inline JSON).
- `rest-fidelity <doc> <source.png> [--out <prefix>] [--controls]`: the setup pose rendered 1:1 against
  the source art (coverage, colour on three backdrops, ink, failing clusters); writes
  `<prefix>.json`, `-heatmap.png`, `-side.png` (default prefix `rest-fidelity` next to the doc); exit 1 on fail.
- `outline trace` / `mesh.generate` note when the vertex target simplified the outline to a coarser
  hull (and how far the hull stands off it); render `--sheet` tiles are exactly the `--size` frame.
- `weights.auto` assigns each vertex to the nearest bone **along the mesh** (a straight line to a
  bone counts only when it stays inside the mesh), so a curled tail or an arm across a gap does not
  take vertices it reaches only across empty space.

## Render

`animator render <doc> [options]`, through your project's Pixi renderer in headless Chromium with
SwiftShader (no GPU or display needed; ffmpeg on PATH or `ANIMATOR_FFMPEG` for MP4/GIF).

| Option | Meaning (default) |
|---|---|
| `--clip C` | clip on track 0 (setup pose) |
| `--skins a,b` | active skins (the document's first skin, normally the body; list swag skins explicitly, e.g. `body,tunic`) |
| `--fps N` | frames per second (30); each frame is a fixed 1/fps step, so renders are deterministic |
| `--frames N` | frame count (one loop of a looping clip, duration + 1 frame otherwise) |
| `--scale S` | output pixels per canvas pixel (0.5) |
| `--size WxH`, `--origin X,Y` | output size and where the skeleton origin lands (canvas x scale) |
| `--background RRGGBB\|transparent` | background (1e2430) |
| `--warmup S` | physics warm-up seconds before frame 0 (1 when the rig has physics) |
| `--atlas F` | atlas manifest (`<rig>.atlas.json` beside the document) |
| `--png F`, `--png-dir D` | first frame / every frame as PNG |
| `--mp4 F`, `--gif F` | H.264 MP4 (yuv420p, even-padded), GIF (palettegen + paletteuse) |
| `--sheet F` `[--sheet-count 8] [--sheet-columns 4]` | contact sheet of evenly spaced frames, labelled clip + time |

## Value rules (what the numbers mean)

- Bones: `bone.add` / `bone.set` `x, y` are in the parent bone's frame (the root's: skeleton
  space, origin at `canvas.originX/Y`); `rotation` is local, degrees clockwise; `limits` are
  relative to the setup rotation.
- Keys are relative to the setup pose: `rotate` `value` and `translate` / `shear` `x, y` are
  offsets added to the bone's setup values (0 = setup); `scale` `x, y` multiply the setup scale
  (1 = setup). Slot `color` keys are absolute colours (`rrggbbaa`). Attachment keys name a
  placeholder (null hides the slot).
- Deform key `vertices` are offsets from the bind pose starting at float `offset`: 2 floats per
  vertex for an unweighted mesh, 2 per influence for a weighted one.
- Mesh `vertices` are bind positions: unweighted, `x, y` per vertex in the slot bone's space;
  weighted (with `bones`), per vertex `n` then n groups of `(boneIndex, x, y, weight)` with
  `boneIndex` into the mesh's own `bones` table and `x, y` in that bone's space. Prefer
  `attachment.move-vertices` and `weights.*`, which keep this encoding consistent.
- `attachment.move-vertices` `dx, dy` are canvas pixels at the setup pose.

## Command vocabulary

Names: letters, digits, `_ - .`. Times snap to 1e-6 s; keys at the same time are the same key.
A mesh is addressed by `skin`, `slot`, `name` (its placeholder). `animator ops` prints the same
list with examples.

**doc**: `doc.new {name, width, height, originX?, originY?}` replaces the document with an empty
rig; `doc.set {name?, revision?, canvas?: {width?, height?, originX?, originY?}, atlas?: {pages, scale}|null}`.

**bone**: `bone.add {name, parent?, x?, y?, rotation?, scaleX?, scaleY?, shearX?, shearY?, length?, inherit?, limits?: {min, max}, skin?, world?: [x, y], tip?: [x, y]}`
(kept parents-first; `world` is the bone's start as a canvas point and `tip` its end, converted to
parent-local `x, y` and `rotation, length`; not combined with those fields); `bone.remove {name}`
(no children, no references); `bone.set {name, ...fields}`, including `role: spine|limb|head|tail|other`
(the bone's semantic role for the rig-agnostic review poses and bend caps; set it when inference
guesses wrong, e.g. a spine that stops at the leg hub; `info` shows each bone's role, `*` = inferred);
`bone.parent {name, parent|null}` (local values kept); `bone.limits {name, min, max}` or `{name, clear: true}`;
`bone.rename {name, to}` (updates every reference).

**slot**: `slot.add {name, bone, attachment?, color?, blend?, drawAfter?, drawBefore?, before?|after?}`;
`slot.remove {name}`; `slot.set {name, bone?, color?, blend?, attachment?: name|null, drawAfter?: name|null, drawBefore?: name|null}`;
`slot.color {name, color: "rrggbbaa"}`; `slot.blend {name, blend: normal|additive}`;
`slot.order {name, before|after}` (setup draw order, back to front).

**skin**: `skin.add {name, hides?, bones?, constraints?}`; `skin.remove {name}`;
`skin.hide {name, hides: [slot]}`; `skin.bones {name, bones}`; `skin.constraints {name, constraints}`.

**attachment**: `attachment.add {skin, slot, name, attachment: {type: region|mesh|linkedMesh|point, ...}}`;
`attachment.set {skin, slot, name, fields: {...}}` (null removes a field; type cannot change);
`attachment.remove {skin, slot, name}`;
`attachment.move-vertices {skin, slot, name, vertices?: [i]|"all", dx, dy}` (canvas px at the setup pose; weights kept);
`attachment.set-uvs {skin, slot, name, uvs}`.

**mesh**: `mesh.set {skin, slot, name, uvs?, triangles?, vertices?, bones?, hull?, edges?}`;
`mesh.triangles {..., triangles}`; `mesh.hull {..., hull}`;
`mesh.groups {..., groups: {slot: [[start, end], ...]} | null}` (draw groups, see below).
`mesh.generate {..., outline?: {outer: [[x, y], ...], holes?}, targetVertices?, spacing?, bridgeNotches?}`
builds the mesh (auto-mesh lattice + constrained triangulation) from an outline in the
attachment's image pixels (canvas scale, 0..width x 0..height), or from the mesh's current hull
when no outline is given; a region attachment becomes an unweighted mesh in place; a weighted
mesh keeps its weights (interpolated at the new vertices). The editor's "Outline from image"
traces the atlas image in the browser and sends the outline, so the log holds the geometry.

**weights** (bind positions are recomputed from the setup pose, so the mesh never moves):
`weights.bind {skin, slot, name, bone}` (unweighted -> rigid on one bone); `weights.unbind {...}`;
`weights.set {..., vertices: [i], influences: [{bone, weight}]}` (normalised, <= 4);
`weights.prune {..., max?: 4, min?: 0.02}`; `weights.smooth {..., iterations?: 1, vertices?}`.
`weights.assign {..., weights: [{vertex, influences: [{bone, weight}]}]}` (per-vertex lists in one
step; what a weight-paint stroke sends); `weights.auto {..., bones: [chain parent to child], radius?, heat?, smooth?}`
(heat weights from the setup bones; body radius per bone estimated from the hull);
`weights.weld {meshes: [{skin, slot, name}, ...], tolerance?: 0.5}` (coincident setup vertices of
different meshes get the same averaged weights, so seams bend together).

**constraint**: `constraint.add {kind: ik|transform|physics, constraint: {name, ...}}`;
`constraint.set {kind, name, fields}`; `constraint.remove {kind, name}`.

**driven** (corrections keyed to a bone angle, applied under every clip):
`driven.add {name, bone, skin?, keys?}`; `driven.remove {name}`;
`driven.key {name, at, deform?, drawOrder?, attachments?, alpha?}`; `driven.unkey {name, at}`.
Combination correctives (two-driver grids): `driven.grid {name, x: {bone, at: [...]}, y: {bone, at: [...]}, skin?, keys?}`
(adds or replaces; keys default to empty); `driven.grid-key {name, x, y, deform}` (x, y must be axis
`at` values; `{}` clears); `driven.grid-remove {name}`.

**contour** (dynamic outlines, see below): `contour.add {skin, slot, name, contour}` (`slot` is the
owner); `contour.trace {skin, slot, name, mesh: {slot, attachment, skin?}, points: [[x, y], ...], width, closed?, color?, caps?, visible?}`
(canvas points at the setup pose, each bound barycentrically to the mesh triangle under it);
`contour.set {skin, slot, name, fields}` (null removes a field); `contour.remove {skin, slot, name}`.

**coverage**: `coverage.region {skin, name, mesh: {slot, attachment}, triangles: [[start, end], ...]}`;
`coverage.remove-region {skin, name}`; `coverage.covers {skin, covers: [{skin, region}]}` (`[]` clears).

**event**: `event.add {name, int?, float?, string?}`; `event.set {...}`; `event.remove {name}`;
`event.key {clip, time, name, int?, float?, string?}`; `event.unkey {clip, time, name}`.

**clip**: `clip.add {name, duration, loop?}`; `clip.remove`; `clip.duration {name, duration}`;
`clip.loop {name, loop}`; `clip.rename {name, to}`; `clip.copy {name, to}`.

**key**: a timeline is addressed by exactly one of `bone` (+ `timeline`: rotate | translate |
scale | shear), `slot` (+ `timeline`: attachment | color), `ik`, `transform`, `physics`
(+ `timeline`: mix | reset), `deform: {skin, slot, attachment}`, `drawOrder: true`.
- `key.set {clip, <address>, time, ...fields, curve?}` inserts, or merges into the key at that
  time. Fields: rotate `value`; translate/scale/shear `x, y`; slot color `color`; slot
  attachment `name` (null hides); ik `mix, softness, bendPositive, stretch, compress`; transform
  `mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY`; physics mix `value`; deform
  `offset, vertices`; drawOrder `offsets: [{slot, offset}]`. Curve: `"linear"`, `"stepped"`,
  `[cx1, cy1, cx2, cy2]` (cx in 0..1), or per channel `{x: ..., y: ...}`.
- `key.delete {clip, <address>, time}`; `key.move {clip, <address>, time, to}`;
  `key.curve {clip, <address>, time, curve}`;
  `key.offset {clip, <address>?, by, from?, to?}` (no address = every timeline and event);
  `key.copy-range {clip, <address>?, from, to, at, toClip?}`.

**patch**: `patch {patch: [RFC 6902 ops]}`: raw add/remove/replace/move/copy/test on the
document, still checked and logged. Prefer named commands.

`state.*` commands are editor-only (console): `state.skins {skins}`, `state.select {bone?, slot?}`,
`state.mode {mode: bones|mesh|weights}` change the preview, never the document; playback is
Phase 7. Rendering and validation are CLI commands.

## Joint-ready body (Phase)

All optional in `atlas-anim@1` (older documents load unchanged):

- **Draw groups**: a mesh's `groups` maps slots to triangle ranges `[start, end)` (triangle
  numbers) that partition its triangles exactly. The mesh is skinned once per frame and each group
  draws at its slot's draw-order position with that slot's colour; boundary vertices, weights, UVs
  and correctives are shared by construction. The slot holding the mesh draws only its own group.
  Linked meshes of a grouped mesh draw whole. (The CPU software renderer behind `validate` and
  review sheets still draws the whole mesh at the user slot; the Pixi renderer is the reference.)
- **Contours**: `skins.<skin>.contours.<owner slot>.<name>`, a centreline bound to a mesh
  (`mesh` + `points`: vertex indices or `[a, b, c, wa, wb]` barycentric points) or to bones
  (`bones` + weighted `vertices`), with `width` (canvas px, full width), `color`, `closed`,
  `caps` (round | butt) and `visible` rules (`[{bone, min, max}]` on the driver angle, all must
  hold). Stroked after deformation with round joins and one coverage-ramp anti-aliasing (an atlas
  image), so the width stays constant under any bend; drawn as batched meshes just above the user
  slot; rebuilt only when an owner bone (mesh influences and corrective drivers) moved; skipped
  below `AnimatorCharacter.contourMinPixels` display pixels. Set `contourPixelScale` when the
  container's world transform is not the display scale. Rigid art keeps baked strokes; never
  stroke a group boundary.
- **Driven grids** (`drivenGrids`): deform keyed on two bones' driver values, row-major keys,
  at most 4 per axis and 12 in all, bilinear inside, held at the edges, evaluated with driven
  keys after IK, constraints and limits.
- **Coverage**: `skins.<skin>.coverage` = `regions` (named triangle ranges of one of the skin's
  meshes) and `covers` (regions of other skins it covers opaquely). Format only for now; the
  equipment-coverage gate that reads it is Phase.

## Example script (`breathe.jsonl`)

```jsonl
{"op":"clip.add","name":"breathe","duration":2.4,"loop":true}
{"op":"key.set","clip":"breathe","bone":"chest","timeline":"rotate","time":0,"value":0,"curve":[0.42,0,0.58,1]}
{"op":"key.set","clip":"breathe","bone":"chest","timeline":"rotate","time":1.2,"value":3,"curve":[0.42,0,0.58,1]}
{"op":"key.set","clip":"breathe","bone":"chest","timeline":"rotate","time":2.4,"value":0}
{"op":"key.set","clip":"breathe","bone":"hips","timeline":"translate","time":1.2,"x":0,"y":2}
```

## Library use

`@atlas-animator/core/commands` (`applyCommands`, `parseScript`, `describeCommands`; pure, usable
in the browser), `@atlas-animator/core/store` (file + log: `applyToFile`, `stepHistory`,
`openDocument`), `@atlas-animator/core/diff` (`diffDocuments`, `formatDiff`),
`@atlas-animator/core/atlas` (`importCanvasPart`, PNG encode/decode; node), `@atlas-animator/core/patch`
(RFC 6902 with inverses), `@atlas-animator/core/tools/outline` and `/tools/autoMesh` (pure).

## Continuous-surface builder

`pnpm animator surface <preset.json> --out <dir> [--demos <dir>] [--quick] [--calibrate-width <k>]`
builds one canonical skin surface (plus garment layers) from a preset in
`fixtures/canonical/*.preset.json`; the library code (`src/tools/surface/`) holds no template
values, so a humanoid shoulder and a creature hip differ only in their preset.

- Topology: rows across the limb chain (joint bands, rigid cores, authored extras). A notch apex
  (`topology.apexes`: armpit, groin, hip crease) is a hull vertex; rows that would reach the body
  side of the notch end at the apex as a fan (`fanAngle` apart), rows past it keep `minRowGap`
  along the inner silhouette, and a plain row that would cross an earlier row is dropped.
- Regions (pass 3a, `skin.regions`): joint patches per side (`inner`/`outer` at the chain root:
  a boundary chain on the hull from an apex or a point `toward` another, `extent` in arc length
  or `{ width: [lo, hi] }` of the local limb width W, searched from lo for the shortest transition
  whose rotation-blend target stays above the area floor at both limits; `both` hinge bands
  distally), rigid `cores` (chain s ranges) and `fixed` body polygons. Each region's bone list
  is a hard support mask applied after the weights are generated: a forbidden influence is
  exactly zero. Anchored apexes (`permittedApexMotion: 0`) and fixed regions are the base bone
  alone; the girdle's radial share fades to 0 over `girdle.feather` towards them.
- Root weights: harmonic with designed boundary values: the patch ramps along their boundary
  chains (`profile` linear or smooth), `root.zeros`, and the masks (no limb bone allowed: 0; no
  body bone allowed: 1). Hinge bands give the distal fractions.
- Draw groups: explicit region polygons (`skin.groups[].polygon`), the last containing polygon
  wins; the limb group is drawn over the torso garments.
- Junctions (`skin.junctions`): named posed points (a hull vertex of the skin or a garment);
  contour anchors may be `{ junction }`, `{ apex }`, a row end or a point. A skin contour must
  bound triangles of its owner group, and every contour end meets another or a junction.
- Garments with `embed: true`: every vertex on the skin (or within `embedMargin` past its edge)
  is stored as a barycentric point of the skin's bind triangle (mesh `embed` in the format) and
  posed from the posed skin triangle, bit for bit, correctives included. `conform: true` builds
  the garment from the skin triangulation clipped to its outline, so every garment triangle lies
  in one skin triangle; off-skin vertices ride skin groups drawn below the garment.
- Gates (`<preset>.gates.json`, with the plan's gate table split into geometric and raster rows,
  each tagged with the sub-pass that must turn it green): connectivity (one manifold surface per
  mesh bounded by its hull), weight support, fixed flank (rigid with its bone within 1e-3 px over
  every frame, apex motion within its permit), ownership (owner group, loose ends, doubled at
  rest), garment registration (embedded identity, conform containment, coverage), draw-group
  occlusion (`gates.occlusion` poses: skin drawn below a garment may not slide under it past the
  edge half width); and weights, group-boundary identity, signed area (min posed/bind
  ratio > 0.2 over every sweep frame), embedded bit identity, hidden coverage, doubled contours,
  temporal pops; with `--demos`, the coverage-aware 3x width gate (p99 <= 0.25 game px; out-of-frame
  and low-contrast samples skipped and counted; per-contour stats) with its calibration pair
  (as is must pass, every contour x1.5 must read p99 >= 0.4) and alpha gaps on every frame at DPR 1
  and 3. Demo sheets and MP4s come in two views, the joint crop (preset `frame`; game size 3x nearest
  and the true 3x at DPR 3) and the full figure (posed bounds + 20 canvas px), every tile tagged.
