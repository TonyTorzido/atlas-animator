/*
 * Atlas Animator editor: Auto-bind (pure). Attaches each slot to the nearest bone, judged by the image centre against the bone segment
 * (pivot to tip, world space). Helper / target bones and the root are never chosen while a real bone exists; a zero-length bone counts as a
 * point. Ties go to the bone listed first.
 */
export interface BindBone {
  name: string;
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  /** Helpers (IK targets and the like) are skipped. */
  helper?: boolean;
}

export interface BindSlot {
  slot: string;
  /** World position of the image centre. */
  cx: number;
  cy: number;
  /** The bone it is on now. */
  bone: string;
}

export function segDistance(px: number, py: number, b: BindBone): number {
  const dx = b.tx - b.ox;
  const dy = b.ty - b.oy;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - b.ox) * dx + (py - b.oy) * dy) / len2)) : 0;
  return Math.hypot(px - (b.ox + t * dx), py - (b.oy + t * dy));
}

export function nearestBone(cx: number, cy: number, bones: readonly BindBone[], rootName = "root"): string | null {
  const real = bones.filter((b) => !b.helper && b.name !== rootName);
  const pool = real.length ? real : bones.filter((b) => !b.helper);
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of pool) {
    const d = segDistance(cx, cy, b);
    if (d < bestD - 1e-9) {
      bestD = d;
      best = b.name;
    }
  }
  return best;
}

/** The slots whose nearest bone differs from their current bone. */
export function autoBind(slots: readonly BindSlot[], bones: readonly BindBone[]): { slot: string; from: string; to: string }[] {
  const out: { slot: string; from: string; to: string }[] = [];
  for (const s of slots) {
    const to = nearestBone(s.cx, s.cy, bones);
    if (to && to !== s.bone) out.push({ slot: s.slot, from: s.bone, to });
  }
  return out;
}
