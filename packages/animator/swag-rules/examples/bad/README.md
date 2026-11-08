# Bad examples

What the artist must not produce. Images are included only where they already exist in the
evidence folders under `docs/plans/atlas-animator-demos/phase-4d4n/`; the rest are described.

| Failure | What it looks like | Caught by |
| --- | --- | --- |
| **Weak outline (the "red border")** | The jacket outline drawn in the body's red-brown (`#3a1001`) next to a near-black fabric: it reads as a brown halo. Rule now: the outline may be any hue but must be clearly darker than the item (here the near-black `#181210` stroke is the jacket's choice). Image: `red-border-vs-near-black.png` (left three columns `181210`, right three the body brown, light and dark grounds; from `phase-4d4n/jacket/jacket-outline-compare.png`). | `outlineContrast` (when the outline is not darker than the fill) |
| **Collar hole** | The collar drawn as a 3D stand-up ring with a dark or see-through opening and the inside of the back visible. The collar must be flat, with the neck skin showing above it. (Owner-reported; no image kept in the evidence folders.) | `holesAndSeeThrough` (enclosed opening), `paintOutsideAllowed` (collar standing off the neck) |
| **Blocky / oversized jacket** | A boxy jacket that fills the space between the arms and the torso and sticks out far past the body (the v2 jacket, "way too blocky"). Sleeves flared or bell-shaped. Fit must be 3-4 px past the skin. (No image kept in the evidence folders.) | `paintOutsideAllowed` (paint in the gap wedge and past the arm), `registration` (scale) |
| **Scribbled skin near the holes** | Rough, scratchy strokes or noisy texture painted near the neck, sleeve and hem openings, where the engine's cut edge meets the skin. Paint must stay flat and clean at every opening. (No image kept in the evidence folders.) | `paletteOutliers` (noise and off-palette colour), importer gate `skinSpecks` / `inkReplaced` |

Other things the checks reject that are easy to get wrong:

- art shifted or scaled against the body (the guide is pixel exact; never crop, resize or squash);
- holes, see-through spots or semi-transparent fabric inside the item;
- gradients, texture and more than 8 colours;
- paint outside the guide outline without a declared overflow zone.
