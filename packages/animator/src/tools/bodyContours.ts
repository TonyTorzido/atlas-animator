/*
 * Atlas Animator: original implementation.
 *
 * Clothing model, body side (close): the body carries its own outline, independent of
 * any garment. Every run of the skin mesh's hull that no skin-bound contour of that skin strokes
 * yet gets a derived body contour (flanks, waist, shoulder tops, neck top), styled like the skin's
 * existing outline, round-capped so they join the authored arm contours without ticks at the
 * underarm. Garments never supply the bare body's outline; where a garment covers a body
 * contour the stroke is trimmed (core/coverage.ts), and the garment draws its own edge.
 *
 * Also: the bare-skin texture. Shading painted for under a garment (connected shade areas that do
 * not touch the texture's top edge, where the neck shadow sits) is flattened to the skin colour, so
 * the bare body shows no leftover garment-era shading.
 */
import type { RgbaImage } from "./image.js";

interface ContourJson {
  mesh?: { skin?: string; slot: string; attachment: string };
  points: number[];
  closed?: boolean;
  width?: number;
  color?: string;
  caps?: string;
  coverUnder?: string;
}

/**
 * Adds the derived body contours to `doc` (anim JSON, in place) for the skin mesh `slot/attachment`
 * of skin `skinName`; returns the added `slot/name` refs with their hull vertex runs.
 */
export function deriveBodyContours(doc: any, skinName: string, slot: string, attachment: string, buried: readonly [number, number][] = []): { ref: string; points: number[] }[] {
  const skin = doc.skins[skinName];
  const mesh = skin?.attachments?.[slot]?.[attachment];
  if (!mesh || mesh.type !== "mesh") throw new Error(`body contours: no mesh '${slot}/${attachment}' in skin '${skinName}'`);
  const hull = mesh.hull as number;
  if (!(hull >= 3)) throw new Error("body contours: the skin mesh declares no hull");
  const contours: Record<string, Record<string, ContourJson>> = (skin.contours ??= {});
  const stroked = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  let style: ContourJson | null = null;
  for (const byName of Object.values(contours)) {
    for (const c of Object.values(byName)) {
      if (!c.mesh || c.mesh.slot !== slot || c.mesh.attachment !== attachment || (c.mesh.skin && c.mesh.skin !== skinName)) continue;
      // Arm layer: a declared closing edge (`coverUnder`) is never re-inked as a body edge and never
      // styles one; its stroke shows only where it leaves the under-sheet.
      if (!c.coverUnder) style ??= c;
      for (let i = 0; i + 1 < c.points.length; i++) stroked.add(key(c.points[i] as number, c.points[i + 1] as number));
      if (c.closed && c.points.length > 2) stroked.add(key(c.points[c.points.length - 1] as number, c.points[0] as number));
    }
  }
  // Buried closure edges (arm layer): hull edges declared inside an under-sheet get no outline.
  for (const [a, b] of buried) stroked.add(key(a, b));
  const free = (i: number) => !stroked.has(key(i, (i + 1) % hull));
  if (Array.from({ length: hull }, (_, i) => i).every(free)) throw new Error("body contours: the skin has no authored outline to style from");
  // Start just after a stroked edge so no run wraps the loop's index origin unseen.
  let start = 0;
  while (free(start)) start++;
  start = (start + 1) % hull;
  const added: { ref: string; points: number[] }[] = [];
  const byName: Record<string, ContourJson> = (contours[slot] ??= {});
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) {
      let name = `body_edge_${run[0]}_${run[run.length - 1]}`;
      while (byName[name]) name += "_";
      byName[name] = { mesh: { slot, attachment }, points: run, width: style?.width ?? 10, color: style?.color ?? "000000ff", caps: "round" };
      added.push({ ref: `${slot}/${name}`, points: run });
    }
    run = [];
  };
  for (let n = 0; n < hull; n++) {
    const i = (start + n) % hull;
    if (free(i)) {
      if (!run.length) run.push(i);
      run.push((i + 1) % hull);
    } else flush();
  }
  flush();
  return added;
}

/**
 * Flattens garment-era shading in a bare-skin texture (in place): the most frequent opaque colour is
 * the skin, the second the shade; shade areas (4-connected) that do not touch the top row become
 * skin. Returns the number of texels changed.
 */
export function flattenUnderGarmentShading(image: RgbaImage): number {
  const { width, height, data } = image;
  const counts = new Map<number, number>();
  const rgb = (p: number) => ((data[p * 4] as number) << 16) | ((data[p * 4 + 1] as number) << 8) | (data[p * 4 + 2] as number);
  for (let p = 0; p < width * height; p++) if ((data[p * 4 + 3] as number) > 0) counts.set(rgb(p), (counts.get(rgb(p)) ?? 0) + 1);
  const [skinColor, shadeColor] = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (skinColor === undefined || shadeColor === undefined) return 0;
  const seen = new Uint8Array(width * height);
  let changed = 0;
  for (let p0 = 0; p0 < width * height; p0++) {
    if (seen[p0] || rgb(p0) !== shadeColor || (data[p0 * 4 + 3] as number) === 0) continue;
    const comp: number[] = [];
    const stack = [p0];
    seen[p0] = 1;
    let touchesTop = false;
    while (stack.length) {
      const p = stack.pop() as number;
      comp.push(p);
      const x = p % width;
      const y = (p - x) / width;
      if (y === 0) touchesTop = true;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q < 0 || seen[q] || rgb(q) !== shadeColor || (data[q * 4 + 3] as number) === 0) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (touchesTop) continue;
    const sr = (skinColor >> 16) & 255;
    const sg = (skinColor >> 8) & 255;
    const sb = skinColor & 255;
    const hr = (shadeColor >> 16) & 255;
    const hg = (shadeColor >> 8) & 255;
    const hb = shadeColor & 255;
    const between = (q: number) => {
      const r = data[q * 4] as number;
      const g = data[q * 4 + 1] as number;
      const b = data[q * 4 + 2] as number;
      return r >= Math.min(sr, hr) - 2 && r <= Math.max(sr, hr) + 2 && g >= Math.min(sg, hg) - 2 && g <= Math.max(sg, hg) + 2 && b >= Math.min(sb, hb) - 2 && b <= Math.max(sb, hb) + 2;
    };
    const paint = (q: number) => {
      data[q * 4] = sr;
      data[q * 4 + 1] = sg;
      data[q * 4 + 2] = sb;
      changed++;
    };
    for (const p of comp) paint(p);
    // The anti-aliased rim of the shade area (colours between shade and skin, within 2 texels).
    for (const p of comp) {
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const qx = x + dx;
          const qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
          const q = qy * width + qx;
          if (rgb(q) !== skinColor && (data[q * 4 + 3] as number) > 0 && between(q)) paint(q);
        }
      }
    }
  }
  return changed;
}

/**
 * The convex outline of an image's opaque texels (alpha >= 128) as u, v pairs in 0..1 (format region
 * `opaque`), at most `maxPoints` points: a rigid plate then trims only the strokes under its art,
 * not under its transparent rectangle corners. Null for an empty image.
 */
export function opaqueOutline(image: RgbaImage, maxPoints = 32): number[] | null {
  const { width, height, data } = image;
  const pts: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] as number) >= 128) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    pts.push([first, y], [last + 1, y], [first, y + 1], [last + 1, y + 1]);
  }
  if (pts.length < 3) return null;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as [number, number], lower[lower.length - 1] as [number, number], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as [number, number];
    while (upper.length >= 2 && cross(upper[upper.length - 2] as [number, number], upper[upper.length - 1] as [number, number], p) <= 0) upper.pop();
    upper.push(p);
  }
  let hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  // Thin to at most maxPoints by dropping the vertex whose removal loses the least area (stays
  // inside the true hull: a slightly smaller trim domain, never a larger one).
  while (hull.length > maxPoints) {
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[(i + hull.length - 1) % hull.length] as [number, number];
      const b = hull[i] as [number, number];
      const c = hull[(i + 1) % hull.length] as [number, number];
      const area = Math.abs(cross(a, b, c));
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    hull = hull.filter((_, i) => i !== best);
  }
  return hull.flatMap(([x, y]) => [Number((x / width).toFixed(5)), Number((y / height).toFixed(5))]);
}
