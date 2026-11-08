/*
 * Atlas Animator: original implementation.
 *
 * Swag rules pack (packages/animator/swag-rules): the colour-in guide and the allowed-area data
 * the swag checks read. The garment is the body-derived surface of a declared domain
 * (tools/garmentSurface.ts); the allowed area of the art is exactly that surface at rest (the body
 * silhouette inside the domain cuts plus the domain margin and the garment stroke), drawn from the
 * same build the importer uses, so the guide cannot drift from what the importer will accept.
 * Everything is in rig canvas pixels (the art is aligned pixel for pixel with the body).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { readPng } from "./png.js";
import { texturesFromAtlas } from "./validate.js";
import { softRender } from "./softRender.js";
import { buildGarmentSurface, dressGarment, materialRestOf, DEFAULT_GARMENT_STROKE, type GarmentDomain } from "./garmentSurface.js";
import { distInside } from "./garmentImport.js";
import { createImage, type MutableImage, type RgbaImage } from "./image.js";

/** An overflow zone: a canvas-pixel rectangle where the item may extend past the body, declared in the domain file (`overflow`). */
export interface OverflowZone {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SwagContext {
  width: number;
  height: number;
  /** The body at rest (the rig rendered at rest, or the `--body` png). Opaque white background. */
  body: RgbaImage;
  /** 1 where the item may be painted: the garment surface at rest (margin and stroke included). */
  allowed: Uint8Array;
  /** 1 inside the zero-margin core (the body inside the domain cuts). */
  core: Uint8Array;
  /** The area the art must cover for the checks (`SwagCheckContext.required`): the core. */
  required: Uint8Array;
  /** 1 inside any declared overflow zone. */
  overflow: Uint8Array;
  overflowZones: OverflowZone[];
  /**
   * 1 inside the neck and shoulder zone: a box around the domain's neckline cut. Collars and shoulder
   * caps may run a little past the engine's surface there (the approved jacket does; the importer
   * rebuilds the real shape from the body), so the checks give that zone extra tolerance.
   */
  neckZone: Uint8Array;
  /** Domain margin and the stroke width in canvas px. */
  margin: number;
  strokeWidth: number;
  /** The garment outline colour the engine draws (rrggbb), and the body's own outline colour. */
  garmentStroke: string;
  domain: GarmentDomain;
}

export const STANDARD_BACKGROUND: [number, number, number] = [255, 255, 255];

/**
 * Euclidean-ish distance (chamfer) from each pixel to the nearest 1 pixel of `mask` (0 on the mask).
 * Only real mask pixels are sources: outside the canvas counts as far away, so the canvas border is
 * never "near" the mask, and an empty mask gives Infinity everywhere (review #10).
 */
export function distOutside(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : Infinity;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = d[i] as number;
    if (v === 0) continue;
    if (x > 0) v = Math.min(v, (d[i - 1] as number) + 1);
    if (y > 0) {
      v = Math.min(v, (d[i - w] as number) + 1);
      if (x > 0) v = Math.min(v, (d[i - w - 1] as number) + D2);
      if (x < w - 1) v = Math.min(v, (d[i - w + 1] as number) + D2);
    }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let v = d[i] as number;
    if (v === 0) continue;
    if (x < w - 1) v = Math.min(v, (d[i + 1] as number) + 1);
    if (y < h - 1) {
      v = Math.min(v, (d[i + w] as number) + 1);
      if (x < w - 1) v = Math.min(v, (d[i + w + 1] as number) + D2);
      if (x > 0) v = Math.min(v, (d[i + w - 1] as number) + D2);
    }
    d[i] = v;
  }
  return d;
}

export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const d = distOutside(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (d[i] as number) <= r ? 1 : 0;
  return out;
}

const alphaOf = (img: RgbaImage, minAlpha = 128): Uint8Array => {
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) m[i] = (img.data[i * 4 + 3] as number) >= minAlpha ? 1 : 0;
  return m;
};

export interface SwagContextOptions {
  rigPath: string;
  domainPath: string;
  /** Body slots the garment hides (default `tank`). */
  hides?: readonly string[];
  /** A rest body png on the rig canvas (default: the rig rendered at rest). */
  bodyPath?: string;
}

/** Builds the guide data from a body rig and a domain file. Pure and deterministic. */
export function loadSwagContext(opts: SwagContextOptions): SwagContext {
  const raw = JSON.parse(readFileSync(opts.rigPath, "utf8"));
  const domain = JSON.parse(readFileSync(opts.domainPath, "utf8")) as GarmentDomain & { overflow?: OverflowZone[] };
  const hides = opts.hides ?? ["tank"];
  const atlasPath = opts.rigPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage]));
  const baseTextures = texturesFromAtlas(pack, pages);
  const width = raw.canvas.width as number;
  const height = raw.canvas.height as number;
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  const skinKey = Object.keys(raw.skins)[0] as string;
  const bodyContour = Object.values((raw.skins[skinKey].contours?.[domain.skin.slot] ?? {}) as Record<string, any>)[0];
  const strokeWidth = (bodyContour?.width as number | undefined) ?? 10;
  const strokeColor = domain.stroke?.color ?? DEFAULT_GARMENT_STROKE;
  const fabric: [number, number, number] = [96, 96, 104];

  const renderRest = (doc: any, tex: Map<string, RgbaImage>, only?: Set<string>, background?: [number, number, number]): MutableImage => {
    const loaded = loadAnimDocument(doc);
    const sk = new Skeleton(loaded);
    sk.setActiveSkins([skinKey]);
    sk.setToSetupPose();
    const keep = only ? new Set([...only].map((n) => sk.getSlot(n))) : null;
    // the slots left out neither draw nor trim the kept strokes: the resting arm covers the top of the
    // flank stroke below the armpit seam, and a stroke trimmed there left the guide 5-6 px short of the
    // garment's own outline (armour; the arm uncovers it on a raise)
    if (keep) for (const s of sk.slots) if (!keep.has(s)) (s.color as { a: number }).a = 0;
    sk.updateWorldTransform("none");
    return softRender(sk, tex, { width, height, left: -ox, top: -oy, ...(background ? { background } : {}), ...(keep ? { slotFilter: (s) => keep.has(s) } : {}) }).image;
  };

  const C = buildGarmentSurface(raw, domain, { name: domain.name, margin: domain.margin, strokeWidth, strokeColor, fabric, hides });
  const B = buildGarmentSurface(raw, domain, { name: domain.name, margin: 0, noStrokes: true, fabric, hides });
  const garmentSlots = (b: typeof C) => new Set([b.ownerSlot, ...b.slots.map((s) => s.name)]);
  const withTex = (b: typeof C) => { const t = new Map(baseTextures); t.set(b.attachment.path, b.texture); return t; };
  const allowedImg = renderRest(dressGarment(raw, C, hides), withTex(C), garmentSlots(C));
  const coreImg = renderRest(dressGarment(raw, B, hides), withTex(B), garmentSlots(B));
  const body = opts.bodyPath ? readPng(opts.bodyPath) : renderRest(raw, baseTextures, undefined, STANDARD_BACKGROUND);
  if (body.width !== width || body.height !== height) throw new Error(`body image is ${body.width}x${body.height}, the rig canvas is ${width}x${height}`);

  const overflowZones = (domain.overflow ?? []).map((z) => ({ ...z }));
  const overflow = new Uint8Array(width * height);
  for (const z of overflowZones) for (let y = Math.max(0, z.y); y < Math.min(height, z.y + z.height); y++) for (let x = Math.max(0, z.x); x < Math.min(width, z.x + z.width); x++) overflow[y * width + x] = 1;

  const neckZone = new Uint8Array(width * height);
  const neck = domain.cuts.filter((c) => c.kind === "neckline").flatMap((c) => c.points.map((p) => materialRestOf(raw, domain, p)));
  if (neck.length) {
    const x0 = Math.floor(Math.min(...neck.map((p) => p[0]))) - 140;
    const x1 = Math.ceil(Math.max(...neck.map((p) => p[0]))) + 140;
    const y0 = Math.floor(Math.min(...neck.map((p) => p[1]))) - 60;
    const y1 = Math.ceil(Math.max(...neck.map((p) => p[1]))) + 130;
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) neckZone[y * width + x] = 1;
  }

  return {
    width,
    height,
    body,
    allowed: alphaOf(allowedImg),
    core: alphaOf(coreImg),
    required: alphaOf(coreImg),
    overflow,
    overflowZones,
    neckZone,
    margin: domain.margin,
    strokeWidth,
    garmentStroke: strokeColor.slice(0, 6),
    domain
  };
}

/** Outline pixels of a mask: inside pixels with a 4-neighbour outside, grown to `thick` px inward. */
export function maskEdge(mask: Uint8Array, w: number, h: number, thick = 1): Uint8Array {
  const d = distInside(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] && (d[i] as number) <= thick ? 1 : 0;
  return out;
}

/**
 * The colour-in guide: the body at rest on the standard background (the same size and pose as every
 * piece of swag art), the allowed area tinted pale green, the body silhouette inside the domain cuts
 * (the zero-margin core) as thin dark-blue lines, and the guide outline (the allowed area's
 * boundary: core plus margin plus stroke) as a 3 px solid magenta line. Overflow zones are drawn as
 * dashed orange boxes. The guide is for the artist to read; the art itself must not contain any of it.
 */
export function renderGuide(ctx: SwagContext): MutableImage {
  const { width: w, height: h } = ctx;
  const out = createImage(w, h);
  out.data.set(ctx.body.data);
  const put = (i: number, r: number, g: number, b: number, a: number) => {
    const o = i * 4;
    for (const [k, v] of [[0, r], [1, g], [2, b]] as const) out.data[o + k] = Math.round((out.data[o + k] as number) * (1 - a) + v * a);
    out.data[o + 3] = 255;
  };
  for (let i = 0; i < w * h; i++) if (ctx.allowed[i]) put(i, 120, 220, 130, 0.35);
  const coreEdge = maskEdge(ctx.core, w, h, 1);
  for (let i = 0; i < w * h; i++) if (coreEdge[i]) put(i, 30, 60, 200, 0.9);
  const edge = maskEdge(ctx.allowed, w, h, 3);
  for (let i = 0; i < w * h; i++) if (edge[i]) put(i, 230, 0, 200, 1);
  for (const z of ctx.overflowZones) {
    for (let t = 0; t < 3; t++) {
      for (let x = z.x; x < z.x + z.width; x++) if (Math.floor(x / 8) % 2 === 0) for (const y of [z.y + t, z.y + z.height - 1 - t]) if (x >= 0 && y >= 0 && x < w && y < h) put(y * w + x, 255, 140, 0, 1);
      for (let y = z.y; y < z.y + z.height; y++) if (Math.floor(y / 8) % 2 === 0) for (const x of [z.x + t, z.x + z.width - 1 - t]) if (x >= 0 && y >= 0 && x < w && y < h) put(y * w + x, 255, 140, 0, 1);
    }
  }
  return out;
}

/** The allowed-area mask as a black and white png (white = allowed), for the artist's tools. */
export function maskImage(mask: Uint8Array, w: number, h: number): MutableImage {
  const out = createImage(w, h);
  for (let i = 0; i < w * h; i++) out.data.set(mask[i] ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  return out;
}
