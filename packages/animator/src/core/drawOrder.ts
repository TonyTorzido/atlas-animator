/*
 * Atlas Animator: original implementation.
 *
 * Draw-order offsets to a full draw order.
 *
 * Draw-order changes (clip keys and driven keys) are stored as "move slot S by k places from its
 * setup position" (plan 4.4). Turning a set of offsets into a permutation:
 *
 * 1. Every moved slot claims the position setup + offset, clamped to the list. Moved slots claim
 *    in setup order; if the position is taken, the slot takes the nearest free position, looking
 *    first in the direction it was moving.
 * 2. The unmoved slots fill the remaining positions in their setup order.
 *
 * So unmoved slots keep their relative order, a single move does exactly what it says, and
 * colliding moves stay deterministic. Pure and allocation-free: callers pass the buffers.
 */

/**
 * @param setup   slot indices in setup draw order (length n)
 * @param offsets per slot index: places to move (0 = unmoved)
 * @param out     receives slot indices in the resulting draw order (length >= n)
 * @param taken   scratch, length >= n
 * @returns true if any offset was non-zero
 */
export function applyDrawOrderOffsets(
  setup: ArrayLike<number>,
  offsets: ArrayLike<number>,
  out: { [index: number]: number },
  taken: { [index: number]: number }
): boolean {
  const n = setup.length;
  let moved = false;
  for (let p = 0; p < n; p++) taken[p] = 0;

  for (let p = 0; p < n; p++) {
    const slot = setup[p] as number;
    const offset = offsets[slot] as number;
    if (offset === 0) continue;
    moved = true;
    const target = Math.min(n - 1, Math.max(0, p + offset));
    const position = nearestFree(taken, n, target, offset > 0 ? 1 : -1);
    taken[position] = 1;
    out[position] = slot;
  }
  if (!moved) {
    for (let p = 0; p < n; p++) out[p] = setup[p] as number;
    return false;
  }

  let free = 0;
  for (let p = 0; p < n; p++) {
    const slot = setup[p] as number;
    if ((offsets[slot] as number) !== 0) continue;
    while (taken[free] === 1) free++;
    taken[free] = 1;
    out[free] = slot;
  }
  return true;
}

function nearestFree(taken: { [index: number]: number }, n: number, target: number, direction: 1 | -1): number {
  for (let distance = 0; distance < n; distance++) {
    const ahead = target + direction * distance;
    if (ahead >= 0 && ahead < n && taken[ahead] !== 1) return ahead;
    const behind = target - direction * distance;
    if (behind >= 0 && behind < n && taken[behind] !== 1) return behind;
  }
  // Unreachable while fewer than n slots have been placed.
  return target;
}

// ---------------------------------------------------------------------------------------------
// Anchored slots (plan 4.4, settled in the Phase 1 review)
// ---------------------------------------------------------------------------------------------

/** The slot fields the anchored resolution reads. */
export interface DrawOrderSlot {
  readonly name: string;
  readonly drawAfter?: string | undefined;
  readonly drawBefore?: string | undefined;
}

/**
 * Draw-order resolution with anchored slots, compiled once per slot list.
 *
 * A slot with `drawAfter` (`drawBefore`) has no draw position of its own: it is drawn directly
 * after (before) its anchor wherever the anchor goes. Resolution:
 *
 * 1. The unanchored slots, in setup order, form the base list. Draw-order offsets permute the
 *    base list only (applyDrawOrderOffsets), so an offset counts places among unanchored slots.
 *    Offsets on anchored slots are ignored (the loader warns about them).
 * 2. Every slot of the permuted base list is expanded into its group: the slots anchored before
 *    it (each with its own group), the slot, then the slots anchored after it (each with its own
 *    group). Slots anchored to the same slot keep slot-list order, which for merged documents is
 *    merge order. So `body_cloth` (after `body`) and `body_plate` (after `body_cloth`) travel
 *    with the body as one block.
 *
 * Where a document's `drawOrder` lists an anchored slot somewhere else, that position is ignored
 * (the loader warns). Anchor cycles are loader errors; should one reach the runtime anyway, its
 * slots are drawn last, in slot order, rather than looping.
 *
 * resolve() allocates nothing.
 */
export class AnchoredDrawOrder {
  readonly slotCount: number;
  /** Unanchored slot indices in setup order. */
  readonly base: Int32Array;
  /** Per slot: true when it is anchored. */
  readonly anchored: Uint8Array;
  // Children anchored before / after each slot, as compressed rows: slot s owns
  // list[start[s] .. start[s + 1]).
  private readonly beforeStart: Int32Array;
  private readonly beforeList: Int32Array;
  private readonly afterStart: Int32Array;
  private readonly afterList: Int32Array;
  private readonly permuted: Int32Array;
  private readonly taken: Int32Array;
  private readonly emitted: Uint8Array;
  private cursor = 0;

  /**
   * @param slots      the slot list (index = slot index)
   * @param setupOrder slot indices in setup draw order (every slot once)
   */
  constructor(slots: readonly DrawOrderSlot[], setupOrder: ArrayLike<number>) {
    const n = slots.length;
    this.slotCount = n;
    const indexByName = new Map(slots.map((slot, i) => [slot.name, i] as const));
    const anchorOf = new Int32Array(n).fill(-1);
    const after = new Uint8Array(n);
    slots.forEach((slot, i) => {
      const name = slot.drawAfter ?? slot.drawBefore;
      const anchor = name === undefined ? undefined : indexByName.get(name);
      if (anchor === undefined || anchor === i) return;
      anchorOf[i] = anchor;
      after[i] = slot.drawAfter !== undefined ? 1 : 0;
    });
    this.anchored = Uint8Array.from(anchorOf, (anchor) => (anchor >= 0 ? 1 : 0));

    const rows = (wantAfter: number): [Int32Array, Int32Array] => {
      const start = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) if ((anchorOf[i] as number) >= 0 && after[i] === wantAfter) (start[(anchorOf[i] as number) + 1] as number)++;
      for (let s = 0; s < n; s++) start[s + 1] = (start[s + 1] as number) + (start[s] as number);
      const list = new Int32Array(start[n] as number);
      const fill = start.slice(0, n);
      for (let i = 0; i < n; i++) {
        const anchor = anchorOf[i] as number;
        if (anchor >= 0 && after[i] === wantAfter) list[(fill[anchor] as number)++] = i;
      }
      return [start, list];
    };
    [this.beforeStart, this.beforeList] = rows(0);
    [this.afterStart, this.afterList] = rows(1);

    const base: number[] = [];
    for (let p = 0; p < setupOrder.length; p++) {
      const slot = setupOrder[p] as number;
      if (anchorOf[slot] === -1) base.push(slot);
    }
    this.base = Int32Array.from(base);
    this.permuted = new Int32Array(this.base.length);
    this.taken = new Int32Array(this.base.length);
    this.emitted = new Uint8Array(n);
  }

  /**
   * Writes the resolved draw order (slot indices, back to front) into `out`.
   * @param offsets per slot index: places to move among the unanchored slots
   */
  resolve(offsets: ArrayLike<number>, out: { [index: number]: number }): void {
    applyDrawOrderOffsets(this.base, offsets, this.permuted, this.taken);
    this.emitted.fill(0);
    this.cursor = 0;
    for (let p = 0; p < this.base.length; p++) this.emitGroup(this.permuted[p] as number, out);
    if (this.cursor < this.slotCount) {
      for (let s = 0; s < this.slotCount; s++) if (this.emitted[s] === 0) out[this.cursor++] = s;
    }
  }

  private emitGroup(slot: number, out: { [index: number]: number }): void {
    if (this.emitted[slot] === 1) return;
    this.emitted[slot] = 1;
    for (let i = this.beforeStart[slot] as number, end = this.beforeStart[slot + 1] as number; i < end; i++) {
      this.emitGroup(this.beforeList[i] as number, out);
    }
    out[this.cursor++] = slot;
    for (let i = this.afterStart[slot] as number, end = this.afterStart[slot + 1] as number; i < end; i++) {
      this.emitGroup(this.afterList[i] as number, out);
    }
  }
}

/**
 * The setup draw order by name (no offsets): `drawOrder` (or slot order) with slots it omits
 * appended in slot order, then anchored slots placed at their anchors. Tools and the skin merge
 * use this; the runtime uses AnchoredDrawOrder directly.
 */
export function resolveSetupDrawOrder(slots: readonly DrawOrderSlot[], drawOrder?: readonly string[]): string[] {
  const indexByName = new Map(slots.map((slot, i) => [slot.name, i] as const));
  const listed = (drawOrder ?? []).map((name) => indexByName.get(name) ?? -1).filter((i) => i >= 0);
  const seen = new Set(listed);
  const setup = [...listed, ...slots.map((_, i) => i).filter((i) => !seen.has(i))];
  const resolver = new AnchoredDrawOrder(slots, setup);
  const out = new Int32Array(slots.length);
  resolver.resolve(new Int32Array(slots.length), out);
  return Array.from(out, (i) => (slots[i] as DrawOrderSlot).name);
}
