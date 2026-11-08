/*
 * Atlas Animator: original implementation.
 *
 * Surface presets: the data a template supplies to the continuous-surface builder.
 * All coordinates are canvas pixels (y down), angles degrees clockwise. A humanoid shoulder, a
 * creature leg or a wing root is one preset each; the builder holds no template values.
 * Presets live beside their art (fixtures/canonical/*.preset.json).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const pt = z.tuple([z.number(), z.number()]);
const pathPoint = z.union([
  pt,
  // `straight`: the edge from this point to the next is one straight, unsampled segment (both ends kept as
  // corners, no points added between them): a steep entry under another sheet with no shallow vertex on it
  z.object({ at: pt, corner: z.boolean().optional(), straight: z.boolean().optional() }).strict(),
  z.object({ s: z.number(), v: z.number(), corner: z.boolean().optional(), straight: z.boolean().optional() }).strict(),
  z.object({ arc: z.object({ center: pt.optional(), s: z.number().optional(), r: z.number().positive(), from: z.number(), to: z.number(), step: z.number().positive().optional() }).strict() }).strict()
]);
const path = z.array(pathPoint).min(1);
const box = z.object({ sMin: z.number().optional(), sMax: z.number().optional(), vMin: z.number().optional(), vMax: z.number().optional() }).strict();
/**
 * A contour end on a mesh hull: a point (nearest hull vertex), a skin row end, a notch apex
 * (index into topology.apexes) or a declared junction (skin.junctions, by name).
 */
const anchor = z.union([
  pt,
  z.object({ row: z.number(), side: z.enum(["+", "-"]) }).strict(),
  z.object({ apex: z.number().int().nonnegative() }).strict(),
  z.object({ junction: z.string() }).strict()
]);
const color = z.string().regex(/^[0-9a-f]{6}([0-9a-f]{2})?$/i);
const contour = z
  .object({
    name: z.string(),
    owner: z.string(),
    from: anchor,
    to: anchor,
    reverse: z.boolean().optional(),
    width: z.number().positive(),
    color: color,
    caps: z.enum(["round", "butt"]).optional(),
    extend: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
    /**
     * Arm layer: a closing edge over an under-sheet. The
     * stroke is also trimmed where the named slot (drawn before it) covers its centreline, so the
     * edge is inked only where it leaves that sheet: buried, it has no outline; exposed, it is the
     * shared silhouette (format `coverUnder`).
     */
    coverUnder: z.string().optional(),
    /** Arm layer: coverers trim at their outline, trim ends capped (format `coverTight`): the torso outline under the arm cap and the head. */
    coverTight: z.boolean().optional(),
    /** Driver visibility rules (format `visible`): all must hold. */
    visible: z.array(z.object({ bone: z.string(), min: z.number(), max: z.number() }).strict()).optional(),
    /** Rigid coverers (the fist) trim this stroke at their opaque outline only (format `trimAtOutline`): it runs into the fist. */
    trimAtOutline: z.boolean().optional(),
    /**
     * Arm layer: the stroke's opacity follows a driver (no visibility pop): a fader slot with a point
     * attachment owns it, and a driven alpha set keys that slot's alpha by `bone` ([degrees, alpha]
     * pairs, linear between, held outside). `or`: further ways to show it (format driven `alphaOr`):
     * each entry is a list of factors (bone + keys) multiplied together, and the stroke takes the
     * largest of the primary fade and the entries (the forearm folded inward, gated by the raise).
     * Keep each ramp short (the canonical arm layer uses 0.5 deg, attack): a stroke half-way
     * through a long ramp reads as a faint ring (the shoulder cap's across-outline on an attacking
     * arm); held clips gate that no arm-front frame shows a fader between off and on.
     */
    fade: z
      .object({ bone: z.string(), keys: z.array(pt).min(2), or: z.array(z.array(z.object({ bone: z.string(), keys: z.array(pt).min(2) }).strict()).min(1)).optional() })
      .strict()
      .optional()
  })
  .strict();
const fill = z.object({ color, polygon: path }).strict();
/**
 * A joint patch (pass 3a): the deformation region of one joint side. `inner`/`outer`
 * patches are anchored on a boundary chain: the hull span from `from` (a notch apex or a
 * silhouette point) walking towards `toward` for `extent` of arc length; the joint's weight ramps
 * 0 -> 1 along that span (`profile`). `extent` is canvas px, or `{ width: [lo, hi] }`: a fraction
 * range of the local limb width W, searched from lo upwards for the shortest transition whose
 * rotation-blend target keeps every patch triangle above the area floor at both joint limits.
 * `both` patches are distal hinge bands: chain s in [s - b, s + b] across the whole limb, where
 * b is `band` on the outer side and `foldBand` on the fold side (`fold`: the sign of chain v of
 * the hinge's inner, fold side, as the preset declares it), blended across the limb axis.
 * `bones` is the hard support mask: no other bone may influence a vertex of the patch.
 */
const patch = z
  .object({
    name: z.string(),
    /** The chain bone whose rotation the patch blends in (the distal side of the joint). */
    joint: z.string(),
    side: z.enum(["inner", "outer", "both"]),
    from: z.union([pt, z.object({ apex: z.number().int().nonnegative() }).strict()]).optional(),
    toward: pt.optional(),
    extent: z.union([z.number().positive(), z.object({ width: pt }).strict()]).optional(),
    s: z.number().optional(),
    band: z.number().positive().optional(),
    foldBand: z.number().positive().optional(),
    fold: z.enum(["+", "-"]).optional(),
    profile: z.enum(["linear", "smooth"]).optional(),
    bones: z.array(z.string()).min(1),
    /**
     * Notch apex in this patch: largest posed displacement allowed (canvas px); 0 = an exact anchor
     * on the base bone. Above 0 the apex rides along the body branch's tangent (up the flank: the
     * crease rides up with the limb) by this much, ramped (smoothstep) over the joint driver range
     * `apexRide` (default [0, the joint's upper limit]).
     */
    permittedApexMotion: z.number().nonnegative().optional(),
    apexRide: pt.optional(),
    /**
     * Girdle coupling of the riding apex (pass 3d-1 decision: a shrug elevates the
     * shoulder girdle, so the armpit apex rides up with it). `bone` is a girdle bone between the
     * base and the patch's joint; the permitted apex motion grows by `gain` x the girdle's
     * elevation of the joint pivot (how far that bone's own rotation carries the pivot away from
     * the apex, canvas px; depression adds nothing).
     */
    apexGirdle: z.object({ bone: z.string(), gain: z.number().nonnegative().default(1) }).strict().optional(),
    /**
     * Procedural boundary of the patch's root runs (pass 3d-1; default: the Hermite bend):
     * `crease` (a run ending on the notch apex): the limb edge stays a straight line (the rigid
     * core's edge carried by its bone) up to where it meets the body branch's tangent line, a fillet
     * of radius <= `fillet` x W there, then straight down that line to the apex;
     * `cap` (an outer run from a body anchor to a limb core anchor): the outer envelope, in polar
     * coordinates about the joint pivot, of the body side (posed without the chain) and the rigid
     * limb side, a smooth maximum (bump <= 2 px) where they cross and an arc about the pivot where
     * they part.
     */
    boundary: z.enum(["crease", "cap"]).optional(),
    /**
     * Shoulder arc of a `cap` run: where the raised limb's top edge meets the strap
     * side, the smooth maximum's pinch (the body's shoulder line standing over the limb edge, then
     * stepping onto it in a concave notch) is replaced by ONE sweep: a cubic Hermite from a body
     * hand-off `from` canvas px from the body anchor (0 = the strap corner) to a limb hand-off `to`
     * px past the crossover, matching the envelope's direction at both, tangent lengths `tension` x
     * the chord. Its weight ramps in by the joint's rotation over `ramp` (degrees; 0 below, so the
     * rest cap is untouched) and the outline moves by at most `move` canvas px. The run's anchors
     * and every run outside the cap are untouched (the lower flank lock is kept). `region` (canvas
     * px along the run at bind, default 90) and `gate` (degrees over the rest turn, default 10)
     * declare the junction-concavity gate, `neck`/`neckGate` the strap/neck curve gate
     * (junctionGate.ts). `ride` (CapArc.ride) rounds the strap corner up onto one curve from
     * the strap/neck side to the raised limb's top edge, eased in by its own `ramp`.
     */
    arc: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative(), tension: z.number().positive().default(1), ramp: z.tuple([z.number(), z.number()]), move: z.number().nonnegative(), region: z.number().positive().optional(), gate: z.number().positive().optional(), gateByRaise: z.array(z.tuple([z.number(), z.number().positive()])).optional(), neck: z.number().positive().optional(), neckGate: z.number().positive().optional(), ride: z.object({ ramp: z.tuple([z.number(), z.number()]), to: z.number().positive(), tension: z.number().positive().default(1), max: z.number().nonnegative(), radius: z.number().positive() }).strict().optional() }).strict().optional(),
    fillet: z.number().positive().optional(),
    /**
     * Crease boundary only (underside crimp): over `ramp` degrees of the patch's joint the
     * crease run blends from the limb line + fillet + web into one circular arc tangent to the limb
     * edge at the hinge-band end and along the web into the apex (one G1 cubic); `spread` (0..1)
     * moves the run's vertices that share of the way from their home spacing to even arc-length
     * fractions (a shorter chord into the apex; 1 = even), ramped over `spreadRamp` (default
     * `ramp`; a wider ramp spanning driven-grid keys keeps the slide representable by the bake).
     * `linear`: the ramps are linear with C1-rounded ends (15% of the ramp) instead of smoothstep,
     * so driven-grid keys inside a ramp interpolate it exactly.
     */
    creaseArc: z.object({ ramp: z.tuple([z.number(), z.number()]), spread: z.number().min(0).max(1).default(1), spreadRamp: z.tuple([z.number(), z.number()]).optional(), linear: z.boolean().default(false) }).strict().optional(),
    /**
     * An angle-keyed edge push of the joint's limb, baked by the joint's corrective: hull vertices on
     * chain side `side` (hinge runs, core anchors and the next joint's band alike) move off the limb
     * along the posed hull's outward normal by `keys` (joint angle in degrees -> canvas px, linear
     * between keys, 0 outside them), weighted along the chain by a trapezoid over `s`
     * ([s0, s1, s2, s3]: smoothstep 0 -> 1 over s0..s1, 1 to s2, 1 -> 0 over s2..s3). Use: the
     * folded forearm's inner edge overlapping the trunk instead of running beside its outline.
     */
    push: z.object({ side: z.enum(["+", "-"]), keys: z.array(pt).min(2), s: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict().optional(),
    /** Target width range (canvas px) across the patch's rows, largest bulge, aggregate area band (bounds for the pass-3b shape solver and its gates). */
    envelope: z
      .object({
        width: pt.optional(),
        bulge: z.number().nonnegative().optional(),
        /**
         * Declared aggregate area band of the joint region (posed / bind; the widest of the joint's
         * patches applies), default [0.9, 1.1]. A fixed notch apex makes a raised limb open new skin
         * between the flank and the limb's underside, so a root joint may declare more.
         */
        area: pt.optional(),
        /**
         * Squash floor of a limb hinge: the hinge runs' vertices slide along their posed outline so no
         * boundary edge shortens below this fraction of its bind length where the run allows
         * (solver.ts spreadSquash); without it the crease vertices bunch at the fold's corner and one
         * sliver takes the whole fold down to the det floor.
         */
        squash: z.number().positive().max(1).optional()
      })
      .strict()
      .optional()
  })
  .strict();
/**
 * A trunk bend zone: near-rigid torso/head regions joined by one local bend. Along the
 * axis a -> b the share `t` (smoothstep 0 at a, 1 at b) of each vertex's `from` weight moves to
 * `to`: past b the vertex follows `to` rigidly, before a it is untouched. `r0`/`r1` (optional)
 * limit the zone across the axis: full strength within r0 canvas px of the line through a and b,
 * none past r1 (a neck zone that leaves the shoulder line alone). Both bones must be skin
 * influences: the base, the girdle, or bones of `chain.branches`.
 */
const bend = z
  .object({ name: z.string(), from: z.string(), to: z.string(), a: pt, b: pt, r0: z.number().nonnegative().optional(), r1: z.number().positive().optional() })
  .strict();
/** A rigid core: limb-tube vertices with chain s in [sMin, sMax] outside every patch follow `bone` alone. */
const core = z.object({ name: z.string(), bone: z.string(), sMin: z.number(), sMax: z.number() }).strict();
/** A fixed body region (a flank below the underarm patch): vertices inside follow `bone` alone, exactly. */
const fixedRegion = z.object({ name: z.string(), bone: z.string(), polygon: z.array(pt).min(3) }).strict();
/**
 * A contour junction: a posed point (the hull vertex of `on`, the skin by default or a garment,
 * nearest `at`) where contour spans meet. `leaves: <garment>` makes it the hull exit: walking the
 * skin hull from `at` towards `toward`, the first vertex outside the garment by more than its
 * edge half width (the garment owns the visible edge before it).
 */
const junction = z
  .object({ name: z.string(), at: pt, on: z.string().optional(), leaves: z.string().optional(), toward: pt.optional(), radius: z.number().positive() })
  .strict();
const sweepPhase = z.object({ bone: z.string(), from: z.number(), to: z.number(), step: z.number().positive() }).strict();

/**
 * Arm layer: a detached under-sheet built beside
 * the skin (the torso under the arm). Its own silhouette (canvas points), lattice and paint; trunk
 * weights only (base, girdle, trunk bends), never a chain joint; `contours` anchor on its own hull.
 */
const sheet = z
  .object({
    name: z.string(),
    slot: z.string(),
    attachment: z.string(),
    texture: z.string(),
    silhouette: path,
    spacing: z.number().positive(),
    lattice: z.number().positive(),
    minDistance: z.number().positive(),
    base: color,
    fills: z.array(fill),
    contours: z.array(contour).default([])
  })
  .strict();
/**
 * The connection contract of a layered body (arm-layer plan step 1): which sheets exist, how they
 * connect and in which order they draw, and the poses the build must reach unprojected.
 * `connections`: an `overlap` connection puts the skin group `over` (the arm, drawn after) on the
 * sheet `under` (the torso); `closure` is the arm contour (`owner/name`) along its closing cap,
 * trimmed under the sheet (`coverUnder`); `clearance` the measured overlap the closing edge needs
 * inside the sheet where it is buried (canvas px: stroke half width plus antialiasing).
 * `order`: the slots of the assembly bottom to top as drawOrder lists them (checked).
 * `poses`: acceptance poses (bone -> degrees from setup); they must lie inside every build and clip
 * limit (never silently projected back), and their mirror is required on the far side.
 */
const assembly = z
  .object({
    sheets: z.array(sheet).min(1),
    connections: z
      .array(z.object({ name: z.string(), kind: z.literal("overlap"), over: z.string(), under: z.string(), closure: z.string().regex(/^[^/]+\/[^/]+$/), clearance: z.number().nonnegative() }).strict())
      .min(1),
    order: z.array(z.string()).min(2),
    /**
     * Arm-vs-arm order when the arms overlap (review): which arm assembly (sheet, strokes,
     * fist) draws wholly in front: `far` (the mirrored arm) or `near`. A clip can still swap it with
     * draw-order keys (format drawOrder timelines) for an attacking arm.
     */
    frontArm: z.enum(["near", "far"]).default("far"),
    poses: z.array(z.object({ name: z.string(), pose: z.record(z.number()) }).strict()).min(1)
  })
  .strict();

export const surfacePresetSchema = z
  .object({
    name: z.string(),
    /** One line on what this preset is (shown in reports). */
    description: z.string().optional(),
    canvas: z.object({ width: z.number(), height: z.number(), originX: z.number(), originY: z.number() }).strict(),
    /** Canvas height of the whole figure, and its on-screen height in game pixels (the game-size scale). */
    figureHeight: z.number().positive(),
    gamePixels: z.number().positive(),
    skinName: z.string().optional(),
    bones: z
      .array(
        z
          .object({
            name: z.string(),
            parent: z.string().optional(),
            /** World pivot (canvas); default the canvas origin. */
            at: pt.optional(),
            /** World end point: sets rotation and length. */
            toward: pt.optional(),
            rotation: z.number().optional(),
            length: z.number().optional(),
            limits: pt.optional(),
            /**
             * Transform inheritance: `noScale` keeps a child (neck, clavicle) at its own
             * size while the parent breathes (chest scale); its pivot still rides the parent.
             */
            inherit: z.enum(["normal", "onlyTranslation", "noRotation", "noScale", "noScaleOrReflection"]).optional()
          })
          .strict()
      )
      .min(1),
    /** Body bone (weights' rest owner). */
    base: z.string(),
    /**
     * Bilateral mirror rule: the half-body preset is solved once and mirrored about the
     * vertical line x = `x` (tools/mirrorRig.ts). `rename` maps bone and slot names (suffix pairs,
     * e.g. ["_l", "_r"]; `slots` names slots the suffix rule cannot reach). The builder ends the
     * girdle share `feather` canvas px before the line, so centreline vertices carry trunk weights
     * only and can be welded with their mirror.
     */
    mirror: z
      .object({
        x: z.number(),
        rename: z.array(z.tuple([z.string(), z.string()])).min(1),
        slots: z.record(z.string()).default({}),
        feather: z.number().positive().default(24),
        /** Centre regions (by name) rebuilt from the art's own far side instead of mirroring the solved side (breaks bind symmetry; default none). */
        asymmetric: z.array(z.string()).optional()
      })
      .strict()
      .optional(),
    /** Optional girdle (clavicle, pelvis, wing root): radial falloff around `center`, scaled below it. */
    girdle: z
      .object({
        bone: z.string(),
        center: pt,
        r0: z.number(),
        r1: z.number(),
        belowScale: z.number().positive(),
        /** The girdle share fades to 0 over this distance (canvas px) towards fixed regions and anchored apexes: it never overrides them. */
        feather: z.number().nonnegative().optional()
      })
      .strict()
      .optional(),
    /**
     * The limb chain, root segment first; the last bone needs `toward`. `branches`
     * makes it a tree (pelvis > chest > neck > head, clavicles off the chest): each branch is a
     * chain hung from `parent` (any earlier bone of the skeleton), its bones parent to child. The
     * limb chain keeps the joint machinery (patches, cores, correctives); branch bones are
     * near-rigid trunk influences: they reach the skin only through
     * `skin.regions.bends` (local bend zones), never through patches or correctives.
     */
    chain: z
      .object({
        bones: z.array(z.string()).min(1),
        branches: z.array(z.object({ parent: z.string(), bones: z.array(z.string()).min(1) }).strict()).optional()
      })
      .strict(),
    skin: z
      .object({
        slot: z.string(),
        attachment: z.string(),
        texture: z.string(),
        silhouette: path,
        spacing: z.number().positive(),
        lattice: z.number().positive(),
        minDistance: z.number().positive(),
        topology: z
          .object({
            from: z.number(),
            to: z.number(),
            halfWidth: z.number().positive(),
            columns: z.number().positive(),
            core: z.number().positive(),
            minRowGap: z.number().positive(),
            joints: z.array(z.object({ s: z.number(), band: z.number().nonnegative(), rows: z.number().int().min(1) }).strict()),
            extraRows: z.array(z.number()).optional(),
            rings: z.array(z.object({ joint: z.number().int().nonnegative(), radii: z.array(z.number()), from: z.number(), to: z.number(), step: z.number().positive() }).strict()).optional(),
            /** Minimum angle (degrees) between fan rows at an apex (default 12). */
            fanAngle: z.number().positive().optional(),
            /**
             * Notch apexes (armpit, groin, hip crease): a silhouette corner where the limb meets the
             * body on its inner side (`side`: the sign of v there). The apex is a hull vertex; every
             * row whose straight cross-section would reach the body side of the notch (s up to the
             * apex) ends at the apex instead, as a fan, and rows within `reach` (chain s) past it keep
             * `minRowGap` between their inner ends along the hull. Weights come from the patches.
             */
            apexes: z.array(z.object({ at: pt, side: z.enum(["+", "-"]), reach: z.number().positive() }).strict()).optional(),
            frameFrom: z.number().optional(),
            frameTo: z.number().optional()
          })
          .strict(),
        /**
         * Draw groups, in preset order: a triangle belongs to the last group whose `polygon` contains
         * its centroid and whose chain range `s` [from, to) contains the centroid's chain s (either
         * test may be omitted); the first group (no polygon, no range) takes the rest. A limb split
         * into segments (upper arm, forearm) uses `s` at a topology row so the boundary is a row.
         * `under: { garment, clearance }`: the group is a root drawn just below the garment's body
         * piece (draw order derived); gate "partition hidden": its vertices stay inside the
         * garment's posed hull by >= clearance canvas px at every pose.
         */
        groups: z
          .array(
            z
              .object({
                slot: z.string(),
                bone: z.string(),
                polygon: z.array(pt).min(3).optional(),
                s: z.tuple([z.number(), z.number()]).optional(),
                under: z.object({ garment: z.string(), clearance: z.number().nonnegative().default(3) }).strict().optional()
              })
              .strict()
          )
          .min(1),
        base: color,
        fills: z.array(fill),
        /** Root joint weight field: designed boundary values (patch ramps, cores, zeros), harmonic in between. */
        root: z
          .object({
            zeros: z.array(z.union([z.object({ polygon: z.array(pt).min(3) }).strict(), box])),
            iterations: z.number().int().positive().optional()
          })
          .strict(),
        /** Named regions (pass 3a): joint patches, rigid cores and fixed body regions; their bone lists are hard support masks. */
        regions: z.object({ patches: z.array(patch).min(1), cores: z.array(core), fixed: z.array(fixedRegion), bends: z.array(bend).optional() }).strict(),
        /** Contour junctions (posed points). */
        junctions: z.array(junction).optional(),
        contours: z.array(contour)
      })
      .strict(),
    /** Arm layer: detached sheets and the connection contract (absent: one continuous skin). */
    assembly: assembly.optional(),
    garments: z.array(
      z
        .object({
          name: z.string(),
          slot: z.string(),
          bone: z.string(),
          attachment: z.string().optional(),
          texture: z.string(),
          path,
          spacing: z.number().positive(),
          lattice: z.number().positive(),
          minDistance: z.number().positive().optional(),
          base: color,
          fills: z.array(fill),
          contours: z.array(contour),
          /**
           * Garment overlays (3d-1 fix review, the sandwich): a triangle sub-range of the
           * garment's own mesh drawn as its own slot `name`, right after the skin group `above`
           * (draw order derived), riding the garment's weights. It owns the listed garment
           * `contours` and the band of garment fill `fillBand` canvas px past their stroke's inner
           * edge (a constrained offset line, eased to the stroke over `taper` px of arc at both ends),
           * restricted to the bind-space polygon `region`. Gates: invisibility (the render with the
           * overlay merged back into the garment differs only where it covers a group drawn
           * between them) and junction containment (skin contour ends and apexes inside its bind
           * footprint stay inside its opaque band by >= `clearance` canvas px at every pose).
           */
          overlays: z
            .array(
              z
                .object({
                  name: z.string(),
                  region: z.array(pt).min(3),
                  contours: z.array(z.string()).min(1),
                  fillBand: z.number().nonnegative(),
                  above: z.string(),
                  taper: z.number().nonnegative().default(16),
                  clearance: z.number().nonnegative().default(3)
                })
                .strict()
            )
            .optional(),
          /**
           * Embed the garment in the skin: every vertex on or inside the skin surface (within
           * `embedMargin` canvas px, default 0.05, the snapping tolerance) is posed as a barycentric
           * point of the skin triangle under it, so the garment moves bit for bit with the skin
           * (correctives included). Vertices off the skin (a hanging hem, a cuff, the strip of a
           * garment outline just past the silhouette) inherit the weights of their nearest embedded
           * vertex along the garment mesh, whatever skin group is near.
           */
          embed: z.boolean().optional(),
          embedMargin: z.number().nonnegative().optional(),
          /**
           * Close-fitting garment: its mesh is the skin triangulation clipped to the garment outline
           * (skin vertices inside, skin edges split where the outline crosses them), not its own
           * lattice, so every garment triangle lies in one skin triangle and follows the piecewise
           * affine skin exactly. Implies `embed`.
           */
          conform: z.boolean().optional()
        })
        .strict()
    ),
    /** Rigid context art cut from an image (keeps its baked strokes). */
    regions: z.array(
      z.object({ name: z.string(), slot: z.string(), bone: z.string(), texture: z.string(), image: z.string(), crop: z.tuple([z.number(), z.number(), z.number(), z.number()]), keep: z.array(pt).min(3).optional() }).strict()
    ),
    drawOrder: z.array(z.string()).min(1),
    /** Angle-driven correctives: explicit seeds, or seeds spread over the bone's limits. */
    correctives: z.array(z.object({ name: z.string(), bone: z.string(), at: z.array(z.number()).optional(), spacing: z.number().positive().optional() }).strict()),
    /** Two-driver grids; `cap` [columns, rows] lifts the default 4x3 refinement cap, up to 6x5, where a smooth target needs it. */
    grids: z.array(z.object({ name: z.string(), x: z.object({ bone: z.string(), at: z.array(z.number()) }).strict(), y: z.object({ bone: z.string(), at: z.array(z.number()) }).strict(), cap: z.tuple([z.number().int().min(2).max(6), z.number().int().min(2).max(5)]).optional() }).strict()),
    /**
     * Combined pose limits (pass 3d-1): convex polygons in (x, y) driver space (degrees,
     * offsets from setup; drivers not named stay free), AND-ed. `auto` derives the polygon from a
     * declared collision: `collide: [part, region]` (a skin core/patch name or skin group slot, and a
     * rigid context region) sampled on the drivers' limit grid every `step` degrees (default 5) with
     * the other drivers at setup; the part's posed hull, dilated by `margin` canvas px, may not
     * reach the region's opaque pixels. Sweeps, seeds, grid refinement, interpolation and the gates
     * run only inside; the validator flags clips outside; the runtime never clamps.
     * `plus` (part b, a combined limit): drivers added to y, so y is a sum (neck + head:
     * the head's lean towards a raised hand); auto samples every same-side split of each y value
     * over the drivers' limits and blocks the value when any split collides. `auto.hold`: other drivers held
     * at each listed value combination during the sampling (a value is blocked when any combination
     * collides); combinations outside the limits resolved before this one are skipped, and so are
     * combinations that already collide with y's drivers at setup (a pairwise-limit gap, reported:
     * this limit bounds the lean, not the held pose).
     */
    poseLimits: z
      .array(
        z
          .object({
            name: z.string(),
            x: z.string(),
            y: z.string(),
            plus: z.array(z.string()).min(1).optional(),
            polygon: z.array(pt).min(3).optional(),
            /**
             * `clips` (declared polygons only): an authoring rule, not a build bound. It is written to the
             * rig's poseLimits (validator, live limits, mirror and gates check clips against it) but the
             * build (sweeps, seeds, grids, contacts, the surface gates) keeps the mechanical range, so the
             * built body is unchanged. pose rule 1 step 1 (elbow_never_outward, 2026-10-16).
             */
            scope: z.enum(["build", "clips"]).optional(),
            auto: z
              .object({ collide: z.tuple([z.string(), z.string()]), margin: z.number().nonnegative(), step: z.number().positive().optional(), hold: z.record(z.array(z.number()).min(1)).optional() })
              .strict()
              .optional()
          })
          .strict()
      )
      .optional(),
    /**
     * Sparse runtime reduction (sparse.ts): tolerances in game px over every solved sweep
     * frame. `silhouette`: a dropped hull / garment outline sample vs the chord of its kept
     * neighbours; `texture`: a dropped interior or row sample vs its barycentric point in the reduced
     * bind triangulation; `turn`: degrees a kept hull vertex may turn beyond the dense hull's turn
     * over the 3 game px window around it.
     */
    runtime: z
      .object({
        silhouette: z.number().positive().default(0.25),
        texture: z.number().positive().default(0.25),
        turn: z.number().nonnegative().default(0.5),
        /** Vertex guards of the reduced rig (skin mesh, all garments): reported against, never forced. */
        budget: z.object({ skin: z.number().int().positive(), garment: z.number().int().positive() }).strict().optional()
      })
      .strict()
      .optional(),
    /** Joint crop for review renders (canvas rectangle); the full-figure view is computed from the posed bounds. */
    /**
     * Leg IK policy (r5, tools/stancePolicy.ts): `foreshorten` keeps a planted leg straight
     * as drawn and shortens it toward the viewer (no knee bow); two-bone IK blends in over `blend` of
     * each swing and out before the plant. `bend` keeps two-bone IK in stance.
     */
    ik: z.object({ stance: z.enum(["foreshorten", "bend"]), blend: z.number().min(0).max(0.5).default(0.2) }).strict().optional(),
    frame: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).strict(),
    sweeps: z.array(z.object({ name: z.string(), phases: z.array(sweepPhase).min(1), hold: z.record(z.number()).optional() }).strict()),
    gates: z
      .object({
        /**
         * Hard visible-kink contours (underside crimp): per entry a contour `owner/name`
         * whose visible-kink windows (net turn over KINK_WINDOW game px at visible vertices outside
         * declared corners) must stay within `turn` degrees (default KINK_TURN), or the bind turn +
         * KINK_SLACK, on its own hard gate row. `when` scopes the row to poses whose listed bones
         * lie in [lo, hi] degrees (e.g. the opening side of a joint), `s` to contour vertices whose
         * bind chain coordinate lies in [lo, hi] (e.g. the crease span, not the next hinge band);
         * everything else stays in the reported all-contour kink row.
         */
        kink: z
          .object({
            hard: z
              .array(z.object({ contour: z.string().regex(/^[^/]+\/[^/]+$/), turn: z.number().positive().optional(), when: z.record(z.tuple([z.number(), z.number()])).optional(), s: z.tuple([z.number(), z.number()]).optional() }).strict())
              .min(1)
          })
          .strict()
          .optional(),
        /** Garment contour whose outer half must lie over skin (hidden coverage), with the part to check. */
        coverage: z.array(z.object({ contour: z.string(), from: pt, to: pt, side: z.union([z.literal(1), z.literal(-1)]) }).strict()).optional(),
        /** Draw-group occlusion: at these poses no skin drawn below `garment` may slide under it deeper than its edge half width. */
        occlusion: z.array(z.object({ garment: z.string(), poses: z.array(z.record(z.number())).min(1) }).strict()).optional(),
        /**
         * Stroke clearance (redefined): two different contours
         * running near-parallel (angle below `maxAngle` degrees) must not leave a sub-pixel crack of
         * background between their inks, a gap above 0 and below `displayPx` display px (DPR 1);
         * wider gaps are clean background. An arm closing on the body passes through such gaps in
         * motion, which is acceptable: at held and end poses (the rest pose, every sweep's first and
         * last frame, and every pose listed in `holds`) no crack run may reach `minSpan` canvas px;
         * in motion a crack run >= `minSpan` may last at most `transientDegrees` degrees of the moving
         * joint (consecutive sweep frames, each counting its step from the previous frame).
         */
        /**
         * Visible-distortion exceptions (closeout): one finding id (`kind/slot/attachment/tN`)
         * excused only inside a pose window (bone -> [lo, hi] degrees) and, when `rigHash` is set, only
         * on that rig build (any rebuild that changes the rig re-opens it). `debt` names the polish-debt row.
         */
        visibleDistortion: z
          .object({
            exceptions: z.array(z.object({ id: z.string(), poses: z.record(z.tuple([z.number(), z.number()])), rigHash: z.string().optional(), debt: z.string(), reason: z.string() }).strict()).default([]),
            /**
             * Declared openings (review): narrow texture-debt regions, a bind-canvas polygon per
             * opening; a textured triangle is parked there only when all three bind vertices lie inside
             * it (touching is not enough). Findings there are reported as parked debt, never as passing.
             */
            openings: z.array(z.object({ name: z.string(), polygon: z.array(pt).min(3), debt: z.string() }).strict()).default([])
          })
          .strict()
          .optional(),
        clearance: z
          .object({
            maxAngle: z.number().positive().default(15),
            /**
             * Contour contacts (closeout): when true the declared contact pairs render merged
             * (core/contours.ts applyContacts, scoped to the contact run). Off by default: measured at
             * the closeout the merge raised alpha gaps 2 -> 25 and held crack runs 54 -> 175 on
             * template7 (residual sub-px gaps at run ends and the capped move), so pairs stay contact
             * bands (sweeps trimmed, holds kept out) until the Phase 11 flank-spacing art fix.
             */
            merge: z.boolean().optional(),
            minSpan: z.number().positive().default(3),
            displayPx: z.number().positive().default(1),
            transientDegrees: z.number().nonnegative().default(6),
            holds: z.array(z.record(z.number())).optional(),
            /**
             * Joint ranges an arm only passes through, never holds:
             * at the pose `at` (every listed bone at exactly that value, others free), `joint` in
             * [range[0], range[1]] degrees crosses a contact (e.g. the hand past the flank edge). A
             * held or end pose (declared hold, rest, a sweep's first or last frame) inside a range fails
             * the clearance gate; motion frames inside it are judged by the time cap as usual.
             */
            passThrough: z
              .array(z.object({ joint: z.string(), range: z.tuple([z.number(), z.number()]), at: z.record(z.number()).default({}), note: z.string().optional() }).strict())
              .optional(),
            /**
             * Contact bands (closeout; pass-through generalised from a joint range to a
             * measured band): for the contour pair `pair` (each a contour `owner/name`, matched as one
             * link of a chained ink), the zone of the `x` x `y` driver plane (sampled every `step`
             * degrees, other bones at `hold`) where the pair leaves a crack under one display px. Motion
             * may cross it; held/end poses and keys may not sit in it (sweep ends are trimmed out of it,
             * live limits project keys out of it). There is no time cap: under stepped playback every
             * shown frame is a hold, so cracks outside a declared band fail at every frame.
             */
            contacts: z
              .array(z.object({ name: z.string(), pair: z.tuple([z.string(), z.string()]), x: z.string(), y: z.string(), step: z.tuple([z.number().positive(), z.number().positive()]).default([3, 1]), hold: z.record(z.number()).default({}), note: z.string().optional() }).strict())
              .optional()
          })
          .strict()
          .optional(),
        /**
         * Simultaneous drivers: `breathe` is the breathing scale (a bone
         * and its peak x/y factors); the final-runtime pose set adds every combined pose with it too.
         */
        combined: z.object({ breathe: z.object({ bone: z.string(), x: z.number().positive(), y: z.number().positive() }).strict().optional() }).strict().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type SurfacePreset = z.output<typeof surfacePresetSchema>;
export type Box = z.output<typeof box>;
export type Anchor = z.output<typeof anchor>;
export type ContourSpec = z.output<typeof contour>;
export type Fill = z.output<typeof fill>;
export type Patch = z.output<typeof patch>;
export type Bend = z.output<typeof bend>;
export type Junction = z.output<typeof junction>;
export type Sheet = z.output<typeof sheet>;
export type Assembly = z.output<typeof assembly>;

export function loadPreset(file: string): SurfacePreset {
  return surfacePresetSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
