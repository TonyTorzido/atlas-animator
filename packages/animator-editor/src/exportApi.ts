/*
 * Atlas Animator editor: original implementation.
 *
 * Export and apply, the pure parts (no DOM, no Pixi; used by the dev server in vite.config.ts and unit tested):
 * - merging a clip into a rig document's text (the committed rig files are minified JSON, kept that way);
 * - the `animator render` command lines for the contact sheet and the phone-size previews.
 */

import { OUTFITS } from "./fixtures.js";

/** Where the rigs live (repo relative); the editor may only write rig documents of its fixtures, all under this directory. */
export const RIGS_ROOT = "packages/animator/rigs";
export const CLIP_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Phone-size scales (CSS px per rig px) the previews are rendered at. */
export const PHONE_SCALES = [0.4, 0.471] as const;

type Json = Record<string, unknown>;

/**
 * Sets `animations[name]` of a rig document text to `clip` (replacing a clip of that name) and declares the
 * clip's event names in the document's `events` (a clip may only use declared events). Output keeps the input's
 * layout: minified when the input has no line breaks, else two-space indented.
 */
export function mergeClipIntoRigText(text: string, name: string, clip: Json): string {
  if (!CLIP_NAME.test(name)) throw new Error(`bad clip name '${name}'`);
  if (typeof clip.duration !== "number") throw new Error("the clip has no duration");
  const doc = JSON.parse(text) as Json;
  if (doc.format !== "atlas-anim@1") throw new Error("not an atlas-anim@1 rig document");
  const animations = ((doc.animations as Json | undefined) ?? {}) as Json;
  animations[name] = clip;
  doc.animations = animations;
  const events = ((doc.events as Json | undefined) ?? {}) as Json;
  for (const e of (clip.events as { name: string }[] | undefined) ?? []) events[e.name] ??= {};
  doc.events = events;
  return text.includes("\n") ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}

export interface RenderPlan {
  scale: number;
  sheet: string;
  gif: string;
  args: string[];
}

/** The `animator render` arguments (after the CLI path) for one phone scale; canvas from the rig document. */
export function renderPlan(opts: { doc: string; clip: string; scale: number; canvas: { width: number; height: number; originX: number; originY: number }; outDir: string; background?: string }): RenderPlan {
  const { doc, clip, scale, canvas, outDir } = opts;
  const tag = String(scale);
  const sheet = `${outDir}/${clip}-${tag}-sheet.png`;
  const gif = `${outDir}/${clip}-${tag}.gif`;
  return {
    scale,
    sheet,
    gif,
    args: [
      "render",
      doc,
      "--clip",
      clip,
      "--fps",
      "30",
      "--scale",
      tag,
      "--size",
      `${Math.ceil(canvas.width * scale)}x${Math.ceil(canvas.height * scale)}`,
      "--origin",
      `${Math.round(canvas.originX * scale)},${Math.round(canvas.originY * scale)}`,
      "--background",
      opts.background ?? "1e2430",
      "--sheet",
      sheet,
      "--gif",
      gif
    ]
  };
}

/** Allowlist built from the editor's fixtures: rig file name -> repo-relative path (never a caller-supplied path). */
const RIG_PATHS: Map<string, string> = new Map(
  OUTFITS.map((o) => o.document).filter((d) => d.startsWith(`${RIGS_ROOT}/`) && !d.includes("..")).map((d) => [d.split("/").pop()!, d] as const)
);

/** Allows a rig the editor created (discovered from its rig.meta.json) to be written and rendered like a fixture. */
export function allowRigDocument(document: string): void {
  if (document.startsWith(`${RIGS_ROOT}/`) && !document.includes("..")) RIG_PATHS.set(document.split("/").pop()!, document);
}

/** True for a rig file name the editor may write or render (a fixture's rig document). */
export function isRigFile(name: string): boolean {
  return typeof name === "string" && RIG_PATHS.has(name);
}

/** The repo-relative path of an allowed rig file name; throws for anything not in the fixtures. */
export function rigPath(name: string): string {
  const path = RIG_PATHS.get(name);
  if (!path) throw new Error(`'${name}' is not a rig the editor may write`);
  return path;
}

/** A rig document the skins save may write: packages/animator/rigs/<dir>/<name>.anim.json. */
export const SKIN_RIG_PATH = /^packages\/animator\/rigs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.anim\.json$/;

/**
 * Sets `skins` of a rig document text and the setup attachment of the named slots (`setup[slot]`: a placeholder name or null),
 * leaving everything else as it was. Layout is kept like `mergeClipIntoRigText`: minified when the input has no line breaks.
 */
export function mergeSkinsIntoRigText(text: string, skins: Json, setup: Record<string, string | null> = {}): string {
  const doc = JSON.parse(text) as Json;
  if (doc.format !== "atlas-anim@1") throw new Error("not an atlas-anim@1 rig document");
  doc.skins = skins;
  const slots = (doc.slots as Json[] | undefined) ?? [];
  for (const [name, attachment] of Object.entries(setup)) {
    const slot = slots.find((s) => s.name === name);
    if (slot) slot.attachment = attachment;
  }
  return text.includes("\n") ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}
