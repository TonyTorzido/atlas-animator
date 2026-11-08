/*
 * Atlas Animator editor: the Ship workspace's pure parts (Batch 8a; ).
 *
 * Render presets (scales and a background, saved in the browser), the validation checklist rows, and the Published table rows read
 * from the publish diff. No DOM here: ship.ts draws these.
 */

export interface RenderPreset {
  id: string;
  label: string;
  /** Phone-size scales to render (each makes a contact sheet and a gif). */
  scales: number[];
  /** Background colour, 6 hex digits (no #). */
  background: string;
  builtin?: boolean;
}

export const BUILTIN_PRESETS: readonly RenderPreset[] = [
  { id: "phone", label: "Phone sizes (0.4 and 0.471)", scales: [0.4, 0.471], background: "1e2430", builtin: true },
  { id: "large", label: "Large sheet (1.0)", scales: [1], background: "1e2430", builtin: true },
  { id: "small", label: "Small preview (0.25)", scales: [0.25], background: "1e2430", builtin: true }
];

export const SCALE_MIN = 0.1;
export const SCALE_MAX = 2;

/** Scales from a comma / space list ("0.4, 1"): 1 to 3 numbers in range, or null when the text is not usable. */
export function parseScales(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < SCALE_MIN || n > SCALE_MAX) return null;
    const r = Math.round(n * 1000) / 1000;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export const isHex6 = (v: string): boolean => /^[0-9a-fA-F]{6}$/.test(v);

/** Saved custom presets from untrusted storage: only well-formed rows survive. */
export function parsePresets(raw: unknown): RenderPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderPreset[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 40) : "";
    const scales = Array.isArray(o.scales) ? parseScales(o.scales.join(",")) : null;
    const bg = typeof o.background === "string" && isHex6(o.background) ? o.background.toLowerCase() : null;
    if (!label || !scales || !bg) continue;
    if (BUILTIN_PRESETS.some((b) => b.label === label) || out.some((x) => x.label === label)) continue;
    out.push({ id: `custom:${label}`, label, scales, background: bg });
  }
  return out;
}

export type CheckStatus = "ok" | "warn" | "bad" | "todo";
export interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ShipFacts {
  rig: string | null;
  rigUnsaved: boolean;
  clip: string;
  clipDirty: boolean;
  clipApplied: boolean;
  /** Counts from the clip board (done / broken / needs-recheck), when it could be read. */
  board?: { done: number; total: number; broken: number; recheck: number };
  /** The publish diff of the open clip / rig: how many files differ from the repo (null = not read). */
  repoDiff?: { rig: number | null; clip: number | null };
}

/** The staged checklist: rig saved, clip saved, clip applied, board, repo diff. Each row says what to do when it is not green. */
export function checklist(f: ShipFacts): CheckRow[] {
  const rows: CheckRow[] = [];
  rows.push(
    !f.rig
      ? { id: "rig", label: "A rig is open", status: "bad", detail: "Open a rig first (Rig workspace)." }
      : f.rigUnsaved
        ? { id: "rig", label: `Rig ${f.rig} is saved`, status: "bad", detail: "It has unsaved Setup or skin edits. Save rig first; Export Spine and Apply read the saved file." }
        : { id: "rig", label: `Rig ${f.rig} is saved`, status: "ok", detail: "No unsaved Setup or skin edits." }
  );
  if (!f.clip) {
    rows.push({ id: "clip", label: "A clip is open", status: "todo", detail: "Open a clip in Animate to save, apply and render it. Rig-only publishing still works." });
  } else {
    rows.push(f.clipDirty ? { id: "clip", label: `Clip ${f.clip} is saved`, status: "bad", detail: "It has unsaved edits. Save it." } : { id: "clip", label: `Clip ${f.clip} is saved`, status: "ok", detail: "The clips folder has this revision." });
    rows.push(f.clipApplied ? { id: "applied", label: "Clip is applied to the rig file", status: "ok", detail: "The rig file contains this revision." } : { id: "applied", label: "Clip is applied to the rig file", status: "warn", detail: "Apply it, or the rig file (and Export Spine) will not hold the animation you see." });
  }
  if (f.board) {
    const b = f.board;
    rows.push(b.broken ? { id: "board", label: "Board has no broken clips", status: "bad", detail: `${b.broken} broken. Open the Clip board.` } : b.recheck ? { id: "board", label: "Board has no clips to re-check", status: "warn", detail: `${b.recheck} need a re-check.` } : { id: "board", label: "Board has no broken clips", status: "ok", detail: `${b.done} of ${b.total} project clips done.` });
  }
  if (f.repoDiff) {
    const n = (f.repoDiff.rig ?? 0) + (f.repoDiff.clip ?? 0);
    rows.push(n ? { id: "repo", label: "Repo copy differs", status: "todo", detail: `${n} file(s) would change in the repo. Publish shows them first.` } : { id: "repo", label: "Repo copy matches", status: "ok", detail: "Nothing to publish for the open rig and clip." });
  }
  return rows;
}

/** The slice of a Swag gate result Ship shows (structural, so this file stays free of the editor). */
export interface GateRowSource {
  mode: "sample" | "full";
  results: { id: string; label: string; status: "pass" | "fail" | "idle" | "n/a"; summary: string; coverage: { scope: "full" | "sampled" } }[];
}

/** Ship's garment-gate rows: the same results the Swag panel shows, each saying whether it was a sampled or a full check. */
export function gateRows(run: GateRowSource | null): CheckRow[] {
  if (!run) return [{ id: "gates", label: "Garment gates (neck, shoulders, cuffs, ink)", status: "todo", detail: "Not run yet. In Swag, wear the item and press Check (Sample or Full)." }];
  return run.results.map((r) => ({
    id: `gate-${r.id}`,
    label: `Garment ${r.label.toLowerCase()} (${r.coverage.scope === "full" ? "full check" : "sampled"})`,
    status: r.status === "pass" ? "ok" : r.status === "fail" ? "bad" : "todo",
    detail: r.summary
  }));
}

export interface PublishPlanLike {
  added: string[];
  changed: string[];
  unchanged: number;
  hashes?: Record<string, string>;
}

export interface PublishedRow {
  kind: "rig" | "clip";
  name: string;
  state: "new" | "changed" | "same" | "not registered";
  detail: string;
}

/** One row of the Published table from a publish diff. */
export function publishedRow(kind: "rig" | "clip", name: string, plan: PublishPlanLike): PublishedRow {
  const n = plan.added.length + plan.changed.length;
  const label = name.replace(/\.clip\.json$/, "");
  if (!n) return { kind, name: label, state: "same", detail: `same as the repo (${plan.unchanged} file${plan.unchanged === 1 ? "" : "s"})` };
  const files = [...plan.added, ...plan.changed];
  const hashes = files.map((f) => plan.hashes?.[f]).filter(Boolean);
  const state = plan.changed.length ? "changed" : "new";
  return { kind, name: label, state, detail: `${state === "new" ? "not in the repo yet" : "changed since published"}: ${n} file${n === 1 ? "" : "s"}${hashes.length ? ` (${hashes.slice(0, 2).join(", ")}${hashes.length > 2 ? ", ..." : ""})` : ""}` };
}

/** Short revision text for a hash: 10 hex digits. */
export const shortHash = (hex: string): string => hex.slice(0, 10);
