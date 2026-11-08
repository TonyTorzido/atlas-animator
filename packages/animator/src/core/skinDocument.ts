/*
 * Atlas Animator: original implementation.
 *
 * Skin documents (`atlas-skin@1`, files named `<item>.skin.json`): one swag item, authored
 * separately from the rig it was made for, and the merge that adds items to a rig.
 *
 * A skin document holds exactly one skin (named after the document) plus what that skin brings
 * with it:
 * - `skin`: the skin itself, the same shape as a rig skin: attachments per slot placeholder
 *   (usually linked meshes of the rig's body meshes, plan 4.5.1), hides, and the rig's skin bones
 *   and skin constraints it activates;
 * - `bones`: new skin bones (cape chain, skirt bones, wing roots). Always skin bones, so they
 *   cost nothing on characters not wearing the item;
 * - `slots`: new slots, each placed in the draw order directly after or before a slot the rig (or
 *   an earlier merged item) already has;
 * - `ik`, `transform`, `physics`: new constraints, always skin constraints of this skin;
 * - `driven`: driven-key sets gated on this skin (e.g. a pauldron's raised-arm fix);
 * - `drivenGrids`: two-driver corrective grids, gated on this skin likewise.
 *
 * `template` names the rig and the rig revision the item was made for. Merging into a rig with
 * another name is an error, into an older revision than the item expects is an error (the item
 * may use parts the rig does not have yet), into a newer revision is a warning; in every case the
 * merged document is validated in full, so a broken reference is always caught.
 *
 * Merge order matters only for draw-order placement: items placed after (before) the same anchor
 * keep their merge order. The game merges every catalogue item into one document once and picks
 * an outfit per character with Skeleton.setActiveSkins, so 50 characters share one document and
 * one attachment library.
 */
import { z } from "zod";
import {
  boneSchema,
  drivenGridSchema,
  drivenSchema,
  ikConstraintSchema,
  nameSchema,
  physicsConstraintSchema,
  skinSchema,
  slotObjectSchema,
  transformConstraintSchema,
  type AnimDocument
} from "./format.js";
import { resolveSetupDrawOrder } from "./drawOrder.js";
import { parseAnimDocument, type FormatIssue, type IssuePath } from "./formatLoader.js";

export const SKIN_FORMAT_NAME = "atlas-skin";
export const SKIN_FORMAT_VERSION = 1;
export const SKIN_FORMAT_ID = `${SKIN_FORMAT_NAME}@${SKIN_FORMAT_VERSION}` as const;

const skinBoneSchema = boneSchema.extend({
  skin: z.literal(true, { errorMap: () => ({ message: "bones a skin document adds are always skin bones (skin: true)" }) }).default(true)
});

const skinOnly = { errorMap: () => ({ message: "constraints a skin document adds are always skin constraints (skin: true)" }) };

/**
 * A slot a skin document adds: anchored to exactly one existing slot (drawAfter / drawBefore).
 * The anchor stays on the merged slot, so the item keeps its layer wherever draw-order changes
 * move the anchor.
 */
const skinSlotSchema = slotObjectSchema.superRefine((slot, ctx) => {
  if ((slot.drawAfter === undefined) === (slot.drawBefore === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawAfter"], message: "give exactly one of 'drawAfter' and 'drawBefore'" });
  }
});

export const skinDocumentSchema = z
  .object({
    format: z.literal(SKIN_FORMAT_ID, { errorMap: () => ({ message: `expected "${SKIN_FORMAT_ID}"` }) }),
    /** The skin name this document adds. */
    name: nameSchema,
    template: z.object({ name: nameSchema, revision: z.number().int().positive() }).strict(),
    skin: skinSchema.default({}),
    bones: z.array(skinBoneSchema).default([]),
    slots: z.array(skinSlotSchema).default([]),
    ik: z.array(ikConstraintSchema.extend({ skin: z.literal(true, skinOnly).default(true) })).default([]),
    transform: z.array(transformConstraintSchema.extend({ skin: z.literal(true, skinOnly).default(true) })).default([]),
    physics: z.array(physicsConstraintSchema.extend({ skin: z.literal(true, skinOnly).default(true) })).default([]),
    driven: z.array(drivenSchema).default([]),
    drivenGrids: z.array(drivenGridSchema).default([])
  })
  .strict();

export type SkinDocument = z.output<typeof skinDocumentSchema>;
export type SkinDocumentInput = z.input<typeof skinDocumentSchema>;

/** An issue found while merging; `document` names the skin document (or "merged" for the result). */
export interface MergeIssue extends FormatIssue {
  document: string;
}

export type SkinParseResult = { ok: true; document: SkinDocument } | { ok: false; issues: FormatIssue[] };

/** Validates the structure of a JSON-decoded skin document. */
export function parseSkinDocument(raw: unknown): SkinParseResult {
  const parsed = skinDocumentSchema.safeParse(raw);
  if (parsed.success) return { ok: true, document: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path,
      message:
        issue.code === "unrecognized_keys"
          ? `unknown field${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((key) => `'${key}'`).join(", ")}`
          : issue.code === "invalid_type" && issue.received === "undefined"
            ? `required ${issue.expected} is missing`
            : issue.message,
      severity: "error" as const
    }))
  };
}

export type MergeResult =
  | { ok: true; document: AnimDocument; warnings: MergeIssue[] }
  | { ok: false; issues: MergeIssue[] };

/**
 * Adds skin documents to a validated rig, in order, and validates the result as a whole.
 * The rig is not modified.
 */
export function mergeSkinDocuments(rig: AnimDocument, items: readonly SkinDocument[]): MergeResult {
  const issues: MergeIssue[] = [];
  const report = (document: string, path: IssuePath, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ document, path, message, severity });

  const merged = structuredClone(rig) as AnimDocument;
  const order = merged.drawOrder ? [...merged.drawOrder] : merged.slots.map((slot) => slot.name);
  // anchor slot -> last slot merged after it (so later items stack after earlier ones).
  const lastAfter = new Map<string, string>();
  const boneNames = new Set(merged.bones.map((bone) => bone.name));
  const slotNames = new Set(merged.slots.map((slot) => slot.name));
  const constraintNames = new Set([...merged.ik, ...merged.transform, ...merged.physics].map((c) => c.name));
  const drivenNames = new Set(merged.driven.map((set) => set.name));
  const gridNames = new Set((merged.drivenGrids ?? []).map((grid) => grid.name));

  for (const item of items) {
    const doc = `${item.name}.skin`;
    if (item.template.name !== rig.name) {
      report(doc, ["template", "name"], `made for rig '${item.template.name}', not '${rig.name}'`);
      continue;
    }
    if (item.template.revision > rig.revision) {
      report(doc, ["template", "revision"], `made for revision ${item.template.revision} of '${rig.name}', but the rig is at revision ${rig.revision}`);
      continue;
    }
    if (item.template.revision < rig.revision) {
      report(
        doc,
        ["template", "revision"],
        `made for revision ${item.template.revision} of '${rig.name}' (rig is at ${rig.revision}); references re-checked against the current rig`,
        "warning"
      );
    }
    if (item.name in merged.skins) {
      report(doc, ["name"], `the rig (or an item merged earlier) already has a skin named '${item.name}'`);
      continue;
    }

    const before = issues.filter((issue) => issue.severity === "error").length;
    item.bones.forEach((bone, i) => {
      if (boneNames.has(bone.name)) report(doc, ["bones", i, "name"], `bone '${bone.name}' already exists`);
      boneNames.add(bone.name);
    });
    item.slots.forEach((slot, i) => {
      if (slotNames.has(slot.name)) report(doc, ["slots", i, "name"], `slot '${slot.name}' already exists`);
      slotNames.add(slot.name);
    });
    for (const kind of ["ik", "transform", "physics"] as const) {
      item[kind].forEach((constraint, i) => {
        if (constraintNames.has(constraint.name)) report(doc, [kind, i, "name"], `constraint '${constraint.name}' already exists`);
        constraintNames.add(constraint.name);
      });
    }
    item.driven.forEach((set, i) => {
      if (set.skin !== undefined && set.skin !== item.name) {
        report(doc, ["driven", i, "skin"], `a skin document's driven keys are gated on its own skin '${item.name}'; omit 'skin'`);
      }
      if (drivenNames.has(set.name)) report(doc, ["driven", i, "name"], `driven key set '${set.name}' already exists`);
      drivenNames.add(set.name);
    });
    item.drivenGrids.forEach((grid, i) => {
      if (grid.skin !== undefined && grid.skin !== item.name) {
        report(doc, ["drivenGrids", i, "skin"], `a skin document's driven grids are gated on its own skin '${item.name}'; omit 'skin'`);
      }
      if (gridNames.has(grid.name)) report(doc, ["drivenGrids", i, "name"], `driven grid '${grid.name}' already exists`);
      gridNames.add(grid.name);
    });

    // Draw-order placement, in slot list order so an item can anchor a slot on its own earlier slot.
    item.slots.forEach((slot, i) => {
      const anchor = (slot.drawAfter ?? slot.drawBefore) as string;
      const at = order.indexOf(anchor);
      if (at < 0) {
        report(doc, ["slots", i, slot.drawAfter !== undefined ? "drawAfter" : "drawBefore"], `unknown slot '${anchor}'`);
        return;
      }
      if (slot.drawAfter !== undefined) {
        const previous = lastAfter.get(anchor);
        const after = previous === undefined ? at : order.indexOf(previous);
        order.splice(after + 1, 0, slot.name);
        lastAfter.set(anchor, slot.name);
      } else {
        order.splice(at, 0, slot.name);
      }
    });
    if (issues.filter((issue) => issue.severity === "error").length > before) continue;

    merged.bones.push(...item.bones);
    merged.slots.push(...item.slots);
    merged.ik.push(...item.ik);
    merged.transform.push(...item.transform);
    merged.physics.push(...item.physics);
    merged.driven.push(...item.driven.map((set) => ({ ...set, skin: item.name })));
    if (item.drivenGrids.length > 0) merged.drivenGrids = [...(merged.drivenGrids ?? []), ...item.drivenGrids.map((grid) => ({ ...grid, skin: item.name }))];
    merged.skins[item.name] = {
      attachments: item.skin.attachments,
      hides: item.skin.hides,
      bones: unique([...item.skin.bones, ...item.bones.map((bone) => bone.name)]),
      constraints: unique([...item.skin.constraints, ...[...item.ik, ...item.transform, ...item.physics].map((c) => c.name)])
    };
  }

  if (issues.some((issue) => issue.severity === "error")) return { ok: false, issues: sortIssues(issues) };

  // The placement above only orders slots against their anchors; the final setup order is the
  // runtime's anchored resolution, so the document lists slots exactly as they are drawn (an item
  // anchored to an earlier item's slot travels in that slot's group).
  merged.drawOrder = resolveSetupDrawOrder(merged.slots, order);
  const result = parseAnimDocument(merged);
  if (!result.ok) {
    return { ok: false, issues: sortIssues([...issues, ...result.issues.map((issue) => ({ ...issue, document: "merged" }))]) };
  }
  return {
    ok: true,
    document: result.document,
    warnings: [...issues, ...result.warnings.map((issue) => ({ ...issue, document: "merged" }))]
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sortIssues(issues: MergeIssue[]): MergeIssue[] {
  return [...issues.filter((issue) => issue.severity === "error"), ...issues.filter((issue) => issue.severity === "warning")];
}
