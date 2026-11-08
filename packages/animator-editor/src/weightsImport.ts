/*
 * Atlas Animator editor: original implementation.
 *
 * Pipeline weights and the near <-> far mirror for the Weights tool (MESH-WEIGHTS-PLAN section 2, chunk W3). Pure: no DOM, no fetch.
 *
 *  - `parseBuildScripts` replays the `build-*.jsonl` command lines of a rig folder for ONE mesh address (attachment.add / remove,
 *    weights.bind, weights.set, weights.table, in file-name order) and keeps the resulting per-vertex influences by bone name, plus
 *    the mesh's UVs and triangles when the script added the mesh.
 *  - `restoreTable` turns that into a `WeightTable` for the mesh that is open now: row for row when the vertex counts (and UVs) agree,
 *    else carried over by UV position with `weightsAtPoint`.
 *  - `mirrorTable` mirrors a table onto the other side's mesh in chain space (`mirrorWeights`), with the bone geometry and pairs built
 *    from the rig's bones.
 */
import { weightsAtPoint, type Influence, type WeightBone } from "@atlas-animator/core/tools/autoWeights";
import { makeMirrorRig, partnerCandidate, type MirrorBone, type MirrorRig } from "./mirrorModel.js";
import { mirrorWeights, tableFromInfluences, tableInfluences, type MeshAddress, type WeightTable } from "./weightModel.js";

export interface BuildScript {
  name: string;
  text: string;
}

/** Influences by bone name for one vertex, normalised to 1. */
export type NamedRow = { bone: string; weight: number }[];

export interface PipelineWeights {
  address: MeshAddress;
  /** Vertex count of the pipeline mesh (from its attachment.add, else the largest weighted vertex + 1). */
  count: number;
  /** One entry per vertex, or null where no script line weighted it. */
  rows: (NamedRow | null)[];
  /** The mesh the script added (UV space), when there is one. */
  uvs: number[] | null;
  triangles: number[] | null;
  /** Number of weights.set / weights.table / weights.bind lines that touched this mesh. */
  lines: number;
  /** The script files that touched this mesh. */
  files: string[];
}

const sameAddress = (a: MeshAddress, o: Record<string, unknown>): boolean => o["skin"] === a.skin && o["slot"] === a.slot && o["name"] === a.name;

function normalise(list: NamedRow): NamedRow {
  const sum = list.reduce((s, i) => s + i.weight, 0);
  return sum > 0 ? list.map((i) => ({ bone: i.bone, weight: i.weight / sum })) : list;
}

/** Replays the scripts' lines for `address`. Returns null when no script line weights that mesh. */
export function parseBuildScripts(scripts: readonly BuildScript[], address: MeshAddress): PipelineWeights | null {
  const out: PipelineWeights = { address, count: 0, rows: [], uvs: null, triangles: null, lines: 0, files: [] };
  const ordered = [...scripts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const touch = (file: string): void => {
    out.lines++;
    if (!out.files.includes(file)) out.files.push(file);
  };
  const grow = (n: number): void => {
    while (out.rows.length < n) out.rows.push(null);
    out.count = Math.max(out.count, n);
  };
  for (const script of ordered) {
    for (const line of script.text.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || !text.includes(address.name)) continue;
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!sameAddress(address, cmd)) continue;
      switch (cmd["op"]) {
        case "attachment.remove":
          out.rows = [];
          out.count = 0;
          out.uvs = null;
          out.triangles = null;
          break;
        case "attachment.add": {
          const a = cmd["attachment"] as { type?: string; uvs?: number[]; triangles?: number[] } | undefined;
          if (a?.type !== "mesh" || !Array.isArray(a.uvs)) break;
          out.rows = [];
          out.count = 0;
          out.uvs = a.uvs;
          out.triangles = a.triangles ?? null;
          grow(a.uvs.length / 2);
          break;
        }
        case "weights.bind": {
          const bone = cmd["bone"] as string;
          out.rows = out.rows.map(() => [{ bone, weight: 1 }]);
          touch(script.name);
          break;
        }
        case "weights.set": {
          const vertices = cmd["vertices"] as number[];
          const list = normalise((cmd["influences"] as NamedRow).map((i) => ({ bone: i.bone, weight: i.weight })));
          grow(Math.max(...vertices) + 1);
          for (const v of vertices) out.rows[v] = list.map((i) => ({ ...i }));
          touch(script.name);
          break;
        }
        case "weights.table": {
          const names = cmd["influences"] as string[];
          const weights = cmd["weights"] as number[];
          const V = Math.floor(weights.length / names.length);
          grow(V);
          for (let v = 0; v < V; v++) {
            const list: NamedRow = [];
            names.forEach((bone, b) => {
              const weight = weights[v * names.length + b] as number;
              if (weight > 0) list.push({ bone, weight });
            });
            out.rows[v] = normalise(list);
          }
          touch(script.name);
          break;
        }
        default:
          break;
      }
    }
  }
  return out.lines > 0 && out.rows.some((r) => r !== null) ? out : null;
}

export interface RestoreTarget {
  uvs: readonly number[];
  triangles: readonly number[];
}

export interface RestoreResult {
  table: WeightTable;
  /** True when the rows were copied vertex for vertex. */
  exact: boolean;
  /** Vertices that took their weights from UV position (all of them when not exact). */
  transferred: number;
}

const UV_TOLERANCE = 1e-3;

/** The pipeline weights as a table for `target`, or a message saying why not. */
export function restoreTable(pipeline: PipelineWeights, target: RestoreTarget): RestoreResult | string {
  const V = Math.floor(target.uvs.length / 2);
  const names: string[] = [];
  const indexOf = (name: string): number => {
    let i = names.indexOf(name);
    if (i < 0) i = names.push(name) - 1;
    return i;
  };
  const source: Influence[][] = pipeline.rows.map((row) => (row ?? []).map((i) => ({ bone: indexOf(i.bone), weight: i.weight })));
  if (names.length === 0) return "The build scripts hold no weights for this mesh.";
  const covered = pipeline.rows.map((r) => r !== null);
  const sameUvs = !pipeline.uvs || (pipeline.uvs.length === target.uvs.length && pipeline.uvs.every((u, k) => Math.abs(u - (target.uvs[k] as number)) <= UV_TOLERANCE));
  if (pipeline.count === V && sameUvs && covered.every(Boolean)) return { table: tableFromInfluences(names, source), exact: true, transferred: 0 };

  if (!pipeline.uvs || !pipeline.triangles) return `The mesh has ${V} vertices, the build scripts ${pipeline.count}, and they hold no mesh shape to carry weights across.`;
  const points = pipeline.uvs;
  const mesh = { points, triangles: pipeline.triangles };
  // Uncovered pipeline vertices borrow from their nearest weighted neighbour so the transfer never reads an empty row.
  const full = source.map((list, v) => {
    if (list.length > 0) return list;
    let best = -1;
    let bd = Infinity;
    for (let w = 0; w < source.length; w++) {
      if (!source[w]?.length) continue;
      const d = Math.hypot((points[v * 2] as number) - (points[w * 2] as number), (points[v * 2 + 1] as number) - (points[w * 2 + 1] as number));
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best >= 0 ? (source[best] as Influence[]) : list;
  });
  const rows: Influence[][] = [];
  for (let v = 0; v < V; v++) rows.push(weightsAtPoint(mesh, full, target.uvs[v * 2] as number, target.uvs[v * 2 + 1] as number));
  return { table: tableFromInfluences(names, rows), exact: false, transferred: V };
}

// --- Mirror near <-> far ------------------------------------------------------------------------------

/** The slot name on the other side (`skin_upper_arm_near` -> `skin_upper_arm_far`), or null when the name has no side token. */
export const partnerSlot = (slot: string): string | null => partnerCandidate(slot);

/** The mirror geometry for `bones` (rest pose): partner bones share the mean of their radii, so both sides read the same body width. */
export function mirrorContextOf(rig: MirrorRig, bones: readonly WeightBone[]): { bones: WeightBone[]; partner: ReadonlyMap<string, string>; axisX: number } {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const out = bones.map((b) => {
    const mate = byName.get(rig.partner.get(b.name) ?? "");
    return { ...b, radius: mate ? (b.radius + mate.radius) / 2 : b.radius };
  });
  return { bones: out, partner: rig.partner, axisX: rig.axisX };
}

export interface MirrorInput {
  /** Rest-pose world points (x, y) and triangles of the source mesh, with its weights. */
  source: { points: ArrayLike<number>; triangles: ArrayLike<number>; table: WeightTable };
  /** Rest-pose world points of the target mesh. */
  targetPoints: ArrayLike<number>;
  /** Every bone's rest geometry (the source and target meshes' chain and the rest of the rig). */
  bones: readonly WeightBone[];
  /** The rig's bones (for the partner pairs and the axis). */
  rigBones: readonly MirrorBone[];
}

/** Mirrors the source weights onto the target points. The result's columns are the partner bone names. */
export function mirrorTable(input: MirrorInput): WeightTable {
  const rig = makeMirrorRig(input.rigBones);
  const ctx = mirrorContextOf(rig, input.bones);
  return mirrorWeights({ mesh: { points: input.source.points, triangles: input.source.triangles }, table: input.source.table }, input.targetPoints, ctx);
}

/** Largest absolute difference between two tables over the union of their bones (rows must match). */
export function tableDistance(a: WeightTable, b: WeightTable): number {
  if (a.vertexCount !== b.vertexCount) return Infinity;
  const names = [...new Set([...a.bones, ...b.bones])];
  let worst = 0;
  const A = tableInfluences(a);
  const B = tableInfluences(b);
  for (let v = 0; v < a.vertexCount; v++) {
    for (const name of names) {
      const wa = (A[v] ?? []).find((i) => a.bones[i.bone] === name)?.weight ?? 0;
      const wb = (B[v] ?? []).find((i) => b.bones[i.bone] === name)?.weight ?? 0;
      worst = Math.max(worst, Math.abs(wa - wb));
    }
  }
  return worst;
}
