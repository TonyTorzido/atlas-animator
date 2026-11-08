/*
 * Atlas Animator: original implementation.
 *
 * Auto-outline (plan 4.6 step 2): the alpha channel of a part image becomes a closed polygon.
 *
 * 1. Threshold the alpha (128) into a mask and keep the largest 4-connected component (stray specks
 *    from cutting are dropped).
 * 2. Grow the mask by `padding` whole pixels (square dilation), so the polygon also covers the
 *    soft anti-aliased fringe below the threshold and the slack the simplification takes.
 * 3. Marching squares over pixel centres (one segment per cell crossing, at the edge midpoint;
 *    the two saddle cases keep diagonal pixels apart, matching 4-connectivity), segments chained
 *    into closed loops. The loop with the largest area is the outline, the others are its holes.
 * 4. Ramer-Douglas-Peucker simplification of each closed loop (`tolerance` px, plan: 1.5).
 *
 * Polygons are in image pixels (pixel (x, y) covers [x, x + 1) x [y, y + 1)). The outer loop has a
 * positive shoelace area in y-down coordinates (clockwise on screen); holes are negative.
 */
import { alphaMask, connectedComponents, createMask, dilateMask, type Mask, type RgbaImage } from "./image.js";

export interface Point {
  x: number;
  y: number;
}

export type Polygon = Point[];

export interface Outline {
  /** The outer boundary, positive shoelace area. */
  outer: Polygon;
  /** Holes inside it, negative shoelace area. */
  holes: Polygon[];
}

export interface OutlineOptions {
  /** Alpha at or above this is inside (default 128). */
  threshold?: number;
  /** Whole pixels the mask grows before tracing (default 2). */
  padding?: number;
  /** Ramer-Douglas-Peucker tolerance in pixels (default 1.5). */
  tolerance?: number;
  /** Holes smaller than this many pixels of area are dropped (default 64). */
  minHoleArea?: number;
}

/** Outline of the largest opaque region of an image. Throws when the image has no opaque pixel. */
export function outlineImage(image: RgbaImage, options: OutlineOptions = {}): Outline {
  return outlineMask(alphaMask(image, options.threshold ?? 128), options);
}

export function outlineMask(mask: Mask, options: OutlineOptions = {}): Outline {
  const padding = options.padding ?? 2;
  const tolerance = options.tolerance ?? 1.5;
  const minHoleArea = options.minHoleArea ?? 64;

  const largest = largestComponent(mask);
  if (!largest) throw new Error("outline: the image has no pixel at or above the alpha threshold");
  const grown = dilateMask(largest, padding);
  const loops = traceLoops(grown);
  let outerIndex = 0;
  loops.forEach((loop, i) => {
    if (Math.abs(polygonArea(loop)) > Math.abs(polygonArea(loops[outerIndex] as Polygon))) outerIndex = i;
  });
  const outer = orient(loops[outerIndex] as Polygon, 1);
  const holes = loops
    .filter((loop, i) => i !== outerIndex && Math.abs(polygonArea(loop)) >= minHoleArea)
    .map((loop) => orient(loop, -1));
  return {
    outer: simplifyClosed(outer, tolerance),
    holes: holes.map((hole) => simplifyClosed(hole, tolerance)).filter((hole) => hole.length >= 3)
  };
}

/** One traced component of an image (disconnected artwork gets an explicit policy). */
export interface ComponentOutline extends Outline {
  /** Opaque pixels of the component (before padding). */
  pixels: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Every 4-connected opaque component of an image, largest first (ties by first pixel), each traced
 * on its own (`outlineMask`). Components under `minPixels` (default 16: stray specks from cutting)
 * are returned in `dropped` instead. Throws when the image has no opaque pixel.
 */
export function outlineComponents(
  image: RgbaImage,
  options: OutlineOptions & { minPixels?: number } = {}
): { components: ComponentOutline[]; dropped: { pixels: number; bounds: ComponentOutline["bounds"] }[] } {
  const mask = alphaMask(image, options.threshold ?? 128);
  const { labels, sizes } = connectedComponents(mask);
  const minPixels = options.minPixels ?? 16;
  const first = new Map<number, number>();
  const box = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] as number;
    if (label === 0) continue;
    if (!first.has(label)) first.set(label, i);
    const x = i % mask.width;
    const y = Math.floor(i / mask.width);
    const b = box.get(label);
    if (b) {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
    } else box.set(label, { x0: x, y0: y, x1: x, y1: y });
  }
  const order = [...first.keys()].sort((a, b) => (sizes[b] as number) - (sizes[a] as number) || (first.get(a) as number) - (first.get(b) as number));
  if (order.length === 0) throw new Error("outline: the image has no pixel at or above the alpha threshold");
  const boundsOf = (label: number) => {
    const b = box.get(label) as { x0: number; y0: number; x1: number; y1: number };
    return { x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 };
  };
  const components: ComponentOutline[] = [];
  const dropped: { pixels: number; bounds: ComponentOutline["bounds"] }[] = [];
  order.forEach((label, k) => {
    const pixels = sizes[label] as number;
    if (k > 0 && pixels < minPixels) {
      dropped.push({ pixels, bounds: boundsOf(label) });
      return;
    }
    const own = createMask(mask.width, mask.height);
    for (let i = 0; i < labels.length; i++) own.data[i] = labels[i] === label ? 1 : 0;
    components.push({ ...outlineMask(own, options), pixels, bounds: boundsOf(label) });
  });
  return { components, dropped };
}

/** The largest 4-connected component of a mask, or null when the mask is empty. */
export function largestComponent(mask: Mask): Mask | null {
  const { labels, sizes } = connectedComponents(mask);
  let best = 0;
  for (let label = 1; label < sizes.length; label++) if ((sizes[label] as number) > (sizes[best] ?? 0)) best = label;
  if (best === 0) return null;
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < labels.length; i++) out.data[i] = labels[i] === best ? 1 : 0;
  return out;
}

/** Shoelace area (positive = clockwise on a y-down screen). */
export function polygonArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as Point;
    const b = polygon[i] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonPerimeter(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as Point;
    const b = polygon[i] as Point;
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function orient(polygon: Polygon, sign: 1 | -1): Polygon {
  return Math.sign(polygonArea(polygon)) === sign ? polygon : polygon.slice().reverse();
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Inside the outer loop and outside every hole. */
export function pointInOutline(x: number, y: number, outline: Outline): boolean {
  return pointInPolygon(x, y, outline.outer) && !outline.holes.some((hole) => pointInPolygon(x, y, hole));
}

/** Distance from a point to segment ab. */
export function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Distance from a point to the nearest edge of any loop of the outline. */
export function distanceToOutline(x: number, y: number, outline: Outline): number {
  let best = Infinity;
  for (const loop of [outline.outer, ...outline.holes]) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      best = Math.min(best, segmentDistance(x, y, loop[j] as Point, loop[i] as Point));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Marching squares
// ---------------------------------------------------------------------------------------------

/**
 * Closed loops along the mask boundary. Cell (i, j) spans pixel centres (i + .5, j + .5) to
 * (i + 1.5, j + 1.5) for i in -1..width-1 (the frame outside the image counts as empty, so every
 * loop closes). Each crossing is an edge midpoint, keyed in doubled integer coordinates.
 */
function traceLoops(mask: Mask): Polygon[] {
  const { width, height } = mask;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask.data[y * width + x] === 1;
  // Doubled coordinates of the four edge midpoints of cell (i, j): top, right, bottom, left.
  const key = (x2: number, y2: number) => `${x2},${y2}`;
  const neighbours = new Map<string, string[]>();
  const coords = new Map<string, Point>();
  const link = (a: [number, number], b: [number, number]) => {
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    coords.set(ka, { x: a[0] / 2, y: a[1] / 2 });
    coords.set(kb, { x: b[0] / 2, y: b[1] / 2 });
    (neighbours.get(ka) ?? neighbours.set(ka, []).get(ka) as string[]).push(kb);
    (neighbours.get(kb) ?? neighbours.set(kb, []).get(kb) as string[]).push(ka);
  };
  for (let j = -1; j < height; j++) {
    for (let i = -1; i < width; i++) {
      const tl = inside(i, j) ? 8 : 0;
      const tr = inside(i + 1, j) ? 4 : 0;
      const br = inside(i + 1, j + 1) ? 2 : 0;
      const bl = inside(i, j + 1) ? 1 : 0;
      const code = tl | tr | br | bl;
      if (code === 0 || code === 15) continue;
      const top: [number, number] = [2 * i + 2, 2 * j + 1];
      const right: [number, number] = [2 * i + 3, 2 * j + 2];
      const bottom: [number, number] = [2 * i + 2, 2 * j + 3];
      const left: [number, number] = [2 * i + 1, 2 * j + 2];
      switch (code) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        // Saddles: the two inside corners stay apart (4-connectivity).
        case 5: link(top, right); link(left, bottom); break; // tr + bl inside
        case 10: link(left, top); link(bottom, right); break; // tl + br inside
      }
    }
  }

  const loops: Polygon[] = [];
  const visited = new Set<string>();
  for (const start of neighbours.keys()) {
    if (visited.has(start)) continue;
    const loop: Polygon = [];
    let previous = "";
    let current = start;
    while (!visited.has(current)) {
      visited.add(current);
      loop.push(coords.get(current) as Point);
      const next = (neighbours.get(current) as string[]).find((candidate) => candidate !== previous && !visited.has(candidate));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---------------------------------------------------------------------------------------------
// Ramer-Douglas-Peucker
// ---------------------------------------------------------------------------------------------

/** Simplifies a closed polygon so no dropped point is more than `tolerance` from the result. */
export function simplifyClosed(polygon: readonly Point[], tolerance: number): Polygon {
  if (polygon.length <= 3) return polygon.slice();
  // Split at two far-apart points so each half is an open chain.
  const first = polygon[0] as Point;
  let far = 0;
  let farDistance = -1;
  polygon.forEach((p, i) => {
    const d = (p.x - first.x) ** 2 + (p.y - first.y) ** 2;
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  });
  const keep = new Uint8Array(polygon.length);
  keep[0] = 1;
  keep[far] = 1;
  const chain = (from: number, to: number) => {
    // Indices from..to going forward around the loop (to may wrap past the end).
    const count = (to - from + polygon.length) % polygon.length;
    const at = (k: number) => polygon[(from + k) % polygon.length] as Point;
    const stack: [number, number][] = [[0, count]];
    while (stack.length > 0) {
      const [s, e] = stack.pop() as [number, number];
      const a = at(s);
      const b = at(e);
      let worst = -1;
      let worstDistance = tolerance;
      for (let k = s + 1; k < e; k++) {
        const p = at(k);
        const d = segmentDistance(p.x, p.y, a, b);
        if (d > worstDistance) {
          worstDistance = d;
          worst = k;
        }
      }
      if (worst >= 0) {
        keep[(from + worst) % polygon.length] = 1;
        stack.push([s, worst], [worst, e]);
      }
    }
  };
  chain(0, far);
  chain(far, 0);
  const result = polygon.filter((_, i) => keep[i] === 1);
  return removeCollinear(result, 1e-9);
}

/** Drops points that lie on the segment between their neighbours. */
function removeCollinear(polygon: Polygon, epsilon: number): Polygon {
  if (polygon.length <= 3) return polygon;
  const out: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[(i - 1 + polygon.length) % polygon.length] as Point;
    const p = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) > epsilon) out.push(p);
  }
  return out.length >= 3 ? out : polygon;
}
