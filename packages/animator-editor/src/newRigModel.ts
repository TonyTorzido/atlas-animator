/*
 * Atlas Animator editor: the pure rules of the New rig flow (shared by the dialog in the browser and the server in Node).
 */
export const RIG_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_RIG_IDS: readonly string[] = ["player", "kit-body-cutout", "kit-body-front0", "kit-arm-cutout", "kit-tanktop", "kit-tanktop-front0", "jacketb"];

/** Why an id cannot be a rig folder name, or null. */
export function rigIdProblem(id: string): string | null {
  if (!RIG_ID.test(id)) return "Use 2 to 40 characters: lower-case letters, digits and dashes, starting with a letter or digit";
  if (RESERVED_RIG_IDS.includes(id)) return `'${id}' is a built-in rig`;
  return null;
}

/** A folder-safe id suggestion from a free-text name. */
export function suggestRigId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** A slot / attachment name from a file or layer name: the extension and a leading "NN_" order prefix go. */
export function partName(raw: string): string {
  const base = raw
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/^\d+[_-]/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "part";
}

/**
 * Lays out parts that have no position (dropped PNGs): left-to-right in shelves that wrap at `wrap` px, centred on the root, the whole
 * block standing on the ground (its bottom at y = 0). Returns the top-left of each part, root-relative, y down, in input order.
 */
export function layoutParts(sizes: readonly { width: number; height: number; opaqueBottom?: number }[], wrap = 900, gap = 16): { x: number; y: number }[] {
  const rows: { items: number[]; width: number; height: number }[] = [];
  let row = { items: [] as number[], width: 0, height: 0 };
  sizes.forEach((s, i) => {
    if (row.items.length && row.width + gap + s.width > wrap) {
      rows.push(row);
      row = { items: [], width: 0, height: 0 };
    }
    row.width += (row.items.length ? gap : 0) + s.width;
    row.height = Math.max(row.height, s.height);
    row.items.push(i);
  });
  if (row.items.length) rows.push(row);
  const total = rows.reduce((a, r) => a + r.height, 0) + gap * Math.max(0, rows.length - 1);
  const out: { x: number; y: number }[] = new Array(sizes.length);
  let y = -total;
  for (const r of rows) {
    let x = -r.width / 2;
    for (const i of r.items) {
      // The part's lowest opaque pixel sits on the row's floor (its box bottom when the part has no transparent rows below it).
      const s = sizes[i]!;
      out[i] = { x: Math.round(x), y: Math.round(y + r.height - (s.opaqueBottom ?? s.height)) };
      x += sizes[i]!.width + gap;
    }
    y += r.height + gap;
  }
  return out;
}

export interface CanvasSpec {
  width: number;
  height: number;
  originX: number;
  originY: number;
}

/** Bounds of the pixels with alpha above `threshold` in a straight RGBA image, or null when it is empty. */
export function opaqueBounds(rgba: ArrayLike<number>, width: number, height: number, threshold = 8): { left: number; top: number; right: number; bottom: number } | null {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]! <= threshold) continue;
      if (x < left) left = x;
      if (x + 1 > right) right = x + 1;
      if (y < top) top = y;
      if (y + 1 > bottom) bottom = y + 1;
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** The ground point of a layered file: the horizontal centre of all opaque pixels, and the bottom of the lowest opaque pixel (canvas pixels). Spine convention: root stands on the ground between the feet. */
export function groundOf(layers: readonly { left: number; top: number; width: number; height: number; rgba: ArrayLike<number> }[]): { x: number; y: number } | null {
  let minL = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;
  for (const l of layers) {
    const b = opaqueBounds(l.rgba, l.width, l.height);
    if (!b) continue;
    minL = Math.min(minL, l.left + b.left);
    maxR = Math.max(maxR, l.left + b.right);
    maxB = Math.max(maxB, l.top + b.bottom);
  }
  return Number.isFinite(minL) ? { x: Math.round((minL + maxR) / 2), y: Math.round(maxB) } : null;
}

/** The rig canvas for a PSD: the PSD's size and its ground point (see groundOf); without one, the horizontal centre and 66.3% down. */
export function psdCanvas(width: number, height: number, ground?: { x: number; y: number } | null): CanvasSpec {
  return { width, height, originX: ground?.x ?? Math.round(width / 2), originY: ground?.y ?? Math.round((height * 960) / 1448) };
}

/** Root-relative top-left of a PSD layer. */
export function psdOffset(layer: { left: number; top: number }, canvas: CanvasSpec): { x: number; y: number } {
  return { x: layer.left - canvas.originX, y: layer.top - canvas.originY };
}
