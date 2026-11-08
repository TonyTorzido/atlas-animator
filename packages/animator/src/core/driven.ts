/*
 * Atlas Animator: original implementation.
 *
 * Driven keys: corrections keyed to a bone angle instead of time (plan 3, "Driven keys"; the
 * idea of corrective shapes driven by a joint, as in pose-space deformation and Moho's smart
 * bones). They run after the bones and constraints of every frame, so they apply under every
 * clip without being keyed in any of them.
 *
 * Driver: the bone's applied local rotation minus its setup rotation (plan 4.4: driven keys read
 * `applied`, i.e. after limits and constraints). With limits the raw difference is used: the clamp
 * already bounds it, and a limit range may reach past 180 degrees one way. Without limits it is
 * wrapped to (-180, 180].
 *
 * Per set, with keys sorted by `at`:
 * - deform blends linearly between the two keys around the driver and holds the end keys'
 *   values outside their range. A key that does not mention an attachment contributes zero for
 *   it. Contributions of several sets add up.
 * - alpha (slot opacity) blends linearly like deform; a key that does not name a slot gives it 1.
 *   Several sets multiply. Sets with an `alphaOr` group multiply into that group instead; the slot
 *   takes the largest of its groups (OR) times the plain sets' product. The skeleton copies the
 *   result to `Slot.drivenAlpha`, which renderers multiply into the slot colour's alpha.
 * - draw-order offsets and attachment overrides are stepped: the last key at or before the
 *   driver applies (the first key below its range). Offsets of several sets add up; for
 *   attachment overrides of the same slot the later set wins.
 * - A set whose bone is inactive, or whose skin gate names an inactive skin, does nothing.
 *
 * Two-driver grids (format `drivenGrids`, plan 4d combination correctives): deform keyed on the
 * driver values of two bones, blended bilinearly inside the grid and held at its edges (each axis
 * clamps to its first/last key). Their deform adds to the sets'; a grid whose bones are inactive
 * or whose skin gate is closed does nothing.
 *
 * The compiled form is shared per document; each skeleton has its own DrivenState.
 */
import type { AttachmentLibrary, MeshAttachment } from "./attachments.js";
import type { Bone } from "./bone.js";
import type { DrivenData, DrivenGridData } from "./format.js";
import { wrapDegrees } from "./math.js";

interface CompiledDeform {
  readonly owner: number;
  /** Dense offsets per key (zeros where the key gives none), geometry.deformLength floats each. */
  readonly perKey: readonly Float32Array[];
  /**
   * Indices any key gives a nonzero offset, ascending. Evaluation adds only these: elsewhere every
   * key is 0, so the dense sum would add exactly +-0 to a zero-filled output (the same result).
   */
  readonly active: Uint32Array;
}

function withActive(owner: number, perKey: readonly Float32Array[]): CompiledDeform {
  const length = perKey[0]?.length ?? 0;
  const active: number[] = [];
  for (let i = 0; i < length; i++) if (perKey.some((key) => key[i] !== 0)) active.push(i);
  return { owner, perKey, active: Uint32Array.from(active) };
}

interface CompiledSet {
  readonly name: string;
  readonly bone: number;
  readonly skin: string | null;
  readonly at: Float64Array;
  readonly deform: readonly CompiledDeform[];
  /** Per key: slot indices and their offsets. */
  readonly drawOrder: readonly { readonly slots: Int32Array; readonly offsets: Int32Array }[];
  /** Per key: slot indices and the placeholder shown (null = nothing). */
  readonly attachments: readonly { readonly slots: Int32Array; readonly names: readonly (string | null)[] }[];
  /** Slots any key fades, and per key their opacity (1 where a key does not name the slot). */
  readonly alphaSlots: Int32Array;
  readonly alpha: readonly Float32Array[];
  /** alphaOr group index (-1: plain multiply). */
  readonly alphaOr: number;
}

interface CompiledGrid {
  readonly name: string;
  readonly xBone: number;
  readonly yBone: number;
  readonly skin: string | null;
  readonly xAt: Float64Array;
  readonly yAt: Float64Array;
  /** Per owner: dense offsets per key, row-major (keys[j * columns + i]). */
  readonly deform: readonly CompiledDeform[];
}

export interface DrivenLookups {
  boneIndex(name: string): number;
  slotIndex(name: string): number;
  readonly library: AttachmentLibrary;
}

export class CompiledDriven {
  readonly sets: readonly CompiledSet[];
  readonly grids: readonly CompiledGrid[];
  /** Deform owners any set or grid writes. */
  readonly owners: readonly number[];
  /** Deform owner -> bone indices whose angle drives its deform (contours rebuild when they move). */
  readonly drivers: ReadonlyMap<number, readonly number[]>;
  /** Number of alphaOr groups. */
  readonly alphaGroups: number;

  constructor(driven: readonly DrivenData[], lookups: DrivenLookups, grids: readonly DrivenGridData[] = []) {
    const owners = new Set<number>();
    const drivers = new Map<number, Set<number>>();
    const drives = (owner: number, bone: number) => {
      let set = drivers.get(owner);
      if (!set) drivers.set(owner, (set = new Set()));
      set.add(bone);
    };
    const denseDeform = (label: string, keys: readonly { deform: DrivenData["keys"][number]["deform"] }[]): CompiledDeform[] => {
      const byOwner = new Map<number, Float32Array[]>();
      keys.forEach((key, k) => {
        for (const [skin, slots] of Object.entries(key.deform)) {
          for (const [slot, attachments] of Object.entries(slots)) {
            for (const [name, values] of Object.entries(attachments)) {
              const target = lookups.library.get(skin, slot, name);
              if (!target || target.type !== "mesh" || target.deformIndex < 0) {
                throw new Error(`${label}: deform target '${skin}/${slot}/${name}' is not a mesh that owns its deform`);
              }
              let perKey = byOwner.get(target.deformIndex);
              if (!perKey) {
                const length = target.geometry.deformLength;
                perKey = keys.map(() => new Float32Array(length));
                byOwner.set(target.deformIndex, perKey);
              }
              const dense = perKey[k] as Float32Array;
              values.vertices.forEach((value, i) => {
                const at = values.offset + i;
                if (at < dense.length) dense[at] = value;
              });
            }
          }
        }
      });
      return [...byOwner].map(([owner, perKey]) => withActive(owner, perKey));
    };
    this.grids = grids.map((grid) => {
      const deform = denseDeform(`driven grid '${grid.name}'`, grid.keys);
      const xBone = lookups.boneIndex(grid.x.bone);
      const yBone = lookups.boneIndex(grid.y.bone);
      for (const entry of deform) {
        owners.add(entry.owner);
        drives(entry.owner, xBone);
        drives(entry.owner, yBone);
      }
      return { name: grid.name, xBone, yBone, skin: grid.skin ?? null, xAt: Float64Array.from(grid.x.at), yAt: Float64Array.from(grid.y.at), deform };
    });
    const groups = [...new Set(driven.flatMap((set) => (set.alphaOr ? [set.alphaOr] : [])))];
    this.alphaGroups = groups.length;
    this.sets = driven.map((set) => {
      const deform = denseDeform(`driven '${set.name}'`, set.keys);
      const bone = lookups.boneIndex(set.bone);
      for (const { owner } of deform) {
        owners.add(owner);
        drives(owner, bone);
      }
      return {
        name: set.name,
        bone,
        skin: set.skin ?? null,
        at: Float64Array.from(set.keys.map((key) => key.at)),
        deform,
        drawOrder: set.keys.map((key) => ({
          slots: Int32Array.from(key.drawOrder.map((entry) => lookups.slotIndex(entry.slot))),
          offsets: Int32Array.from(key.drawOrder.map((entry) => entry.offset))
        })),
        attachments: set.keys.map((key) => {
          const entries = Object.entries(key.attachments);
          return {
            slots: Int32Array.from(entries.map(([slot]) => lookups.slotIndex(slot))),
            names: entries.map(([, name]) => name)
          };
        }),
        ...compileAlpha(set.keys, lookups),
        alphaOr: set.alphaOr ? groups.indexOf(set.alphaOr) : -1
      };
    });
    this.owners = [...owners].sort((a, b) => a - b);
    this.drivers = new Map([...drivers].map(([owner, bones]) => [owner, [...bones].sort((a, b) => a - b)]));
  }
}

/** Grid cell and fraction of `value` on sorted keys `at` (clamped to the edges). */
function cellOf(at: Float64Array, value: number, out: { cell: number; t: number }): void {
  const last = at.length - 1;
  if (value <= (at[0] as number)) {
    out.cell = 0;
    out.t = 0;
  } else if (value >= (at[last] as number)) {
    out.cell = last - 1;
    out.t = 1;
  } else {
    let cell = 0;
    while ((at[cell + 1] as number) <= value) cell++;
    out.cell = cell;
    out.t = (value - (at[cell] as number)) / ((at[cell + 1] as number) - (at[cell] as number));
  }
}

const cellX = { cell: 0, t: 0 };
const cellY = { cell: 0, t: 0 };

function evaluateGrids(compiled: CompiledDriven, bones: readonly Bone[], isSkinActive: (skin: string) => boolean, state: DrivenState): void {
  for (const grid of compiled.grids) {
    const xBone = bones[grid.xBone];
    const yBone = bones[grid.yBone];
    if (!xBone || !yBone || !xBone.active || !yBone.active) continue;
    if (grid.skin !== null && !isSkinActive(grid.skin)) continue;
    cellOf(grid.xAt, drivenValue(xBone), cellX);
    cellOf(grid.yAt, drivenValue(yBone), cellY);
    const columns = grid.xAt.length;
    const k00 = cellY.cell * columns + cellX.cell;
    const tx = cellX.t;
    const ty = cellY.t;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    for (const entry of grid.deform) {
      const out = state.deform[entry.owner] as Float32Array;
      if (state.deformActive[entry.owner] === 0) {
        out.fill(0);
        state.deformActive[entry.owner] = 1;
      }
      const a = entry.perKey[k00] as Float32Array;
      const b = entry.perKey[k00 + 1] as Float32Array;
      const c = entry.perKey[k00 + columns] as Float32Array;
      const d = entry.perKey[k00 + columns + 1] as Float32Array;
      const active = entry.active;
      for (let n = 0; n < active.length; n++) {
        const i = active[n] as number;
        out[i] = (out[i] as number) + w00 * (a[i] as number) + w10 * (b[i] as number) + w01 * (c[i] as number) + w11 * (d[i] as number);
      }
    }
  }
}

function compileAlpha(keys: DrivenData["keys"], lookups: DrivenLookups): { alphaSlots: Int32Array; alpha: Float32Array[] } {
  const names = [...new Set(keys.flatMap((key) => Object.keys(key.alpha)))];
  return {
    alphaSlots: Int32Array.from(names.map((name) => lookups.slotIndex(name))),
    alpha: keys.map((key) => Float32Array.from(names.map((name) => key.alpha[name] ?? 1)))
  };
}

/** One skeleton's driven-key output for the current frame. */
export class DrivenState {
  /** Per deform owner: offsets this frame (allocated only for owners a set writes). */
  readonly deform: (Float32Array | null)[];
  /** Per deform owner: 1 when `deform` holds this frame's values. */
  readonly deformActive: Uint8Array;
  /** Per slot: summed draw-order offset. */
  readonly drawOrderOffsets: Int32Array;
  /** Per slot: placeholder override (undefined = none). */
  readonly placeholders: (string | null | undefined)[];
  /** Per slot: opacity multiplier (1 = none). */
  readonly alpha: Float32Array;
  /** Per slot x alphaOr group: the group's product, -1 while no set of the group names the slot. */
  readonly alphaOr: Float32Array;
  readonly alphaGroups: number;

  constructor(compiled: CompiledDriven, library: AttachmentLibrary, slotCount: number) {
    this.deform = library.deformOwners.map(() => null);
    for (const owner of compiled.owners) {
      this.deform[owner] = new Float32Array((library.deformOwners[owner] as MeshAttachment).geometry.deformLength);
    }
    this.deformActive = new Uint8Array(library.deformOwners.length);
    this.drawOrderOffsets = new Int32Array(slotCount);
    this.placeholders = new Array<string | null | undefined>(slotCount).fill(undefined);
    this.alpha = new Float32Array(slotCount).fill(1);
    this.alphaGroups = compiled.alphaGroups;
    this.alphaOr = new Float32Array(slotCount * compiled.alphaGroups);
  }
}

/** The driver value of a bone: applied minus setup rotation (raw with limits, else wrapped). */
export function drivenValue(bone: Bone): number {
  const delta = bone.applied.rotation - bone.data.rotation;
  return bone.data.limits ? delta : wrapDegrees(delta);
}

/**
 * Evaluates every set into `state` (overwriting last frame's output).
 * @param isSkinActive tells whether a skin gate is open
 */
export function evaluateDriven(
  compiled: CompiledDriven,
  bones: readonly Bone[],
  isSkinActive: (skin: string) => boolean,
  state: DrivenState
): void {
  for (const owner of compiled.owners) state.deformActive[owner] = 0;
  state.drawOrderOffsets.fill(0);
  state.placeholders.fill(undefined);
  state.alpha.fill(1);
  const G = state.alphaGroups;
  if (G > 0) state.alphaOr.fill(-1);

  for (const set of compiled.sets) {
    const bone = bones[set.bone];
    if (!bone || !bone.active) continue;
    if (set.skin !== null && !isSkinActive(set.skin)) continue;

    const value = drivenValue(bone);
    const at = set.at;
    const last = at.length - 1;
    // `lower` = last key at or before the value (-1 below the first key).
    let lower = -1;
    while (lower < last && (at[lower + 1] as number) <= value) lower++;
    let from: number;
    let to: number;
    let t: number;
    if (lower < 0) {
      from = to = 0;
      t = 0;
    } else if (lower === last) {
      from = to = last;
      t = 0;
    } else {
      from = lower;
      to = lower + 1;
      t = (value - (at[from] as number)) / ((at[to] as number) - (at[from] as number));
    }

    for (const entry of set.deform) {
      const out = state.deform[entry.owner] as Float32Array;
      if (state.deformActive[entry.owner] === 0) {
        out.fill(0);
        state.deformActive[entry.owner] = 1;
      }
      const a = entry.perKey[from] as Float32Array;
      const b = entry.perKey[to] as Float32Array;
      const active = entry.active;
      for (let n = 0; n < active.length; n++) {
        const i = active[n] as number;
        const av = a[i] as number;
        out[i] = (out[i] as number) + av + ((b[i] as number) - av) * t;
      }
    }

    if (set.alphaSlots.length > 0) {
      const a = set.alpha[from] as Float32Array;
      const b = set.alpha[to] as Float32Array;
      for (let i = 0; i < set.alphaSlots.length; i++) {
        const slot = set.alphaSlots[i] as number;
        const av = a[i] as number;
        const v = av + ((b[i] as number) - av) * t;
        if (set.alphaOr < 0) state.alpha[slot] = (state.alpha[slot] as number) * v;
        else {
          const g = slot * G + set.alphaOr;
          const prev = state.alphaOr[g] as number;
          state.alphaOr[g] = prev < 0 ? v : prev * v;
        }
      }
    }

    const step = lower < 0 ? 0 : lower;
    const order = set.drawOrder[step];
    if (order) {
      for (let i = 0; i < order.slots.length; i++) {
        const slot = order.slots[i] as number;
        state.drawOrderOffsets[slot] = (state.drawOrderOffsets[slot] as number) + (order.offsets[i] as number);
      }
    }
    const overrides = set.attachments[step];
    if (overrides) {
      for (let i = 0; i < overrides.slots.length; i++) {
        state.placeholders[overrides.slots[i] as number] = overrides.names[i] as string | null;
      }
    }
  }
  // OR groups: the slot takes the largest group product (groups that never name it are skipped).
  if (G > 0) {
    for (let slot = 0; slot < state.alpha.length; slot++) {
      let best = -1;
      for (let g = 0; g < G; g++) best = Math.max(best, state.alphaOr[slot * G + g] as number);
      if (best >= 0) state.alpha[slot] = (state.alpha[slot] as number) * best;
    }
  }
  if (compiled.grids.length > 0) evaluateGrids(compiled, bones, isSkinActive, state);
}
