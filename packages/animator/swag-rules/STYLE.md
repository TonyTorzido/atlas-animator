# Swag style sheet (Atlas Animator)

One section per template type. A template type decides which guide the artist gets, which rules the
prompt states and which checks run. **Simple**, **medium**, **hard plate** and **held item** are fully specified; the other two are
stubs (the section says what is still to decide). The art is always made from
the guide from `pnpm --filter @atlas-animator/core swag:template`; the checks are
`src/tools/swagChecks.ts` plus the importer gates (`src/cli/garmentImport.ts`).

## How the engine and the art split the work

The garment is built from the **body mesh** (`tools/garmentSurface.ts`). The engine makes the fit, the
outline and the shape; the artist supplies **paint**: colours, trim and details. So the art must
register with the body pixel for pixel (same canvas, same pose, same position and size), and it
may only use paint inside the allowed area the guide shows.

All swag art is one PNG: RGBA, exactly the rig canvas (1086 x 1448 for the template7 body), body at
rest, **real transparency** (alpha 0 or 255, clean edges), the item only: no body, no background,
no guide lines, no text, no shadows on the ground.

## pose rules (apply to every type)

- Bold outline with flat cel shading: one base tone, one hard-edged shade tone, trim, no gradients,
  no texture, no scribbles. At most 8 distinct colours.
- The outline can be any hue, but it must be clearly darker than the item's own colours: its median
  luminance must be at least 30 (of 255) below the item's mean fill luminance (`outlineContrast`). A
  red-brown outline is fine on a red or tan item if it is darker. (The kung-fu jacket's own stroke stays
  near-black `#181210`; that is that item's choice.)
- Garments are **flat**: no holes, no visible inside, no visible back. Collars are flat, with the neck
  skin showing above them.
- Gaps between the arms and the torso stay open (transparent). Nothing bridges them.
- Items extend past the body only through **declared overflow zones**, and only when the user asks.
- Clothes go over the shorts.
- The items are drawn for the body at rest in the standard pose (arms a little out from the torso).

## simple (full spec)

The **simple template** (renamed from `fitted-cloth` in; `--type fitted-cloth` still works as a deprecated
alias) is the thin, body-hugging garment: a body-derived core with a neckline, cross-arm cuff cuts and a hem cut,
the construction the kung-fu jacket, the test shirt and the leather armour use. It is a **template, not a material**:
thin armour of ANY class (cloth, leather, chainmail, breastplate) is built on it, and so are shirts, jackets and
tunics. The item is the body-derived surface of its domain (`fixtures/garments/*.domain.json`), painted.

A new simple item copies a proven domain (`test-shirt` for elbow cuffs, `kungfu-jacket` for long cuffs) and changes
only `name`, the cuff choice (which domain it copies), `margin`, `stroke.color` and the neckline `drop`. No new cut
layouts: fix the template, not the item.

Stock armours on the simple template (`fixtures/garments/stock-*.domain.json`):

| Item | Class | Sleeves (copied from) | Margin | Stroke |
| --- | --- | --- | --- | --- |
| `stock-leather` | leather | elbow (test-shirt) | 4.5 | dark brown `2a160b` |
| `stock-cloth` | cloth | long (kungfu-jacket) | 4.5 | dark brown-grey |
| `stock-chainmail` | chainmail | elbow (test-shirt) | 4.5 | dark steel |
| `stock-breastplate` | breastplate (thin) | elbow (test-shirt) | 4.5 | dark steel |

Other templates (each armour class can come in any of them): **medium** (built, section below), and
planned (not built yet):

- **wings**: a back piece with declared overflow (needs the overflow geometry and secondary motion of hanging-cloth).
- further ones as needed (long skirts, hooded); each gets its own section here, guide variant and checks.

| Rule | Value |
| --- | --- |
| Fit | Near-perfect: about 3-4 px past the skin outline (the domain margin), following every arm and the torso. Thin armour may be a tiny bit larger (margin only). |
| Sleeves | Thin tubes that follow the arm from shoulder to the cuff cut; no flare, no bell, no bulge. |
| Torso | Follows the torso sides, ends at the hem cut, over the shorts. |
| Gaps | The wedge between each arm and the torso stays transparent: no webbing, no underarm fabric across it. |
| Coverage | Opaque over the whole allowed area inside the cuts: no skin or body outline may show through. Only the neck above the collar and the hands / forearms below the cuffs show. |
| Collar | Flat; transparent above the collar edge so the neck skin shows; no dark hole, no inner back, no 3D depth. |
| Outline | Solid bold line on every contour, about as thick, clearly darker than the item as the body's (9-10 px). |
| Shading | Flat cel: base, one shade tone, trim colour(s), optional one highlight. Shading = a few broad, subtle, low-contrast cel shapes, at most 2-3 soft fold shapes on the whole item; no thin streaks, wrinkle lines or sheen strokes. Material marks (quilting stitches, mail rings, rivets) are clean, sparse line or dot details in the shade/trim tones, readable at 0.4, never noise. |
| Colours | No light warm skin-like tones (beige, light tan, peach) for the fabric or its line work: the coverage gates read skin by colour (`isSkinColour`: r > 170, r - b > 60, r - g > 20), so the antialiased edges of such lines count as skin showing through (an oatmeal gambeson failed coverageEveryFrame beside every quilting line). The same holds for the antialiased BLEND of two touching colours in the game render (Chinese set, Wanderer's Wrap try 1: an antique-gold #a88a38 clasp on cream read (186,164,106), a red sash against cream (176,80,79), both skin): red, orange, gold, bronze and brown tones keep a red channel of 150 or less (gold #967e34, red #94222a), and red/orange never touches a light cream/white/pale area directly. Interior line work stays about 30 px from the outline (`flankSingleLine`). |
| Arm/torso seam | No line or dark band between sleeve and torso inside the item (no outline ink, nothing darker than the shade tone on either side). A two-material item (breastplate over cloth sleeves) changes colour exactly on the seam with a clean hard edge and no line between (a dark edge line there rendered as a smudge at the top of each armhole) (outline ink there renders as broken dashes on the body-derived surface; `scripts/polish-seam-ink.py check` measures it). |
| Trim bands | Collar, cuff and hem bands and plackets meet the fabric with a clean colour change, never a dark or outline-coloured edge line. At rest the top of each cuff band hangs right beside the armpit, so a band edge line there lands in the `flankSingleLine` window (the Dragon Silk Jacket's 6 px ink line on the cuff band top failed tries 1-2 at y849-854). No dark stroke within 30 px of the torso side below each armpit, sleeve paint included. |
| Overflow | None unless the domain file declares `overflow` zones (canvas rectangles). Capes, wide sleeves and hems are overflow, not fit. |

Checks that apply (run in order, after the importer gates):

1. importer gates (coverage every frame, flank single line, contours, ink replaced, ...);
2. `outlineContrast`, `paletteOutliers`, `paintOutsideAllowed`, `holesAndSeeThrough`, `registration`.

Known bad (see `examples/bad/README.md`): the collar hole, the red border, a blocky or oversized
jacket that fills the arm gaps, scribbled skin near the holes.

## medium (full spec)

The **medium template** () is the bulky, padded garment: a gambeson, padded cloth armour, heavier leather. It
is the simple template's construction unchanged (body-derived core, the same neckline / cross-arm cuff / hem cuts, the
same seeds and gaps; no new cut layouts), with a thicker margin strip and its own thickness rules. Like simple it is
a template, not a material: any armour class can come in it. The domain declares it:
`"template": "medium"`, `margin` = the full thickness, `bulk` = per-item construction settings (`{}` = defaults,
`MEDIUM_BULK_DEFAULTS` in `tools/garmentSurface.ts`). Everything is build time: the runtime reads the per-anchor
offsets like any garment (runtime-generic).

A new medium item copies a medium domain (`fixtures/garments/medium-gambeson.domain.json`: long cuffs, copied from
the kungfu-jacket / stock-cloth domain) and changes only `name`, the cuff choice (which simple domain's cuts it
copies), `margin`, `stroke.color`, the neckline `drop` and, if needed, `bulk`.

| Rule | Value |
| --- | --- |
| Thickness | `margin` 11 (simple 4.5) on the free outline: shoulders, outer arms, torso sides, cuffs, hem. |
| Collar corners | The margin ramps from `neckMargin` 4.5 at each neckline end to the full margin over `neckRamp` 30 px of rest arc (smoothstep): the collar corner stays the simple corner, no step up into the neck. |
| Armpits and arm gaps | Beside each underarm fold apex the margin holds `gapMargin` 4.5 for `gapArc` 6 px, then ramps over `gapRamp` 40 px. Along the whole side of a protected gap it is also capped by the rest clearance so the two outlines keep `strokeW + gapVisible` (10 + 8 px) apart (never below 4.5). Ramped margins change by at most `slope` 0.2 px per px of arc (no jogs). The simple template's own apex taper (closed fold apex, GAP_TAPER_SLOPE) still applies. |
| Silhouette | The offset outline is low-passed (Taubin, `smoothIters` 40) so it does not follow every small body bump; each anchor stays within `smoothDev` 2.5 px of its ramped margin and may only grow where the margin is free (never beside a gap). |
| Art | Same as simple (flat cel, bold outline darker than the item, no seam ink, no skin-like tones, line work 30 px clear of the outline); the padded look = thickness + a few clean quilting channels in the shade tone. Prompt blocks `rules-medium`, `intro-medium`. |
| Heavy armour paint | Mail, scale, lamellar and plate on the medium template must look heavy in the paint itself: chunky trim bands (about 18-26 px), thick plate and disc rims (about 6-10 px), layered overlapping pieces (lamellar rows, hem flaps or a plate skirt inside the hem cut, collar plates, thick cuffs), each casting one broad hard-edged shade along its lower edge, and stronger cel contrast on plates (a clearly darker shade, at most one bold flat highlight per plate). Paint only: inside the outline and cuts, with the 30 px line-work clearances; no new cut topology. Prompt `rules-medium` rule 6. |
| Flank strip | From each armpit gap's top to about 60 px below it, the 30 px beside the torso side outline (and the hanging sleeve's inner edge) is plain base tone: no mail rings, lamellar/scale marks, rivets, plate edges, shade, and no belt or band darker than the base (`flankSingleLine` reads anything darker than the fabric median there as a second line). Chinese set: Jade Guard tries 1-2 failed at y823 (ring marks and sleeve shade beside the left apex), Mirror Plate try 1 at y845/847 (dark red belt top and lamellar shade marks beside the apex). Prompt `rules-medium` rule 8. |

Gates (importer, `--type medium` requires them; also run for simple items):
- `armGapEveryFrame`: in every 30 fps frame of arm raise, flex, walk, idle and sweep, the garment outlines across each
  protected gap stay >= `armGapMinPx` (2.5 px, centreline) apart wherever the BODY gap can hold both local margins
  (`armGapClearance`: each anchor's own margin). Measured: simple items >= 3.48, the gambeson domain 3.91.
- `noFlipsEveryFrame`: no flipped (folded) garment triangle in any of those frames.
- `silhouetteSmooth` (medium only): the rest outline's largest deviation from a local quadratic fit over +-16 px of
  arc (`silhouetteBump`) <= `maxBumpPx` 0.9 px, and the low-pass moved no anchor more than `smoothDev`. Measured: the
  gambeson domain 0.68, the simple cloth 0.65; a 2 px one-vertex bump reads 1.13 (unit test control).
- every simple-template gate (coverage every frame, flank single line, outline turn, closure, ...), unchanged.

Commands: `swag:template --type medium [--domain <medium domain>]`
(default domain the gambeson; a simple domain with `--type medium`, or a medium domain with `--type simple`, is
refused). Rebuild: `rebuild-body-and-jacket.sh --medium-only`.

## hard-plate (full spec)

Pauldrons, couters, any rigid piece that rides one bone and never bends. The plate is NOT built from
the body surface: the engine cuts the painted plate out of the art and pins it to one bone as a region
(`tools/hardPlate.ts`), so it moves rigidly with that bone (no skin deformation) and the right plate is
the left one mirrored about the body's axis. Spec: `fixtures/garments/*.plate.json` (`atlas-plate/1`).

| Rule | Value |
| --- | --- |
| Bone | One per side (`sides.l.bone`, `sides.r.bone`): the pauldron rides the upper arm. |
| Draw order | Explicit: the plate slot is anchored right after `sides.*.drawAfter` (the pauldron after the hand: over the whole arm, any sleeve and the torso armour) and stays before the head; the anchor travels with its slot. |
| Area | An ellipse at rest (`area`, canvas px, left side) on the shoulder: the plate stays inside it and covers at least 70% of it and all of its core (`requiredScale` 0.55 of the area). Plates may pass the body silhouette, only through declared overflow: `overflow` zones (canvas rectangles, left side, mirrored for the right) whose geometry is the plate's own region on its bone; the `overflowDeclared` gate fails paint past the worn rig's rest silhouette outside them. The pauldron () is a shoulder cap: the area follows the shoulder slope (rotation -45, wider than tall), its outer edge about 12-20 px past the shoulder outline from the shoulder top down the outer upper arm (zone `shoulder_overhang`), so the plate covers the outer shoulder line with a few px of overhang. |
| Art | The LEFT plate only, registered on the rig canvas at rest; nothing on the other shoulder. One solid piece. |
| Outline | Solid bold line all round (about 9 px), clearly darker than every plate colour (`outlineContrast`). |
| Shading | Flat cel: base metal tone, one hard-edged shade tone, at most one highlight, trim/rivets. No sheen gradients. At most 8 colours. |
| Head | The posed plate outline never runs under the head's outline (`maxHeadOverlapPx`, 0 for the pauldron) in any frame of idle, walk, arm raise and flex. |

Guide: `swag:template --type hard-plate [--plate <spec>] [--rig <worn rig>] [--body <png>]`: the body
at rest (over the rig the plate is worn on, e.g. the leather armour), the area tinted green with a
magenta edge, the socket as a cyan cross, the mirrored copy's area as a grey dashed edge, declared overflow
zones as orange dashed boxes.

Checks (`--type hard-plate --rig <worn rig> [--bare <bare rig>]`, in order):
1. `outlineContrast`, `paletteOutliers`, `paintOutsideAllowed` (the area), `holesAndSeeThrough` (holes,
   semi-transparency, cracks in the area's core), `registration` (70% coverage, 30% scale band: the
   area is a limit, not the shape), `singlePiece` (no detached bits of 4 px or more);
2. plate import gates (`src/cli/plateImport.ts`): `restRegistration` (IoU >= 0.985 per side at rest),
   `rigid` (corner distances unchanged, < 0.001 px, every 30 fps frame), `headOverlap`, `drawOrder`
   (after the anchor, before the head, every frame), `overflowDeclared` (paint past the worn rig's rest
   silhouette only inside declared overflow zones), `swapWhilePosed` (detach and re-attach mid arm
   raise = never detached, pixel equal). Art gates (checks, restRegistration, headOverlap, onShoulder, overflowDeclared) send the art
   back; rigid, drawOrder and swapWhilePosed are rig gates.

## headwear (stub)

Hats, helmets, hoods. Attached to the head mesh, not the torso. Still to decide: head domain data (the
body domain schema covers the torso and arms), how much a hat may extend past the head (overflow
zone by default), hair interaction. No guide variant or checks yet.

## hanging-cloth (stub)

Capes, loose robes, tabards: cloth that hangs and moves away from the body. This is overflow by
definition, so it needs declared overflow zones and a secondary-motion rig. Still to decide: the
overflow zone shape, the follow-through rig, the back layer (the cape is the one case where a
back view is drawn). No guide variant or checks yet.

## held-item (full spec, first item: the sword)

Weapons and tools held in one fist. Like the hard plate, the item is NOT built from the body surface: the
engine cuts the painted item out of the art and pins it as one region to a **grip bone**, a child of the
hand bone at the grip point (`tools/heldItem.ts`), so it moves rigidly with the hand. Spec:
`fixtures/garments/*.held.json` (`atlas-held/1`); first item `sword.held.json`.

| Rule | Value |
| --- | --- |
| Bone | `hand.bone` (the sword: `hand_l`, the screen-left fist). The grip bone `<name>_grip` sits at `grip.at` (canvas px at rest, the fist's centre) turned `grip.angle` from the hand (the natural hold: the sword's blade leaves the thumb side, 90 degrees). Clips may key its rotation (a roll of the item in the fist; the sword slash turns it a full 360 over the clip); never its translation. |
| Pivot | The art's grip point is the region's pivot: the item turns about the handle inside the fist. |
| Art frame | The item is painted on the rig canvas, handle through the fist at rest, straight along `art.axis` (canvas degrees, pommel -> tip; the sword: 90, straight down, clear of the arm), inside the box `behind` / `ahead` / `halfWidth` along that axis. Inside the fist circle (`fistRadius`) only the handle, at most `2 x handleHalfWidth` wide; guard and pommel outside it. |
| Fist over the hilt | A copy of the fist slot (region, contours and contour joins) is anchored right after the item slot (`<name>_fist`), so the fist always covers the handle wherever the item is drawn; the copy is pixel identical to the fist, and its joins keep the wrist line continuous. |
| Draw order | The item slot is unanchored, set up right before `drawBefore` (the fist). Held clips declare `drawPhases` (`back`: behind the whole body, `front`: in front of everything); the importer turns them into draw-order keys for each rig, half a frame before the frame they apply to. Effects slot `<name>_fx` is anchored right before the item. |
| Opaque | The item region gets a conservative opaque polygon (the longest straight blade rectangle): a region without one trims every stroke under its whole rectangle. |
| Outline | Solid bold line all round (8-9 px), clearly darker than every item colour (`outlineContrast`). |
| Shading | Flat cel: one base tone per material, one hard-edged shade tone, at most one highlight. No sheen gradients, glow or motion lines. At most 8 colours. |
| Size | The sword: about 0.38 of the body's height (420 canvas px pommel to tip, blade about 50 px wide), readable at game scale (about 1/7). |
| Elbows | Held clips keep elbow bends natural: with the arm down the forearm stays near straight (no outward bend); with the arm raised the forearm folds toward the head. Keep the blade roughly across the fist (45-135 degrees from the hand bone) whenever the item is in front, or the pommel lies over the wrist line. |

Guide: `swag:template --type held-item [--held <spec>] [--rig <rig>] [--body <png>]`: the body at rest, the box
tinted green with a magenta edge, the axis as a dashed cyan line, the grip as a cyan cross, the fist as a
dashed cyan circle and the widest handle as two short cyan lines.

Checks (`--type held-item [--held <spec>] [--rig <rig>]`, in order):
1. `outlineContrast`, `paletteOutliers`, `paintOutsideAllowed` (the box), `holesAndSeeThrough`,
   `gripRegistration` (axis within 3 degrees, handle centred within 4 px of the grip, unbroken and narrow
   through the fist circle, reaches `minAhead` past the grip, pommel past the fist), `singlePiece`;
2. held import gates (`src/cli/heldImport.ts`, every 30 fps frame of every clip of every dressed rig):
   `restRegistration` (IoU >= 0.985 with the grip turned to the art axis), `attached`, `rigid`,
   `handleInFist` (the handle's centre line stays inside the posed fist outline), `fistOverItem` (copy right
   after the item, identical vertices, contours and joins), `drawOrderSwitch` (each declared phase really
   shows the item behind / in front). Art gates (checks, restRegistration, handleInFist) send the art back.

Clips (`fixtures/clips/<name>-*.json`: `{name, about, clip, drawPhases, smears}`, `clip` in the atlas-anim clip
format): the importer adds them to each dressed rig and builds each `smears` entry from the motion itself
(the area the blade's outer part sweeps between two clip times, a pale crescent with a darker outline on the
root bone, keyed on for one frame).

Still open: size limits per item class (dagger, two-hander, staff), shields (an off-hand plate), the
per-hit lever interplay with combat balance, other facings.
