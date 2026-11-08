/*
 * Atlas Animator editor: original implementation.
 *
 * Skin preview (pure, MESH-WEIGHTS-PLAN D2). While a weight stroke is live the editor keeps the dense V x B weight table plus each
 * vertex's bone-local rest position for every candidate bone, and re-skins the mesh with linear blend skinning into a Float32Array
 * that an overlay Pixi Mesh uses as its position buffer (same texture and UVs as the real attachment, which is hidden meanwhile):
 *
 *     world(v) = sum_b  w[v][b] * M_b * local[v][b]
 *
 * which is what the engine's `computeGeometryWorldVertices` computes for a weighted mesh with no deform. The loop skips zero weights
 * and allocates nothing, so 840 vertices x 10 bones is well under a millisecond.
 */
import type { WeightTable } from "./weightModel.js";

/** A bone's 2x3 world matrix as the engine stores it. */
export interface WorldMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

/** Packs world matrices (a, b, c, d, x, y per bone) into one array, in column order. */
export function packWorlds(bones: ArrayLike<{ world: WorldMatrix }>, out: Float64Array = new Float64Array(bones.length * 6)): Float64Array {
  for (let i = 0; i < bones.length; i++) {
    const w = (bones[i] as { world: WorldMatrix }).world;
    out[i * 6] = w.a;
    out[i * 6 + 1] = w.b;
    out[i * 6 + 2] = w.c;
    out[i * 6 + 3] = w.d;
    out[i * 6 + 4] = w.x;
    out[i * 6 + 5] = w.y;
  }
  return out;
}

/**
 * The bone-local rest position of every vertex for every candidate bone: `rest` is x, y per vertex (world, rest pose) and `worlds` the
 * packed rest-pose bone matrices. Returns V x B x 2 floats (vertex, bone, then x/y).
 */
export function restLocals(rest: ArrayLike<number>, worlds: ArrayLike<number>, boneCount: number): Float32Array {
  const V = rest.length / 2;
  const out = new Float32Array(V * boneCount * 2);
  for (let b = 0; b < boneCount; b++) {
    const a = worlds[b * 6] as number;
    const bb = worlds[b * 6 + 1] as number;
    const c = worlds[b * 6 + 2] as number;
    const d = worlds[b * 6 + 3] as number;
    const tx = worlds[b * 6 + 4] as number;
    const ty = worlds[b * 6 + 5] as number;
    const det = a * d - bb * c;
    const inv = det !== 0 ? 1 / det : 0;
    for (let v = 0; v < V; v++) {
      const px = (rest[v * 2] as number) - tx;
      const py = (rest[v * 2 + 1] as number) - ty;
      const o = (v * boneCount + b) * 2;
      out[o] = (d * px - bb * py) * inv;
      out[o + 1] = (-c * px + a * py) * inv;
    }
  }
  return out;
}

/**
 * Skins every vertex into `out` (x, y per vertex, starting at `offset`, `stride` floats apart; default tightly packed).
 * `locals` is V x B x 2 (see `restLocals`), `worlds` the current packed bone matrices (B x 6).
 */
export function skinVertices(table: WeightTable, locals: ArrayLike<number>, worlds: ArrayLike<number>, out: Float32Array, offset = 0, stride = 2): Float32Array {
  const B = table.bones.length;
  const w = table.data;
  for (let v = 0, o = offset; v < table.vertexCount; v++, o += stride) {
    let x = 0;
    let y = 0;
    const row = v * B;
    for (let b = 0; b < B; b++) {
      const k = w[row + b] as number;
      if (k === 0) continue;
      const m = b * 6;
      const l = (row + b) * 2;
      const lx = locals[l] as number;
      const ly = locals[l + 1] as number;
      x += k * ((worlds[m] as number) * lx + (worlds[m + 1] as number) * ly + (worlds[m + 4] as number));
      y += k * ((worlds[m + 2] as number) * lx + (worlds[m + 3] as number) * ly + (worlds[m + 5] as number));
    }
    out[o] = x;
    out[o + 1] = y;
  }
  return out;
}

/** Owns the output buffer for one mesh: `update(worlds)` re-skins it in place; `positions` feeds a Pixi Mesh geometry buffer. */
export class SkinPreview {
  readonly positions: Float32Array;
  readonly locals: Float32Array;

  constructor(readonly table: WeightTable, rest: ArrayLike<number>, restWorlds: ArrayLike<number>) {
    this.locals = restLocals(rest, restWorlds, table.bones.length);
    this.positions = new Float32Array(table.vertexCount * 2);
  }

  /** Skins with the given packed bone matrices (the table is read live, so a brush dab shows on the next call). */
  update(worlds: ArrayLike<number>): Float32Array {
    return skinVertices(this.table, this.locals, worlds, this.positions);
  }
}
