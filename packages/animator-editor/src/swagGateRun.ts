/*
 * Atlas Animator editor: runs the Swag garment gates over frames, worn combinations and both facings (Batch 10b, PL-08 / ).
 *
 * `Sample` = the setup pose, a 60 degree elbow and the four contact-sheet frames of the open clip, turned facing only: it says "sampled".
 * `Full` = every frame of the open clip, the 60 degree elbow, both facings (turned + mirrored), the whole worn set and each worn item alone:
 * it says "full" only when all of that ran. The rig is the SAVED file (the sheet renderer reads it from disk); the clip is the one open now.
 */
import type { ClipData } from "@atlas-animator/core/core";
import type { Poser, SheetRenderer } from "./contactSheet.js";
import { frameCount, frameTime } from "./clipModel.js";
import { sheetFrames } from "./contactSheetModel.js";
import { maskedImage } from "./gateOverlay.js";
import { gateFrame, gatedSlots } from "./outlineGate.js";
import { cuffVerdict, foldGate, garmentMask, measureNeck, measureShoulders, neckReasons, SHOULDER_EXPOSED_MAX, type GateCoverage, type GateFinding, type GateResult } from "./swagGates.js";

export interface PoseSpec {
  label: string;
  time: number | null;
  pose: (renderer: SheetRenderer) => Poser;
}

export interface GateRun {
  mode: "sample" | "full";
  results: GateResult[];
  /** Plain-words header: what rig revision and clip the numbers came from. */
  source: string;
  /** The first failing frame's picture, for the report. */
  shot: { canvas: HTMLCanvasElement; at: { x: number; y: number } | null; label: string } | null;
  frames: number;
}

const ELBOW_60 = 60;
const INK_SCALE = 1;

export interface RunInput {
  renderer: SheetRenderer;
  /** Worn item skins (the base is implied). */
  worn: readonly string[];
  clipName: string | null;
  clip: ClipData | null;
  mode: "sample" | "full";
  /** Called between frames so the page can paint progress. */
  progress?: (done: number, total: number) => void;
}

const tick = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));

/** The poses a run visits. */
export function posesFor(i: Pick<RunInput, "clip" | "clipName" | "mode">): PoseSpec[] {
  const out: PoseSpec[] = [{ label: "Setup pose", time: null, pose: (r) => r.setupPose }];
  out.push({ label: `Elbow ${ELBOW_60} deg`, time: null, pose: (r) => r.sweepPose({ id: "elbow", label: "Elbow", bone: "forearm_near", values: [0, 0, 0, 0] }, ELBOW_60) });
  if (i.clip && i.clipName) {
    const clip = i.clip;
    const name = i.clipName;
    const frames: { label: string; t: number }[] =
      i.mode === "full" ? Array.from({ length: frameCount(clip) }, (_, f) => ({ label: `Frame ${f}`, t: frameTime(clip, f) })) : sheetFrames(clip).map((f) => ({ label: `${f.label} (${f.t.toFixed(2)} s)`, t: f.t }));
    for (const fr of frames) out.push({ label: fr.label, time: fr.t, pose: (r) => r.clipPose("turned", name, clip, fr.t) });
  }
  return out;
}

export async function runGates(i: RunInput): Promise<GateRun> {
  const poses = posesFor(i);
  const facings = i.mode === "full" ? (["left", "right"] as const) : (["left"] as const);
  const combos: { label: string; skins: string[] }[] = [{ label: i.worn.length ? i.worn.join(" + ") : "base only", skins: [...i.worn] }];
  if (i.mode === "full" && i.worn.length > 1) for (const w of i.worn) combos.push({ label: `${w} alone`, skins: [w] });
  const total = poses.length * facings.length * combos.length;
  const found: Record<"neck" | "shoulders" | "cuffs", GateFinding[]> = { neck: [], shoulders: [], cuffs: [] };
  const judged = { neck: 0, shoulders: 0, cuffs: 0 };
  const inkFound: GateFinding[] = [];
  let inkJudged = 0;
  let shot: GateRun["shot"] = null;
  let done = 0;
  for (const combo of combos) {
    for (const facing of facings) {
      for (const p of poses) {
        const probe = i.renderer.probe("turned", combo.skins, p.pose(i.renderer), facing);
        const fname = facing === "left" ? "turned" : "mirrored";
        const mask = garmentMask(probe.bare, probe.dressed);
        const base = { time: p.time, frame: p.label, facing: fname, combo: combo.label };
        const bad = (gate: keyof typeof found, reason: string, at: { x: number; y: number } | null): void => {
          found[gate].push({ ...base, reason, at });
          shot ??= { canvas: probe.canvas, at, label: `${p.label}, ${fname}, ${combo.label}` };
        };
        if (combo.skins.length) {
          const neck = measureNeck({ mask, width: probe.dressed.width, height: probe.dressed.height, chinY: probe.chinY, neckX: probe.neckX, scale: probe.scale });
          // A garment that never reaches the neck (boots, gloves, a hat) has no neck to judge.
          if (neck.reaches) {
            judged.neck++;
            for (const r of neckReasons(neck)) bad("neck", r.reason, r.at);
          }
          judged.shoulders++;
          measureShoulders({ bare: probe.bare, mask, clavicles: probe.clavicles, scale: probe.scale, chinY: probe.chinY }).forEach((s, k) => {
            if (s.exposed > SHOULDER_EXPOSED_MAX) bad("shoulders", `${Math.round(s.exposed * 100)}% of the ${k === 0 ? "near" : "far"} shoulder skin shows: the garment must cover the shoulder`, s.at);
          });
          for (const c of probe.cuffs) {
            const v = cuffVerdict(c);
            if (!v.judged) continue;
            judged.cuffs++;
            if (!v.ok) bad("cuffs", `the ${c.side} sleeve stops ${Math.round(v.gap)} px short of the wrist: sleeves must reach the wrist`, c.at);
          }
        }
        // Ink: the engine's outline gate on this frame (full figure against each garment piece alone), the same maths as the Animate overlay.
        if (combo.skins.length) {
          const doc = i.renderer.views.turned.doc;
          const slots = gatedSlots([...new Set(combo.skins.flatMap((n) => Object.keys(doc.skins[n]?.attachments ?? {})))]);
          if (slots.length) {
            inkJudged++;
            const pose = p.pose(i.renderer);
            const full = maskedImage(i.renderer.render("turned", combo.skins, pose, INK_SCALE, facing).canvas);
            const pieces = slots.map((slot) => ({
              name: slot,
              image: maskedImage(
                i.renderer.render("turned", combo.skins, (sk) => {
                  pose(sk);
                  for (const s of sk.slots) if (s.data.name !== slot) s.color.a = 0;
                }, INK_SCALE, facing).canvas
              )
            }));
            const g = gateFrame(full, pieces);
            const breaks = Object.values(g.pieces).reduce((n, q) => n + q.breaks, 0);
            if (breaks) {
              inkFound.push({ ...base, reason: `${breaks} ink outline break${breaks === 1 ? "" : "s"}`, at: null });
              shot ??= { canvas: probe.canvas, at: null, label: `${p.label}, ${fname}, ${combo.label}` };
            }
          }
        }
        done++;
        i.progress?.(done, total);
        if (done % 3 === 0) await tick();
      }
    }
  }
  const cov = (j: number): GateCoverage => ({
    scope: i.mode === "full" && !!i.clip && i.worn.length > 0 && j > 0 ? "full" : "sampled",
    frames: poses.map((p) => p.label),
    framesTotal: poses.length,
    combos: combos.map((c) => c.label),
    facings: facings.map((f) => (f === "left" ? "turned" : "mirrored"))
  });
  const results: GateResult[] = [
    foldGate("neck", "Neck", { coverage: cov(judged.neck), findings: found.neck, judged: judged.neck }),
    foldGate("shoulders", "Shoulders", { coverage: cov(judged.shoulders), findings: found.shoulders, judged: judged.shoulders }),
    foldGate("cuffs", "Cuffs", { coverage: cov(judged.cuffs), findings: found.cuffs, judged: judged.cuffs })
  ];
  results.push(foldGate("ink", "Ink outline", { coverage: cov(inkJudged), findings: inkFound, judged: inkJudged }));
  return { mode: i.mode, results, source: "Rig: the saved file (unsaved Rig edits are not in these pictures). Clip: as it is open now.", shot, frames: poses.length };
}
