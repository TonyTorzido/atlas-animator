/*
 * Atlas Animator: original implementation.
 *
 * The `atlas-anim@1` document schema (packages/animator/README.md).
 *
 * One document describes one rig: canvas, bones, slots, skins with their attachments, constraints,
 * driven keys, events, clips and atlas pages. Coordinates are canvas pixels with y down; angles are
 * degrees, clockwise positive. This file holds the structural schema only. Cross references (does
 * this bone exist, is that key inside the clip) live in formatReferences.ts, and loading,
 * versioning and migrations live in formatLoader.ts.
 *
 * Deliberately absent (plan section 1 skip list): path constraints/attachments, tint-black,
 * multiply/screen blends, inherit keys. Clipping, bounding-box attachments and image sequences
 * arrived with Batch 12a.
 *
 * Joint-ready body (plan Phase, all optional so older documents load unchanged): mesh `groups`
 * (draw groups as triangle partitions of one skinned mesh), skin `contours` (stroke centrelines
 * bound to a mesh or to bones, stroked after deformation), skin `coverage` (named triangle regions
 * and the regions an item covers) and `drivenGrids` (two-driver corrective grids).
 */
import { outlineProblem } from "./opaqueOutline.js";
import { z } from "zod";

export const FORMAT_NAME = "atlas-anim";
export const FORMAT_VERSION = 1;
export const FORMAT_ID = `${FORMAT_NAME}@${FORMAT_VERSION}` as const;

/** Most bone influences one mesh vertex may have (plan 3, Skinning). */
export const MAX_VERTEX_INFLUENCES = 4;

/** Most centreline points one contour may have. */
export const MAX_CONTOUR_POINTS = 256;

/**
 * Most keys (columns x rows) of one two-driver corrective grid: 4 x 3 by default (plan 4d); a grid
 * whose smooth target a 4 x 3 lattice cannot hold may grow to 6 x 5 when its preset declares it
 * (pass 3d-1).
 */
export const MAX_GRID_KEYS = 30;
export const MAX_GRID_AXIS_KEYS = 6;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const finite = () => z.number().finite();
const nonNegative = () => finite().nonnegative();
const unit = () => finite().min(0).max(1);
const index = () => z.number().int().nonnegative();

/**
 * Names of bones, slots, skins, constraints, attachments, clips and events. Restricted so that
 * names are safe inside JSON pointers, file names and command arguments.
 */
export const nameSchema = z
  .string()
  .min(1, "must not be empty")
  .max(64, "must be at most 64 characters")
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "may only use letters, digits, '_', '-' and '.', and must not start with '-' or '.'");

/** Texture path inside the atlas, e.g. "body/torso". */
export const texturePathSchema = z
  .string()
  .min(1, "must not be empty")
  .max(200, "must be at most 200 characters")
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/, "may only use letters, digits, '_', '-', '.' and '/'");

/** RGBA colour as 8 hex digits, e.g. "ffffffff". */
export const colorSchema = z.string().regex(/^[0-9a-fA-F]{8}$/, "must be 8 hex digits (rrggbbaa)");

export const WHITE = "ffffffff";

// ---------------------------------------------------------------------------------------------
// Canvas and bones
// ---------------------------------------------------------------------------------------------

export const canvasSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Canvas pixel where the skeleton origin (root bone space (0, 0)) sits. */
    originX: finite(),
    originY: finite()
  })
  .strict();

export const INHERIT_MODES = ["normal", "onlyTranslation", "noRotation", "noScale", "noScaleOrReflection"] as const;
export const inheritSchema = z.enum(INHERIT_MODES);
export type InheritMode = z.infer<typeof inheritSchema>;

/**
 * Rotation limits in degrees, relative to the bone's setup rotation. The posed local rotation is
 * clamped to [setup + min, setup + max] before the world transform is built.
 */
export const limitsSchema = z
  .object({ min: finite().min(-360).max(360), max: finite().min(-360).max(360) })
  .strict()
  .superRefine((limits, ctx) => {
    if (limits.min > limits.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "min must not be greater than max" });
    } else if (limits.max - limits.min > 360) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "limits must span at most 360 degrees" });
    }
  });

export const boneSchema = z
  .object({
    name: nameSchema,
    /** Parent bone name; must appear earlier in the list. Omitted for roots. */
    parent: nameSchema.optional(),
    length: nonNegative().default(0),
    x: finite().default(0),
    y: finite().default(0),
    rotation: finite().default(0),
    scaleX: finite().default(1),
    scaleY: finite().default(1),
    shearX: finite().default(0),
    shearY: finite().default(0),
    inherit: inheritSchema.default("normal"),
    limits: limitsSchema.optional(),
    /**
     * Semantic role for rig-agnostic review poses: spine, limb, head, tail or other.
     * Inherited by descendants that declare none; omitted = inferred from the hierarchy.
     */
    role: z.enum(["spine", "limb", "head", "tail", "other"]).optional(),
    /** Skin bone: active only while a skin that lists it (or a descendant) is active. */
    skin: z.boolean().default(false),
    /** Editor only: the bone overlay colour (rrggbbaa). Never read by the runtime. */
    color: colorSchema.optional(),
    /** Editor only: a helper bone (IK or constraint target, guide), dimmed or hidden in the editor overlay. Never read by the runtime. */
    helper: z.boolean().optional()
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

export const BLEND_MODES = ["normal", "additive"] as const;
export const blendSchema = z.enum(BLEND_MODES);

/** The slot fields, before the anchor rule (skin documents refine this differently). */
export const slotObjectSchema = z
  .object({
    name: nameSchema,
    bone: nameSchema,
    color: colorSchema.default(WHITE),
    blend: blendSchema.default("normal"),
    /** Attachment placeholder shown in the setup pose; null or omitted shows nothing. */
    attachment: nameSchema.nullable().default(null),
    /**
     * Anchored slot: drawn directly after (before) this slot wherever draw-order changes move it,
     * in slot order among slots with the same anchor; it has no draw position of its own (plan
     * 4.4, anchored slots). At most one of drawAfter and drawBefore.
     */
    drawAfter: nameSchema.optional(),
    drawBefore: nameSchema.optional()
  })
  .strict();

export const slotSchema = slotObjectSchema.superRefine((slot, ctx) => {
  if (slot.drawAfter !== undefined && slot.drawBefore !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawBefore"], message: "give at most one of 'drawAfter' and 'drawBefore'" });
  }
});

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

/** Triangle ranges `[start, end)` in triangle numbers (triangle t uses indices 3t..3t+2). */
export const triangleRangesSchema = z.array(z.tuple([index(), index()]));

/** Most frames one image sequence may have. */
export const MAX_SEQUENCE_FRAMES = 256;

/**
 * Image sequence (Spine 4.x `sequence`): a region or mesh shows `count` images named
 * `path` + the frame number (start + i) zero-padded to `digits`. `setup` is the frame shown when no
 * sequence key is in effect.
 */
export const sequenceSchema = z
  .object({
    count: z.number().int().min(1).max(MAX_SEQUENCE_FRAMES),
    start: z.number().int().min(0).default(1),
    digits: z.number().int().min(0).max(8).default(0),
    setup: z.number().int().min(0).default(0)
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.setup >= s.count) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["setup"], message: `setup frame ${s.setup} is outside the ${s.count} frames` });
  });

export const regionAttachmentSchema = z
  .object({
    type: z.literal("region"),
    path: texturePathSchema,
    sequence: sequenceSchema.optional(),
    /** Centre of the image in the slot bone's local space. */
    x: finite().default(0),
    y: finite().default(0),
    rotation: finite().default(0),
    scaleX: finite().default(1),
    scaleY: finite().default(1),
    width: finite().positive(),
    height: finite().positive(),
    color: colorSchema.default(WHITE),
    /**
     * Clothing model (close): the outline of the image's opaque area as u, v pairs in
     * 0..1 of the image (u right, v down): a simple polygon, either winding, convex or concave
     * (ear-clipped; core/opaqueOutline.ts). A rigid plate covers (trims) the strokes under this
     * polygon instead of under its whole rectangle. Absent: the rectangle. Incomplete pairs, fewer
     * than 3 vertices, zero area or self-intersection are errors.
     */
    opaque: z
      .array(unit())
      .optional()
      .superRefine((points, ctx) => {
        const problem = points ? outlineProblem(points) : null;
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `opaque outline: ${problem}` });
      })
  })
  .strict();

/**
 * A triangle mesh. `uvs` holds 2 values per vertex in 0..1 of the image; the first `hull`
 * vertices are the outline in order.
 *
 * `vertices` has two encodings:
 * - unweighted (no `bones`): 2 values per vertex, the position in the slot bone's local space;
 * - weighted (`bones` present): per vertex `n` followed by n groups of
 *   `(influence, x, y, weight)`, where `influence` indexes this mesh's `bones` table and (x, y) is
 *   the bind position in that bone's local space. 1 <= n <= MAX_VERTEX_INFLUENCES.
 * A mesh-local bone table keeps the encoding stable when bones are added or reordered elsewhere.
 */
export const meshAttachmentSchema = z
  .object({
    type: z.literal("mesh"),
    path: texturePathSchema,
    sequence: sequenceSchema.optional(),
    uvs: z.array(unit()),
    triangles: z.array(index()),
    vertices: z.array(finite()),
    bones: z.array(nameSchema).min(1).optional(),
    hull: index(),
    /** Editor-only edge pairs (vertex indices). */
    edges: z.array(index()).optional(),
    /**
     * Draw groups: slot -> triangle ranges `[start, end)` (triangle numbers, not index offsets).
     * The ranges of all groups partition the triangle list exactly. The mesh is skinned once and
     * each group draws its triangles at its slot's draw-order position, so boundary vertices,
     * weights, UVs and correctives are shared by construction (plan 4d, draw groups). The slot
     * holding the mesh draws only its own group (or nothing when it has none). Linked meshes of a
     * grouped mesh draw whole, in their own slot.
     */
    groups: z.record(nameSchema, triangleRangesSchema.min(1)).optional(),
    /**
     * Embedded vertices (garments that lie on a skin): each vertex in `vertices` is
     * posed as `points[i]` of another mesh of the same skin (`slot`/`attachment`), a vertex index
     * or `[a, b, c, wa, wb]` = wa * a + wb * b + (1 - wa - wb) * c of that mesh's posed vertices
     * (deform and correctives included), so it moves bit for bit with the surface under it. The
     * weights may extend slightly past the triangle (a trim lying a pixel or two past the skin
     * edge). The vertex's own weights stay as the fallback for tools that do not pose meshes.
     */
    embed: z
      .object({
        slot: nameSchema,
        attachment: nameSchema,
        vertices: z.array(index()).min(1),
        points: z.array(z.union([index(), z.tuple([index(), index(), index(), finite().min(-2).max(3), finite().min(-2).max(3)])])),
        /**
         * Boundary offset vertices (the body-derived garment margin): vertex
         * `vertices[i]` is posed after the embedded ones as `points[i]` = [anchor, prev, next, d]:
         * the anchor's posed position moved by d (world units) along the outward miter normal of
         * the posed boundary polyline prev -> anchor -> next (prev or next = anchor at a branch
         * end), bounded at OFFSET_MITER_LIMIT (core/skinning.ts). anchor, prev and next are
         * embedded vertices of this mesh. Positive d is right of the walk direction (y-up world).
         */
        offsets: z
          .object({
            vertices: z.array(index()).min(1),
            points: z.array(z.tuple([index(), index(), index(), finite()]))
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    width: finite().positive(),
    height: finite().positive(),
    color: colorSchema.default(WHITE)
  })
  .strict();

export interface MeshSource {
  skin: string;
  slot: string;
  attachment: string;
}

/**
 * Shares the vertices, triangles, UVs and weights of a source mesh but draws its own texture.
 * This is how swag rides the body: a tunic's torso piece is a linked mesh of the body torso.
 */
export const linkedMeshAttachmentSchema = z
  .object({
    type: z.literal("linkedMesh"),
    path: texturePathSchema,
    sequence: sequenceSchema.optional(),
    source: z.object({ skin: nameSchema, slot: nameSchema, attachment: nameSchema }).strict(),
    /** Deform keys and driven deforms made for the source also move this mesh. */
    inheritDeform: z.boolean().default(true),
    width: finite().positive(),
    height: finite().positive(),
    color: colorSchema.default(WHITE)
  })
  .strict();

/** A named position and direction on the slot bone (weapon grip, tool tip, FX socket). */
export const pointAttachmentSchema = z
  .object({
    type: z.literal("point"),
    x: finite().default(0),
    y: finite().default(0),
    rotation: finite().default(0),
    color: colorSchema.default(WHITE)
  })
  .strict();

/** Polygon vertices as x, y pairs in the slot bone's space (at least a triangle). */
const polygonVerticesSchema = z.array(finite()).superRefine((v, ctx) => {
  if (v.length % 2 !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "vertices are x, y pairs: an odd number of values" });
  else if (v.length < 6) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a polygon needs at least 3 points (6 values)" });
  else if (v.length > 2 * 256) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a polygon may have at most 256 points" });
});

/**
 * A clipping mask (Spine clipping): while drawing, the slots after this one up to and including
 * `end` (or all later slots in draw order when `end` is omitted) are cut to the polygon. Vertices
 * are in the slot bone's space; the polygon should be convex (concave ones are triangulated).
 */
export const clippingAttachmentSchema = z
  .object({
    type: z.literal("clipping"),
    vertices: polygonVerticesSchema,
    /** Last slot the mask applies to; omitted = the end of the draw order. */
    end: nameSchema.optional(),
    color: colorSchema.default("ce3a3aff")
  })
  .strict();

/** A hit box (Spine bounding box): never drawn; the runtime answers point-in-polygon queries. */
export const boundingBoxAttachmentSchema = z
  .object({
    type: z.literal("boundingbox"),
    vertices: polygonVerticesSchema,
    color: colorSchema.default("60f000ff")
  })
  .strict();

/**
 * A path (Spine path): a cubic bezier spline a path constraint moves bones along. `vertices` holds,
 * per control point, three vertices in this order: handle in, point, handle out (so an open path
 * of n curves has n + 1 control points and 3 * (n + 1) vertices, its first handle in and last handle
 * out being unused anchors the editor still shows; a closed path of n curves has n control points).
 * Unweighted: 2 values per vertex in the slot bone's space. Weighted (`bones` present): the mesh
 * encoding, per vertex a count then (influence, x, y, weight) groups, `influence` indexing `bones`.
 */
export const pathAttachmentSchema = z
  .object({
    type: z.literal("path"),
    closed: z.boolean().default(false),
    /** True = bones move at an even speed along the curve; false = by curve parameter (cheaper, uneven). */
    constantSpeed: z.boolean().default(true),
    /** Vertices (3 per control point), not values. */
    vertexCount: z.number().int().min(6).max(3 * 256),
    vertices: z.array(finite()),
    bones: z.array(nameSchema).min(1).optional(),
    color: colorSchema.default("ff7f00ff")
  })
  .strict();

/** Structure checks of a path attachment (run by attachmentSchema; a discriminated union takes no effects). */
function checkPathStructure(
  path: { closed: boolean; vertexCount: number; vertices: number[]; bones?: string[] | undefined },
  ctx: z.RefinementCtx
): void {
  {
    const issue = (message: string, at: (string | number)[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: at, message });
    if (path.vertexCount % 3 !== 0) issue(`vertexCount ${path.vertexCount} must be a multiple of 3 (handle in, point, handle out per control point)`, ["vertexCount"]);
    const points = path.vertexCount / 3;
    if (points < (path.closed ? 3 : 2)) issue(`a ${path.closed ? "closed" : "open"} path needs at least ${path.closed ? 3 : 2} control points (got ${points})`, ["vertexCount"]);
    if (!path.bones) {
      if (path.vertices.length !== path.vertexCount * 2) issue(`unweighted vertices hold 2 values per vertex: expected ${path.vertexCount * 2}, got ${path.vertices.length}`, ["vertices"]);
    } else {
      const scan = scanWeightedVertices(path.vertices, path.vertexCount, path.bones.length);
      if (!scan.ok) issue(scan.message, ["vertices", scan.at]);
    }
  }
}

export const attachmentSchema = z
  .discriminatedUnion("type", [
    regionAttachmentSchema,
    meshAttachmentSchema,
    linkedMeshAttachmentSchema,
    pointAttachmentSchema,
    clippingAttachmentSchema,
    boundingBoxAttachmentSchema,
    pathAttachmentSchema
  ])
  .superRefine((attachment, ctx) => {
    if (attachment.type === "mesh") checkMeshStructure(attachment, ctx);
    else if (attachment.type === "path") checkPathStructure(attachment, ctx);
  });

// ---------------------------------------------------------------------------------------------
// Contours (dynamic outlines) and coverage regions
// ---------------------------------------------------------------------------------------------

/**
 * A contour centreline point bound to a mesh: a vertex index, or `[a, b, c, wa, wb]`, the
 * barycentric point wa * a + wb * b + (1 - wa - wb) * c of three vertices (follows the deformed
 * mesh exactly: a posed-triangle embedding, not re-bound weights).
 */
export const contourPointSchema = z.union([index(), z.tuple([index(), index(), index(), unit(), unit()])], {
  errorMap: () => ({ message: "must be a vertex index or [a, b, c, wa, wb] (three vertex indices and two barycentric weights)" })
});

export const CONTOUR_CAPS = ["round", "butt"] as const;

/** Visible while the bone's driver value (as for driven keys) is in [min, max]. */
export const contourVisibilitySchema = z
  .object({ bone: nameSchema, min: finite().min(-360).max(360), max: finite().min(-360).max(360) })
  .strict()
  .refine((rule) => rule.min <= rule.max, { message: "min must not be greater than max", path: ["min"] });

/**
 * A dynamic outline (plan 4d, dynamic contours): a centreline deformed with the body and stroked
 * after deformation with round joins and one coverage-ramp anti-aliasing, so its width stays
 * constant however the skin bends. Stored under skins[skin].contours[owner slot][name]; the user
 * slot gives the draw position (drawn just above the slot's own drawing), colour and visibility.
 *
 * Binding, exactly one of:
 * - `mesh` + `points`: points on a mesh's deformed vertices (vertex refs or barycentric points);
 *   `mesh.skin` defaults to the contour's skin;
 * - `bones` + `vertices`: the mesh weighted encoding (per point `n` then n groups of
 *   `(boneIndex, x, y, weight)`).
 * `width` is the full stroke width in canvas pixels. Every `visible` rule must hold. `extend`
 * ([start, end], canvas px, open contours only) prolongs the centreline past its first and last
 * bound point along the posed end tangent, so an end can meet another stroke with overlap.
 * Ownership (part c): a contour draws only while its owning attachment is displayed:
 * `owner` (skin defaults to the contour's skin), else the bound mesh (`mesh`); a bone-bound contour
 * without `owner` has no attachment gate. Displayed = the slot is not hidden and currently shows
 * that attachment (or, for a mesh, a mesh sharing its deform: a linked mesh of it). So hiding or
 * swapping a garment hides its outlines in the same frame, and the slot's attachment is the only
 * switch (an outfit change or attachment key switches the outline sets atomically).
 */
export const contourSchema = z
  .object({
    mesh: z.object({ skin: nameSchema.optional(), slot: nameSchema, attachment: nameSchema }).strict().optional(),
    points: z.array(contourPointSchema).optional(),
    bones: z.array(nameSchema).min(1).optional(),
    vertices: z.array(finite()).optional(),
    closed: z.boolean().default(false),
    width: finite().positive(),
    color: colorSchema.default("000000ff"),
    caps: z.enum(CONTOUR_CAPS).default("round"),
    extend: z.tuple([finite().min(0), finite().min(0)]).optional(),
    visible: z.array(contourVisibilitySchema).default([]),
    owner: z.object({ skin: nameSchema.optional(), slot: nameSchema, attachment: nameSchema }).strict().optional(),
    /**
     * Clothing model: the stroke is trimmed by pieces drawn after this slot instead of after its
     * owner slot (a limb joint handed to the later limb's contour keeps being
     * trimmed by what covers the earlier limb, e.g. a sleeve piece drawn between the two).
     */
    coverFrom: nameSchema.optional(),
    /**
     * Arm layer (closing edge over an under-sheet): the stroke is also trimmed where this slot covers
     * its centreline, although that slot draws before the user. A shoulder cap's closing edge is
     * then inked only where it leaves the torso sheet (buried: no line; exposed: the silhouette).
     */
    coverUnder: nameSchema.optional(),
    /**
     * Arm layer: mesh coverers trim this stroke only where its centreline is under them (no
     * half-width reach along their edge), so an under-sheet's outline runs full ink up to where the
     * arm's closing edge takes over (no feathered notch at the shoulder hand-off).
     */
    coverTight: z.boolean().optional(),
    /**
     * Clothing model (armour): a rigid coverer (a region: the head, a fist, a plate) trims
     * this stroke only where its centreline lies under the coverer's opaque outline, without the
     * half-width reach along that outline that body lines get (core/coverage.ts). For strokes that
     * ink a garment's own fill edge: the fill reaches the centreline, so a stroke trimmed while its
     * centreline is still outside the plate leaves bare fabric against the background (the cuff
     * corner under the chin). The plate drawn after it hides whatever ink lies under it.
     */
    trimAtOutline: z.boolean().optional()
  })
  .strict()
  .superRefine((contour, ctx) => checkContourStructure(contour, ctx));

/** A named set of triangles of one mesh of the same skin (a body region an item may cover). */
export const coverageRegionSchema = z
  .object({
    mesh: z.object({ slot: nameSchema, attachment: nameSchema }).strict(),
    triangles: triangleRangesSchema.min(1)
  })
  .strict();

/**
 * Coverage (plan 4d, swag coverage): the regions a skin declares on its own meshes, and the
 * regions (of any skin, normally the body) this skin covers opaquely while active. Format only in
 *; the equipment-coverage gate that reads it is.
 */
export const coverageSchema = z
  .object({
    regions: z.record(nameSchema, coverageRegionSchema).default({}),
    covers: z.array(z.object({ skin: nameSchema, region: nameSchema }).strict()).default([])
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------------------------

export const skinSchema = z
  .object({
    /** slot name -> placeholder name -> attachment. */
    attachments: z.record(nameSchema, z.record(nameSchema, attachmentSchema)).default({}),
    /** Slots this skin hides while active (a helmet hides "hair"). */
    hides: z.array(nameSchema).default([]),
    /** Skin bones this skin activates (their parent chains activate with them). */
    bones: z.array(nameSchema).default([]),
    /** Skin constraints this skin activates. */
    constraints: z.array(nameSchema).default([]),
    /** owner slot -> contour name -> contour (dynamic outlines). */
    contours: z.record(nameSchema, z.record(nameSchema, contourSchema)).optional(),
    /**
     * Contour contacts (closeout): pairs of this skin's contours (owner slot + name) drawn as
     * one merged line where they touch. Where the two run near-parallel (within `angle` degrees) with
     * an ink gap under `gap` canvas px, each centreline moves toward the other so the inks overlap by
     * `overlap` (default `gap`): no background sliver, no sub-pixel seam (contours.ts applyContact).
     */
    contourContacts: z
      .array(
        z
          .object({
            a: z.object({ slot: nameSchema, name: nameSchema }).strict(),
            b: z.object({ slot: nameSchema, name: nameSchema }).strict(),
            gap: finite().positive(),
            angle: finite().positive().max(90).default(15),
            overlap: finite().min(0).optional(),
            /** Minimum merged run length (canvas px; default 2 x gap) and taper length (default gap). */
            minRun: finite().min(0).optional(),
            taper: finite().min(0).optional()
          })
          .strict()
      )
      .optional(),
    /**
     * Contour joins: pairs of open contour ends that read as one line across a
     * joint where the two ride different bones (a limb stroke cut by a rigid region and the region's
     * own outline continuing it). Per frame (contours.ts applyJoin): where the two centrelines cross
     * within `reach` canvas px of the ends (the inner side of a bend), both are cut at the crossing;
     * otherwise (the outer side) the first `reach` px of `b` are redrawn as a curve leaving `a`'s end
     * along its tangent and landing on `b` along its own. No gap, no tick, no doubled ends.
     */
    contourJoins: z
      .array(
        z
          .object({
            a: z.object({ slot: nameSchema, name: nameSchema, end: z.enum(["start", "end"]) }).strict(),
            b: z.object({ slot: nameSchema, name: nameSchema, end: z.enum(["start", "end"]) }).strict(),
            reach: finite().positive()
          })
          .strict()
      )
      .optional(),
    coverage: coverageSchema.optional()
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------

/** Kind default when `order` is omitted. */
export const DEFAULT_CONSTRAINT_ORDER = { ik: 0, transform: 1, path: 2, physics: 3 } as const;

/**
 * Execution position. Constraints run sorted by (order, kind: ik < transform < physics, list
 * index); omitted = DEFAULT_CONSTRAINT_ORDER for the kind, so by default all IK runs first, then
 * transform, then physics. A transform constraint that places an IK target uses order -1.
 */
const constraintOrder = () => z.number().int().min(-1000).max(1000).optional();

/** Two-bone (or one-bone) inverse kinematics. With two bones, bones[1] must be a child of bones[0]. */
export const ikConstraintSchema = z
  .object({
    name: nameSchema,
    bones: z.array(nameSchema).min(1).max(2),
    target: nameSchema,
    bendPositive: z.boolean().default(true),
    mix: unit().default(1),
    softness: nonNegative().default(0),
    stretch: z.boolean().default(false),
    compress: z.boolean().default(false),
    uniform: z.boolean().default(false),
    order: constraintOrder(),
    skin: z.boolean().default(false)
  })
  .strict();

export const transformOffsetSchema = z
  .object({
    rotation: finite().default(0),
    x: finite().default(0),
    y: finite().default(0),
    scaleX: finite().default(0),
    scaleY: finite().default(0),
    shearY: finite().default(0)
  })
  .strict();

/** Copies (a mix of) the target bone's transform onto the constrained bones. */
export const transformConstraintSchema = z
  .object({
    name: nameSchema,
    bones: z.array(nameSchema).min(1),
    target: nameSchema,
    local: z.boolean().default(false),
    relative: z.boolean().default(false),
    offset: transformOffsetSchema.default({}),
    mixRotate: unit().default(1),
    mixX: unit().default(1),
    mixY: unit().default(1),
    mixScaleX: unit().default(1),
    mixScaleY: unit().default(1),
    mixShearY: unit().default(1),
    order: constraintOrder(),
    skin: z.boolean().default(false)
  })
  .strict();

export const PATH_POSITION_MODES = ["fixed", "percent"] as const;
export const PATH_SPACING_MODES = ["length", "fixed", "percent", "proportional"] as const;
export const PATH_ROTATE_MODES = ["tangent", "chain", "chainScale"] as const;
export type PathPositionMode = (typeof PATH_POSITION_MODES)[number];
export type PathSpacingMode = (typeof PATH_SPACING_MODES)[number];
export type PathRotateMode = (typeof PATH_ROTATE_MODES)[number];

/**
 * Places the constrained bones along the path attachment shown by the target slot (Spine path
 * constraint). `position` is a distance along the path (fixed) or a 0..1 share of its length
 * (percent); `spacing` is the gap between bones (length: added to each bone's length, fixed:
 * a distance, percent: a share of the path, proportional: bones share the path by length).
 */
export const pathConstraintSchema = z
  .object({
    name: nameSchema,
    bones: z.array(nameSchema).min(1),
    /** Slot whose current attachment is the path. */
    target: nameSchema,
    positionMode: z.enum(PATH_POSITION_MODES).default("percent"),
    spacingMode: z.enum(PATH_SPACING_MODES).default("length"),
    rotateMode: z.enum(PATH_ROTATE_MODES).default("tangent"),
    offsetRotation: finite().default(0),
    position: finite().default(0),
    spacing: finite().default(0),
    mixRotate: unit().default(1),
    mixX: unit().default(1),
    mixY: unit().default(1),
    order: constraintOrder(),
    skin: z.boolean().default(false)
  })
  .strict();

/** Spring physics on one bone (capes, hair, skirts, pouches). Cosmetic, never networked. */
export const physicsConstraintSchema = z
  .object({
    name: nameSchema,
    bone: nameSchema,
    /** How much each channel follows the simulation, 0..1. */
    x: unit().default(0),
    y: unit().default(0),
    rotate: unit().default(0),
    scaleX: unit().default(0),
    shearX: unit().default(0),
    inertia: unit().default(1),
    strength: nonNegative().default(100),
    damping: unit().default(1),
    mass: finite().positive().default(1),
    wind: finite().default(0),
    gravity: finite().default(0),
    mix: unit().default(1),
    /** Largest bone movement per second fed into the simulation (teleport guard). */
    limit: nonNegative().default(5000),
    /** Fixed simulation rate in steps per second. */
    fps: z.number().int().min(1).max(240).default(60),
    order: constraintOrder(),
    skin: z.boolean().default(false)
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Deform data, draw-order changes and driven keys
// ---------------------------------------------------------------------------------------------

/**
 * Sparse vertex offsets, added to the mesh's bind data starting at float `offset` (2 floats per
 * vertex for unweighted meshes, 2 floats per influence for weighted ones). Floats outside the
 * range are offset by 0.
 */
export const deformValuesSchema = z
  .object({ offset: index().default(0), vertices: z.array(finite()) })
  .strict();

/** skin -> slot -> attachment -> T, the address of one mesh attachment. */
const byAttachment = <T extends z.ZodTypeAny>(value: T) =>
  z.record(nameSchema, z.record(nameSchema, z.record(nameSchema, value)));

/** Moves a slot `offset` places from its setup draw-order position (positive = drawn later). */
export const drawOrderOffsetSchema = z.object({ slot: nameSchema, offset: z.number().int() }).strict();

export const DRIVEN_CHANNELS = ["rotation"] as const;

export const drivenKeySchema = z
  .object({
    /**
     * Driver value in degrees: the bone's applied rotation minus its setup rotation (raw when the
     * bone has limits, else wrapped to (-180, 180]).
     */
    at: finite().min(-360).max(360),
    deform: byAttachment(deformValuesSchema).default({}),
    drawOrder: z.array(drawOrderOffsetSchema).default([]),
    /** slot -> placeholder shown (null hides the slot) while the driver is at or past this key. */
    attachments: z.record(nameSchema, nameSchema.nullable()).default({}),
    /**
     * slot -> opacity 0..1, blended between keys like deform (a key that does not name a slot
     * gives it 1); multiplies the slot colour's alpha after driven evaluation. Fades generated
     * joint pieces (the crotch gusset) in with a joint angle.
     */
    alpha: z.record(nameSchema, unit()).default({})
  })
  .strict();

/** Corrections keyed to a bone angle instead of time; they apply under every clip. */
export const drivenSchema = z
  .object({
    name: nameSchema,
    bone: nameSchema,
    channel: z.enum(DRIVEN_CHANNELS).default("rotation"),
    /** Skin gate: the set applies only while this skin is active (swag that brings its own fixes). */
    skin: nameSchema.optional(),
    /**
     * OR group of the set's alpha: sets naming the same group multiply into that group, and a slot
     * takes the largest of its groups (any group can show it), times the plain sets' product. A
     * stroke fader shown either by the arm raised across the body or by the forearm folded inward.
     */
    alphaOr: nameSchema.optional(),
    keys: z.array(drivenKeySchema).min(1)
  })
  .strict()
  .superRefine((driven, ctx) => {
    for (let i = 1; i < driven.keys.length; i++) {
      const previous = driven.keys[i - 1];
      const current = driven.keys[i];
      if (previous && current && !(current.at > previous.at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["keys", i, "at"],
          message: `keys must be sorted by strictly increasing 'at' (${current.at} after ${previous.at})`
        });
      }
    }
  });

const gridAxisSchema = z
  .object({ bone: nameSchema, at: z.array(finite().min(-360).max(360)).min(2).max(MAX_GRID_AXIS_KEYS) })
  .strict()
  .superRefine((axis, ctx) => {
    for (let i = 1; i < axis.at.length; i++) {
      if (!((axis.at[i] as number) > (axis.at[i - 1] as number))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["at", i], message: "'at' must be strictly increasing" });
      }
    }
  });

/**
 * A combination corrective (plan 4d): deform keyed on a grid of two bones' driver values (e.g.
 * shoulder raise x shrug), blended bilinearly and held at the edges. `keys` is row-major: the key
 * at (x.at[i], y.at[j]) is keys[j * x.at.length + i]. Evaluated with the driven keys, after IK,
 * constraints and limits; its deform adds to theirs. At most MAX_GRID_KEYS keys.
 */
export const drivenGridSchema = z
  .object({
    name: nameSchema,
    skin: nameSchema.optional(),
    x: gridAxisSchema,
    y: gridAxisSchema,
    keys: z.array(z.object({ deform: byAttachment(deformValuesSchema).default({}) }).strict())
  })
  .strict()
  .superRefine((grid, ctx) => {
    const count = grid.x.at.length * grid.y.at.length;
    if (count > MAX_GRID_KEYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["y", "at"], message: `a grid has at most ${MAX_GRID_KEYS} keys (got ${grid.x.at.length} x ${grid.y.at.length})` });
    }
    if (grid.keys.length !== count) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["keys"], message: `needs ${count} keys (${grid.x.at.length} x ${grid.y.at.length}, row-major), got ${grid.keys.length}` });
    }
  });

/**
 * Combined pose limits (pass 3d-1): a convex polygon in the driver space of two bones
 * (their driver values in degrees, as for driven keys). Authoring and validation data only: the
 * validator flags clip poses outside any polygon; the runtime never clamps to it.
 */
/**
 * A contact band (closeout): grid cells of a driver plane where two contours pass within
 * one display pixel; motion may cross it, holds and keys may not sit in it (authoring data only).
 */
export const contactBandSchema = z
  .object({
    name: nameSchema,
    x: nameSchema,
    y: nameSchema,
    size: z.tuple([finite(), finite()]),
    cells: z.array(z.tuple([finite(), finite()])),
    /**
     * Measurement condition: the other drivers' ranges (degrees) the band was measured over. The
     * band is known only there; a pose outside the condition is not covered by it.
     */
    when: z.record(nameSchema, z.tuple([finite(), finite()])).optional(),
    /**
     * The contour pair the band was measured between (each `ownerSlot/name`, part c):
     * the band gates a pose only while both contours draw (a hidden garment's band does not fire).
     */
    contours: z.tuple([z.string().min(1), z.string().min(1)]).optional()
  })
  .strict();

export const poseLimitSchema = z
  .object({
    name: nameSchema,
    x: nameSchema,
    y: nameSchema,
    /**
     * Drivers whose values add to y (part b): the limit's y coordinate is y plus each of
     * these (degrees), so one polygon bounds a combined lean (neck + head against a raised arm).
     */
    plus: z.array(nameSchema).min(1).optional(),
    polygon: z.array(z.tuple([finite(), finite()])).min(3)
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export const eventDefinitionSchema = z
  .object({ int: z.number().int().default(0), float: finite().default(0), string: z.string().default(""), audio: z.string().default("") })
  .strict();

// ---------------------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------------------

/**
 * Interpolation from a key to the next one. Bezier control points are normalised like CSS
 * cubic-bezier: x is the fraction of the time span (0..1, so time stays monotonic), y is the
 * fraction of the value change (may overshoot).
 */
const bezierX = () =>
  finite().min(0, "Bezier x control points must be in 0..1").max(1, "Bezier x control points must be in 0..1");

export const curveSpecSchema = z.union(
  [z.literal("linear"), z.literal("stepped"), z.tuple([bezierX(), finite(), bezierX(), finite()])],
  { errorMap: () => ({ message: 'must be "linear", "stepped" or [cx1, cy1, cx2, cy2] with cx1 and cx2 in 0..1' }) }
);
export type CurveSpec = z.infer<typeof curveSpecSchema>;

/** A key's curve: one spec for every channel, or per channel by name. */
const curveFor = <const C extends readonly [string, ...string[]]>(channels: C) =>
  z.union(
    [
      curveSpecSchema,
      z
        .object(Object.fromEntries(channels.map((channel) => [channel, curveSpecSchema.optional()])) as {
          [K in C[number]]: z.ZodOptional<typeof curveSpecSchema>;
        })
        .strict()
    ],
    {
      errorMap: () => ({
        message: `must be "linear", "stepped", [cx1, cy1, cx2, cy2] (cx in 0..1), or an object of those per channel (${channels.join(", ")})`
      })
    }
  );

const keyTime = () => nonNegative();

/**
 * Keys of one continuous timeline (bone, slot color, IK, transform, physics mix, deform). An empty
 * array has no value to sample, so it is rejected (runtime contract F1): omit the timeline instead.
 * The compiler re-checks this for callers that bypass the loader (ContinuousTimeline).
 */
const continuousKeys = <T extends z.ZodTypeAny>(key: T) =>
  z.array(key).min(1, "a continuous timeline needs at least one key (omit the timeline instead)");

export const valueKeySchema = z
  .object({ time: keyTime(), value: finite(), curve: curveFor(["value"]).default("linear") })
  .strict();

export const vectorKeySchema = z
  .object({ time: keyTime(), x: finite(), y: finite(), curve: curveFor(["x", "y"]).default("linear") })
  .strict();

export const boneTimelinesSchema = z
  .object({
    rotate: continuousKeys(valueKeySchema).optional(),
    translate: continuousKeys(vectorKeySchema).optional(),
    scale: continuousKeys(vectorKeySchema).optional(),
    shear: continuousKeys(vectorKeySchema).optional()
  })
  .strict();

export const attachmentKeySchema = z.object({ time: keyTime(), name: nameSchema.nullable() }).strict();

export const SEQUENCE_MODES = ["hold", "once", "loop", "pingpong"] as const;
export type SequenceMode = (typeof SEQUENCE_MODES)[number];

/** From `time` on: play from frame `index` in `mode`, advancing one frame every `delay` seconds (0 = hold the frame). */
export const sequenceKeySchema = z
  .object({ time: keyTime(), mode: z.enum(SEQUENCE_MODES), index: z.number().int().min(0), delay: nonNegative().default(0) })
  .strict();

export const colorKeySchema = z
  .object({ time: keyTime(), color: colorSchema, curve: curveFor(["r", "g", "b", "a"]).default("linear") })
  .strict();

export const slotTimelinesSchema = z
  .object({ attachment: z.array(attachmentKeySchema).optional(), sequence: z.array(sequenceKeySchema).optional(), color: continuousKeys(colorKeySchema).optional() })
  .strict();

export const ikKeySchema = z
  .object({
    time: keyTime(),
    mix: unit().optional(),
    softness: nonNegative().optional(),
    bendPositive: z.boolean().optional(),
    stretch: z.boolean().optional(),
    compress: z.boolean().optional(),
    curve: curveFor(["mix", "softness"]).default("linear")
  })
  .strict();

export const transformKeySchema = z
  .object({
    time: keyTime(),
    mixRotate: unit().optional(),
    mixX: unit().optional(),
    mixY: unit().optional(),
    mixScaleX: unit().optional(),
    mixScaleY: unit().optional(),
    mixShearY: unit().optional(),
    curve: curveFor(["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"]).default("linear")
  })
  .strict();

export const pathKeySchema = z
  .object({
    time: keyTime(),
    position: finite().optional(),
    spacing: finite().optional(),
    mixRotate: unit().optional(),
    mixX: unit().optional(),
    mixY: unit().optional(),
    curve: curveFor(["position", "spacing", "mixRotate", "mixX", "mixY"]).default("linear")
  })
  .strict();

export const physicsTimelinesSchema = z
  .object({
    mix: continuousKeys(valueKeySchema).optional(),
    /** Snap the simulation back to the current pose at each key time. */
    reset: z.array(z.object({ time: keyTime() }).strict()).optional()
  })
  .strict();

export const deformKeySchema = z
  .object({
    time: keyTime(),
    offset: index().default(0),
    vertices: z.array(finite()),
    curve: curveFor(["value"]).default("linear")
  })
  .strict();

export const drawOrderKeySchema = z
  .object({ time: keyTime(), offsets: z.array(drawOrderOffsetSchema).default([]) })
  .strict();

export const eventKeySchema = z
  .object({
    time: keyTime(),
    name: nameSchema,
    int: z.number().int().optional(),
    float: finite().optional(),
    string: z.string().optional(),
    /** Sound name played with the event (a name the game or a runtime resolves; the editor keeps clip audio in the data folder). */
    audio: z.string().optional()
  })
  .strict();

/** Default held-frame playback rate of a clip. */
export const DEFAULT_CLIP_FPS = 30;

export const clipSchema = z
  .object({
    duration: nonNegative(),
    loop: z.boolean().default(false),
    /**
     * Held-frame playback rate (frames per second; DEFAULT_CLIP_FPS when absent). The pose cache
     * evaluates the clip at this rate and the display holds each pose; 12 and 8 are per-clip/LOD
     * options. The validator certifies the poses displayed at this rate.
     */
    fps: z.number().int().min(1).max(60).optional(),
    bones: z.record(nameSchema, boneTimelinesSchema).default({}),
    slots: z.record(nameSchema, slotTimelinesSchema).default({}),
    ik: z.record(nameSchema, continuousKeys(ikKeySchema)).default({}),
    transform: z.record(nameSchema, continuousKeys(transformKeySchema)).default({}),
    path: z.record(nameSchema, continuousKeys(pathKeySchema)).default({}),
    physics: z.record(nameSchema, physicsTimelinesSchema).default({}),
    deform: byAttachment(continuousKeys(deformKeySchema)).default({}),
    drawOrder: z.array(drawOrderKeySchema).default([]),
    events: z.array(eventKeySchema).default([])
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Atlas and document
// ---------------------------------------------------------------------------------------------

export const atlasSchema = z
  .object({
    pages: z.array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.png$/, "must be a .png file name")).min(1),
    /** Page pixels per canvas pixel (0.5 = pages are stored at half the canvas resolution). */
    scale: finite().positive().max(1)
  })
  .strict();

/**
 * Rig budgets: declared by the document (written from the body preset that built it,
 * or by hand for a mob); the validator uses them over its generic defaults. Vertex budgets have no
 * generic default (undeclared = not judged, with a warning). `chains`: summed one-way limits
 * between two bones (the chains check). `bend`: the cumulative bend cap per chain role, degrees,
 * that generated review poses respect (a spine is not posed at every joint's max at once).
 */
export const BEND_ROLES = ["spine", "limb", "head", "tail", "other"] as const;
export const budgetsSchema = z
  .object({
    bodyVertices: z.number().int().positive().optional(),
    itemVertices: z.number().int().positive().optional(),
    dressedVertices: z.number().int().positive().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    bones: z.number().int().positive().optional(),
    atlasPages: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
    chains: z.array(z.object({ from: nameSchema, to: nameSchema, budget: finite().positive() }).strict()).optional(),
    bend: z.object(Object.fromEntries(BEND_ROLES.map((role) => [role, finite().positive().optional()])) as Record<(typeof BEND_ROLES)[number], z.ZodOptional<z.ZodNumber>>).strict().optional()
  })
  .strict();
export type RigBudgetsData = z.output<typeof budgetsSchema>;

/**
 * Authoring metadata (tools/authoring.ts): explicit chains, deformation domains,
 * connection semantics and validation probes. Optional: without it, roles and chains are inferred
 * (a suggestion); with it, review poses, `weights.auto` and the validator follow it.
 */
export const CONNECTION_KINDS = ["welded", "overlap", "membrane"] as const;
export const PROBE_KINDS = ["rotate", "scale", "translate", "deform", "attachment", "wave", "relative"] as const;
const probeTarget = { name: nameSchema, bones: z.array(nameSchema).min(1).optional(), chain: nameSchema.optional() };
const probeSchema = z.discriminatedUnion("kind", [
  /** Each bone +-amount degrees (default 15). */
  z.object({ kind: z.literal("rotate"), ...probeTarget, amount: finite().optional() }).strict(),
  /** Bone scale: x/y factors, else amount on both (default 1.2). */
  z.object({ kind: z.literal("scale"), ...probeTarget, amount: finite().positive().optional(), x: finite().positive().optional(), y: finite().positive().optional() }).strict(),
  /** Bone translate by +-(x, y) px. */
  z.object({ kind: z.literal("translate"), ...probeTarget, x: finite().optional(), y: finite().optional() }).strict(),
  /** Squash/stretch at constant area by the factor amount (default 1.3). */
  z.object({ kind: z.literal("deform"), ...probeTarget, amount: finite().positive().optional() }).strict(),
  /** A slot shows another attachment (null hides it). */
  z.object({ kind: z.literal("attachment"), name: nameSchema, slot: nameSchema, attachment: nameSchema.nullable().optional() }).strict(),
  /** A travelling wave along a chain: amount degrees, steps poses, cycles along the chain. */
  z.object({ kind: z.literal("wave"), ...probeTarget, amount: finite().optional(), steps: z.number().int().min(1).max(64).optional(), cycles: finite().positive().max(8).optional() }).strict(),
  /** Two chains against each other by amount degrees. */
  z.object({ kind: z.literal("relative"), name: nameSchema, chains: z.tuple([nameSchema, nameSchema]), amount: finite().optional() }).strict()
]);
export const authoringSchema = z
  .object({
    chains: z
      .array(
        z
          .object({
            id: nameSchema,
            /** Root to tip, each bone the skeleton parent of the next. */
            bones: z.array(nameSchema).min(1),
            /** The chain this one branches from (the branch boundary). */
            parent: nameSchema.optional(),
            role: z.enum(BEND_ROLES).optional(),
            symmetry: nameSchema.optional(),
            /** Cumulative bend cap of this chain, degrees (over the role's). */
            bend: finite().positive().optional(),
            /** Review range each way for bones of this chain without limits, degrees. */
            range: finite().positive().max(180).optional()
          })
          .strict()
      )
      .optional(),
    domains: z
      .array(
        z
          .object({
            id: nameSchema,
            skin: nameSchema.optional(),
            slot: nameSchema,
            attachment: nameSchema.optional(),
            /** The bones allowed to influence the mesh. */
            bones: z.array(nameSchema).min(1),
            /** Transition width (px) of the joint between two bones (parent, child). */
            transitions: z.array(z.object({ bones: z.tuple([nameSchema, nameSchema]), width: finite().positive() }).strict()).optional(),
            /** Body radius per bone (px), over the measured one. */
            radius: z.record(nameSchema, finite().positive()).optional()
          })
          .strict()
      )
      .optional(),
    connections: z.array(z.object({ between: z.tuple([nameSchema, nameSchema]), kind: z.enum(CONNECTION_KINDS) }).strict()).optional(),
    /**
     * Declared joints between two slots (the validator's "joint opened" contact rule judges only
     * these and the pairs derived from welded/overlap connections). With `pivotBone` and `radius`
     * a ball-and-socket joint: contact is judged within `radius` of the pivot bone's origin.
     */
    joints: z.array(z.object({ parent: nameSchema, child: nameSchema, pivotBone: nameSchema.optional(), radius: finite().positive().optional() }).strict()).optional(),
    /** Validation probes, one shape per kind (tools/authoring.ts expands them into review poses). */
    probes: z.array(probeSchema).optional()
  })
  .strict();
export type AuthoringData = z.output<typeof authoringSchema>;

export const animDocumentSchema = z
  .object({
    format: z.literal(FORMAT_ID),
    name: nameSchema,
    /**
     * Rig revision, bumped when bones, slots or meshes change in a way swag must be re-checked
     * against. Skin documents name the revision they were made for (skinDocument.ts).
     */
    revision: z.number().int().positive().default(1),
    canvas: canvasSchema,
    bones: z.array(boneSchema).min(1, "a rig needs at least one bone"),
    slots: z.array(slotSchema).default([]),
    skins: z.record(nameSchema, skinSchema).default({}),
    /** Setup draw order, back to front. Omitted = slot list order. */
    drawOrder: z.array(nameSchema).optional(),
    ik: z.array(ikConstraintSchema).default([]),
    transform: z.array(transformConstraintSchema).default([]),
    path: z.array(pathConstraintSchema).default([]),
    physics: z.array(physicsConstraintSchema).default([]),
    driven: z.array(drivenSchema).default([]),
    drivenGrids: z.array(drivenGridSchema).optional(),
    poseLimits: z.array(poseLimitSchema).optional(),
    contactBands: z.array(contactBandSchema).optional(),
    events: z.record(nameSchema, eventDefinitionSchema).default({}),
    animations: z.record(nameSchema, clipSchema).default({}),
    atlas: atlasSchema.optional(),
    budgets: budgetsSchema.optional(),
    authoring: authoringSchema.optional()
  })
  .strict();

/** A parsed, defaults-filled document. Prefer loadAnimDocument() over parsing directly. */
export type AnimDocument = z.output<typeof animDocumentSchema>;
/** What may be written to disk (defaults optional). */
export type AnimDocumentInput = z.input<typeof animDocumentSchema>;
export type BoneData = AnimDocument["bones"][number];
export type SlotData = AnimDocument["slots"][number];
export type SkinData = AnimDocument["skins"][string];
export type AttachmentData = z.output<typeof attachmentSchema>;
export type MeshAttachmentData = z.output<typeof meshAttachmentSchema>;
export type RegionAttachmentData = z.output<typeof regionAttachmentSchema>;
export type LinkedMeshAttachmentData = z.output<typeof linkedMeshAttachmentSchema>;
export type PointAttachmentData = z.output<typeof pointAttachmentSchema>;
export type ClippingAttachmentData = z.output<typeof clippingAttachmentSchema>;
export type BoundingBoxAttachmentData = z.output<typeof boundingBoxAttachmentSchema>;
export type SequenceData = z.output<typeof sequenceSchema>;
export type SequenceKeyData = z.output<typeof sequenceKeySchema>;
export type DrawOrderOffsetData = z.output<typeof drawOrderOffsetSchema>;
export type IkConstraintData = AnimDocument["ik"][number];
export type TransformConstraintData = AnimDocument["transform"][number];
export type PathConstraintData = AnimDocument["path"][number];
export type PhysicsConstraintData = AnimDocument["physics"][number];
export type PathAttachmentData = z.output<typeof pathAttachmentSchema>;
export type DrivenData = AnimDocument["driven"][number];
export type DrivenGridData = z.output<typeof drivenGridSchema>;
export type PoseLimitData = z.output<typeof poseLimitSchema>;
export type ContourData = z.output<typeof contourSchema>;
export type ContourPointData = z.output<typeof contourPointSchema>;
export type CoverageData = z.output<typeof coverageSchema>;
export type TriangleRanges = z.output<typeof triangleRangesSchema>;
export type ClipData = AnimDocument["animations"][string];
export type LimitsData = z.output<typeof limitsSchema>;

// ---------------------------------------------------------------------------------------------
// Mesh structure checks (local to one attachment; cross-document checks are elsewhere)
// ---------------------------------------------------------------------------------------------

/** Number of vertices of a mesh (from its UVs, which every mesh has exactly two of per vertex). */
export function meshVertexCount(mesh: { uvs: readonly number[] }): number {
  return mesh.uvs.length / 2;
}

/**
 * Walks a weighted vertex stream and returns the influence count, or a description of the first
 * problem. Shared by the schema and by tools that need the influence count (deform lengths).
 */
export function scanWeightedVertices(
  vertices: readonly number[],
  vertexCount: number,
  boneTableLength: number
): { ok: true; influences: number } | { ok: false; at: number; message: string } {
  let cursor = 0;
  let influences = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const count = vertices[cursor];
    if (count === undefined) {
      return { ok: false, at: cursor, message: `weighted vertex data ends early at vertex ${vertex} of ${vertexCount}` };
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_VERTEX_INFLUENCES) {
      return {
        ok: false,
        at: cursor,
        message: `vertex ${vertex} has influence count ${count}; expected an integer from 1 to ${MAX_VERTEX_INFLUENCES}`
      };
    }
    cursor += 1;
    for (let k = 0; k < count; k++) {
      if (cursor + 4 > vertices.length) {
        return { ok: false, at: cursor, message: `weighted vertex data ends early inside vertex ${vertex}` };
      }
      const bone = vertices[cursor] as number;
      const weight = vertices[cursor + 3] as number;
      if (!Number.isInteger(bone) || bone < 0 || bone >= boneTableLength) {
        return {
          ok: false,
          at: cursor,
          message: `vertex ${vertex} influence ${k} uses bone index ${bone}; the mesh bone table has ${boneTableLength} entries`
        };
      }
      if (weight < 0 || weight > 1) {
        return { ok: false, at: cursor + 3, message: `vertex ${vertex} influence ${k} has weight ${weight}; expected 0..1` };
      }
      cursor += 4;
      influences += 1;
    }
  }
  if (cursor !== vertices.length) {
    return {
      ok: false,
      at: cursor,
      message: `weighted vertex data has ${vertices.length - cursor} values left over after ${vertexCount} vertices`
    };
  }
  return { ok: true, influences };
}

/** Length of the deform array of a mesh: 2 floats per vertex, or per influence when weighted. */
export function meshDeformLength(mesh: Pick<MeshAttachmentData, "uvs" | "vertices" | "bones">): number {
  const vertexCount = meshVertexCount(mesh);
  if (!mesh.bones) return vertexCount * 2;
  const scan = scanWeightedVertices(mesh.vertices, vertexCount, mesh.bones.length);
  return scan.ok ? scan.influences * 2 : 0;
}

function checkMeshStructure(
  mesh: {
    uvs: number[];
    triangles: number[];
    vertices: number[];
    bones?: string[] | undefined;
    hull: number;
    edges?: number[] | undefined;
    groups?: Record<string, [number, number][]> | undefined;
    embed?: { vertices: number[]; points: unknown[]; offsets?: { vertices: number[]; points: [number, number, number, number][] } | undefined } | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  if (mesh.uvs.length % 2 !== 0) {
    issue(["uvs"], `must hold 2 values per vertex (got ${mesh.uvs.length})`);
    return;
  }
  const vertexCount = mesh.uvs.length / 2;
  if (vertexCount < 3) issue(["uvs"], `a mesh needs at least 3 vertices (got ${vertexCount})`);

  if (mesh.triangles.length === 0 || mesh.triangles.length % 3 !== 0) {
    issue(["triangles"], `must hold 3 indices per triangle and at least one triangle (got ${mesh.triangles.length})`);
  }
  mesh.triangles.forEach((vertex, i) => {
    if (vertex >= vertexCount) issue(["triangles", i], `vertex index ${vertex} is out of range (mesh has ${vertexCount} vertices)`);
  });

  if (mesh.hull < 3 || mesh.hull > vertexCount) {
    issue(["hull"], `hull vertex count ${mesh.hull} must be from 3 to the vertex count ${vertexCount}`);
  }

  if (mesh.edges) {
    if (mesh.edges.length % 2 !== 0) issue(["edges"], "must hold vertex index pairs");
    mesh.edges.forEach((vertex, i) => {
      if (vertex >= vertexCount) issue(["edges", i], `vertex index ${vertex} is out of range (mesh has ${vertexCount} vertices)`);
    });
  }

  if (mesh.groups) {
    const triangleCount = Math.floor(mesh.triangles.length / 3);
    const owner = new Int32Array(triangleCount).fill(-1);
    const names = Object.keys(mesh.groups);
    names.forEach((slot, g) => {
      (mesh.groups?.[slot] ?? []).forEach(([start, end], r) => {
        if (!(start < end) || end > triangleCount) {
          issue(["groups", slot, r], `range [${start}, ${end}) must satisfy start < end <= triangle count ${triangleCount}`);
          return;
        }
        for (let t = start; t < end; t++) {
          if ((owner[t] as number) >= 0) {
            issue(["groups", slot, r], `triangle ${t} is already in group '${names[owner[t] as number]}' (groups must partition the triangles)`);
            return;
          }
          owner[t] = g;
        }
      });
    });
    const missing = owner.indexOf(-1);
    if (missing >= 0) issue(["groups"], `triangle ${missing} is in no group (groups must partition the triangles)`);
  }

  if (mesh.embed) {
    const embed = mesh.embed;
    if (embed.points.length !== embed.vertices.length) issue(["embed", "points"], `needs one point per embedded vertex (${embed.vertices.length}), got ${embed.points.length}`);
    const seen = new Set<number>();
    embed.vertices.forEach((vertex, i) => {
      if (vertex >= vertexCount) issue(["embed", "vertices", i], `vertex index ${vertex} is out of range (mesh has ${vertexCount} vertices)`);
      if (seen.has(vertex)) issue(["embed", "vertices", i], `vertex ${vertex} is embedded twice`);
      seen.add(vertex);
    });
    const offsets = embed.offsets;
    if (offsets) {
      if (offsets.points.length !== offsets.vertices.length) issue(["embed", "offsets", "points"], `needs one point per offset vertex (${offsets.vertices.length}), got ${offsets.points.length}`);
      const own = new Set<number>();
      offsets.vertices.forEach((vertex, i) => {
        if (vertex >= vertexCount) issue(["embed", "offsets", "vertices", i], `vertex index ${vertex} is out of range (mesh has ${vertexCount} vertices)`);
        if (seen.has(vertex) || own.has(vertex)) issue(["embed", "offsets", "vertices", i], `vertex ${vertex} is embedded or offset twice`);
        own.add(vertex);
      });
      offsets.points.forEach((point, i) => {
        for (let k = 0; k < 3; k++) if (!seen.has(point[k] as number)) issue(["embed", "offsets", "points", i, k], `vertex ${point[k]} is not an embedded vertex of this mesh`);
      });
    }
  }

  if (mesh.bones) {
    const scan = scanWeightedVertices(mesh.vertices, vertexCount, mesh.bones.length);
    if (!scan.ok) issue(["vertices", scan.at], scan.message);
    const seen = new Set<string>();
    mesh.bones.forEach((bone, i) => {
      if (seen.has(bone)) issue(["bones", i], `bone '${bone}' is listed twice in the mesh bone table`);
      seen.add(bone);
    });
  } else if (mesh.vertices.length !== vertexCount * 2) {
    issue(
      ["vertices"],
      `an unweighted mesh needs 2 values per vertex (${vertexCount * 2}), got ${mesh.vertices.length}; add 'bones' for weighted data`
    );
  }
}

/** Number of points of a weighted vertex stream whose count is not stored (null when malformed). */
export function weightedPointCount(vertices: readonly number[]): number | null {
  let cursor = 0;
  let count = 0;
  while (cursor < vertices.length) {
    const n = vertices[cursor] as number;
    if (!Number.isInteger(n) || n < 1 || n > MAX_VERTEX_INFLUENCES) return null;
    cursor += 1 + n * 4;
    count++;
  }
  return cursor === vertices.length ? count : null;
}

/** Number of centreline points of a (structurally valid) contour. */
export function contourPointCount(contour: { points?: readonly unknown[] | undefined; vertices?: readonly number[] | undefined }): number {
  if (contour.points) return contour.points.length;
  return weightedPointCount(contour.vertices ?? []) ?? 0;
}

function checkContourStructure(
  contour: {
    mesh?: unknown;
    points?: (number | [number, number, number, number, number])[] | undefined;
    bones?: string[] | undefined;
    vertices?: number[] | undefined;
    closed: boolean;
    extend?: [number, number] | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (contour.closed && contour.extend && (contour.extend[0] > 0 || contour.extend[1] > 0)) issue(["extend"], "a closed contour has no ends to extend");
  const byMesh = contour.mesh !== undefined || contour.points !== undefined;
  const byBones = contour.bones !== undefined || contour.vertices !== undefined;
  if (byMesh === byBones) return issue([], "bind the contour either to a mesh ('mesh' + 'points') or to bones ('bones' + 'vertices')");
  let count: number;
  if (byMesh) {
    if (contour.mesh === undefined) return issue(["mesh"], "'points' need a 'mesh' to bind to");
    if (contour.points === undefined) return issue(["points"], "a mesh-bound contour needs 'points'");
    count = contour.points.length;
    contour.points.forEach((point, i) => {
      if (Array.isArray(point) && point[3] + point[4] > 1 + 1e-6) issue(["points", i], `barycentric weights ${point[3]} + ${point[4]} exceed 1`);
    });
  } else {
    if (contour.bones === undefined) return issue(["bones"], "'vertices' need a 'bones' table");
    if (contour.vertices === undefined) return issue(["vertices"], "a bone-bound contour needs 'vertices'");
    const points = weightedPointCount(contour.vertices);
    if (points === null) return issue(["vertices"], `malformed weighted data (per point: n (1..${MAX_VERTEX_INFLUENCES}) then n groups of boneIndex, x, y, weight)`);
    const scan = scanWeightedVertices(contour.vertices, points, contour.bones.length);
    if (!scan.ok) return issue(["vertices", scan.at], scan.message);
    count = points;
  }
  const field = byMesh ? "points" : "vertices";
  const minimum = contour.closed ? 3 : 2;
  if (count < minimum) issue([field], `${contour.closed ? "a closed" : "an open"} contour needs at least ${minimum} points (got ${count})`);
  if (count > MAX_CONTOUR_POINTS) issue([field], `a contour has at most ${MAX_CONTOUR_POINTS} points (got ${count})`);
}
