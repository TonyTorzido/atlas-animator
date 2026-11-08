/*
 * Atlas Animator editor: original implementation.
 *
 * How the bone overlay shows over the character (pure rules; main.ts draws): all bones, dimmed (the art reads through them), only the
 * selected bone's chain, or hidden. The choice is remembered per workspace; the Swag workspace, where garments are judged, starts hidden so the art reads clean (Shift+B or the Overlays popover brings them back).
 */
import type { WorkspaceId } from "./workspace.js";

export type BoneView = "full" | "dim" | "chain" | "off";
export const BONE_VIEWS: readonly BoneView[] = ["full", "dim", "chain", "off"];

export const BONE_VIEW_LABEL: Record<BoneView, string> = {
  full: "All bones",
  dim: "Dimmed bones",
  chain: "Selected chain only",
  off: "Hidden"
};

const STORE = "atlas-editor-bone-view";

/** The view a workspace starts with before the person chooses: hidden in Swag, everything else all bones. */
export const defaultBoneView = (ws: WorkspaceId | string): BoneView => (ws === "swag" ? "off" : "full");

/** The next view in the cycle (Shift+B): all, dimmed, chain, hidden, all ... */
export const nextBoneView = (v: BoneView): BoneView => BONE_VIEWS[(BONE_VIEWS.indexOf(v) + 1) % BONE_VIEWS.length]!;

const isView = (v: unknown): v is BoneView => typeof v === "string" && (BONE_VIEWS as readonly string[]).includes(v);

export function readBoneViews(): Record<string, BoneView> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, unknown>;
    const out: Record<string, BoneView> = {};
    for (const [k, v] of Object.entries(raw)) if (isView(v)) out[k] = v;
    return out;
  } catch {
    return {}; // storage can be blocked: the default shows
  }
}

export function writeBoneView(ws: string, v: BoneView): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...readBoneViews(), [ws]: v }));
  } catch {
    // not remembered; the view still applies for this session
  }
}

/** The remembered view of a workspace, else its default. */
export const boneViewFor = (ws: string, stored: Readonly<Record<string, BoneView>> = readBoneViews()): BoneView => stored[ws] ?? defaultBoneView(ws);

/** Draw weights of a bone by its rank (0 plain, 1 child of the selection, 2 selected sibling, 3 active, 4 hover) in a view. */
export function boneWeight(view: BoneView, rank: number, inChain: boolean): { alpha: number; line: number } | null {
  if (view === "off") return null;
  if (view === "chain") {
    if (rank >= 2 || inChain) return { alpha: rank >= 2 ? 1 : 0.8, line: 1 };
    return null;
  }
  if (view === "dim") {
    if (rank >= 2) return { alpha: 1, line: 1 };
    return rank === 1 ? { alpha: 0.5, line: 0.8 } : { alpha: 0.3, line: 0.7 };
  }
  return { alpha: rank >= 2 ? 1 : rank === 1 ? 0.78 : 0.55, line: 1 };
}

/** The bones of the chain through `selected`: the bone, every ancestor and every descendant. */
export function chainBones(parentOf: (name: string) => string | null, names: readonly string[], selected: readonly string[]): Set<string> {
  const out = new Set<string>();
  const sel = new Set(selected);
  for (const n of selected) {
    for (let cur: string | null = n, guard = 0; cur && guard < 256; cur = parentOf(cur), guard++) out.add(cur);
  }
  for (const n of names) {
    for (let cur: string | null = n, guard = 0; cur && guard < 256; cur = parentOf(cur), guard++) {
      if (sel.has(cur)) {
        out.add(n);
        break;
      }
    }
  }
  return out;
}
