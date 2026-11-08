/*
 * Atlas Animator: original implementation.
 *
 * Image sequences (Batch 12a): which frame of a sequence is shown `elapsed` seconds after a
 * sequence key. The key names a start frame `index`, a `mode` and a `delay` (seconds per frame;
 * 0 holds the frame). Pure and allocation free: the slot stores the key and the skeleton resolves
 * the frame once the slot's attachment (and so its frame count) is known.
 */
import type { SequenceMode } from "./format.js";

/** Frame (0..count-1) shown `elapsed` seconds after a key that started at `index`. */
export function sequenceFrame(mode: SequenceMode, index: number, delay: number, count: number, elapsed: number): number {
  const last = count - 1;
  const start = Math.min(Math.max(index, 0), last);
  if (mode === "hold" || delay <= 0 || elapsed <= 0 || last <= 0) return start;
  const steps = Math.floor(elapsed / delay + 1e-9);
  const i = start + steps;
  switch (mode) {
    case "once":
      return Math.min(i, last);
    case "loop":
      return i % count;
    case "pingpong": {
      const period = last * 2;
      const p = i % period;
      return p <= last ? p : period - p;
    }
  }
}
