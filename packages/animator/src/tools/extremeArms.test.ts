import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { readPng } from "./png.js";
import { softRender } from "./softRender.js";
import { texturesFromAtlas } from "./validate.js";
import { outsideDistance } from "./liveLimits.js";

/*
 * Extreme-arm outline gate. The committed bare
 * body must carry the round-8 runtime contour joins (two per hand) and the elbow handover
 * (`coverFrom`). It is posed with BOTH arms at once at every min / mid / max combination of the
 * declared upper arm x forearm x hand limits (the same combination on both sides) and at EVERY frame
 * of the Bling emote's arm keys (fixtures/clips/emote-bling.json, both arms as the clip has them),
 * and rendered on the CPU (1 px per canvas px, ids). Around each arm's elbow and wrist joints:
 * - gaps: every arm or hand pixel that touches the background is outline ink (the silhouette is
 *   stroked all round: no break where the forearm stroke hands over to the fist outline), except
 *   within OCCLUDER px of another body part drawn over the limb (the head over a raised fist);
 * - thick: the ink's largest inscribed radius stays within half the stroke width plus WIDTH_SLACK
 *   (two strokes doubled or a cap knot at a sharp corner make a thicker blob);
 * - spurs: no ink pixel lies further than STROKE + SPUR_SLACK px from the background and from every
 *   pixel of another slot (a line end or tick running into the skin, also one attached to the
 *   outline: the old "component touches the background" test let those pass);
 * - thin: no limb skin pixel beside the ink is closer than STROKE - THIN_SLACK px to the background
 *   (the outline narrowed, e.g. its inner part painted over by skin);
 * - specks: no arm or hand skin pixel darker than SPECK_LUMA (leftover painted ink peeking out).
 * Damaged controls (an attached spur, the wrist line's inner part repainted as skin, a stretch of
 * the wrist line removed) are painted into a passing render and must each fail.
 * A missing fixture fails the gate (no skip).
 */

import { fileURLToPath, pathToFileURL } from "node:url";

/** The committed body (EXTREME_ARMS_RIG: another rig folder, e.g. a rebuild before it is committed). */
const RIG = process.env.EXTREME_ARMS_RIG ? pathToFileURL(`${process.env.EXTREME_ARMS_RIG.replace(/[\\/]$/, "")}/`) : new URL("../../fixtures/test-rigs/body/", import.meta.url);
const STROKE = 10;
const WIDTH_SLACK = 1;
const SPUR_SLACK = 3;
const THIN_SLACK = 2;
const SPECK_LUMA = 90;
/** Canvas px around the elbow and the wrist joints that are checked. */
const REACH = 48;
/** Canvas px around a pixel of another body part (an occluder) where the gap check stops. */
const OCCLUDER = 6;

type Side = "l" | "r";
type Bone = { name: string; limits?: { min: number; max: number } };
type RawDoc = { bones: Bone[]; poseLimits?: { name: string; x: string; y: string; polygon: [number, number][] }[]; skins: Record<string, { contours?: Record<string, Record<string, { coverFrom?: string }>>; contourJoins?: { a: { slot: string }; b: { slot: string } }[] }> };

function load() {
  const raw = JSON.parse(readFileSync(new URL("template7-shoulder-legs.bare.anim.json", RIG), "utf8")) as RawDoc;
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(new URL("template7-shoulder-legs.atlas.json", RIG), "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(fileURLToPath(new URL(p.file, RIG)))] as const));
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  return { raw, sk, textures: texturesFromAtlas(pack, pages) };
}

type Pose = { label: string; values: Record<string, number> };

function limitPoses(raw: RawDoc): Pose[] {
  const poses: Pose[] = [];
  const lim = (b: string) => {
    const l = raw.bones.find((x) => x.name === b)?.limits;
    if (!l) throw new Error(`no limits on ${b}`);
    return l;
  };
  const steps = (b: string) => [lim(b).min, (lim(b).min + lim(b).max) / 2, lim(b).max];
  for (let k = 0; k < 3; k++) for (let m = 0; m < 3; m++) for (let n = 0; n < 3; n++) {
    const values: Record<string, number> = {};
    const label: string[] = [];
    for (const side of ["l", "r"] as const) {
      const [u, f, h] = [steps(`upper_arm_${side}`)[k], steps(`forearm_${side}`)[m], steps(`hand_${side}`)[n]] as number[];
      values[`upper_arm_${side}`] = u as number;
      values[`forearm_${side}`] = f as number;
      values[`hand_${side}`] = h as number;
      label.push(`${side} u${u} f${f} h${h}`);
    }
    // pose rule 1 (elbows never fold outward): corner/midpoint combinations outside the body's
    // elbow_never_outward limits (e.g. raise -15 with the elbow at 35/70) are not reachable poses.
    if (!elbowRuleOk(raw, values)) continue;
    poses.push({ label: label.join(" | "), values });
  }
  return poses;
}

/** The body's elbow-direction limits (both sides); throws when the rig does not declare them. */
function elbowLimits(raw: RawDoc) {
  const l = (raw.poseLimits ?? []).filter((x) => x.name === "elbow_never_outward" || x.name === "elbow_never_outward_r");
  if (l.length !== 2) throw new Error(`the body must declare elbow_never_outward and _r (found ${l.length})`);
  return l;
}

function elbowRuleOk(raw: RawDoc, values: Record<string, number>): boolean {
  return elbowLimits(raw).every((l) => outsideDistance(l.polygon, [values[l.x] ?? 0, values[l.y] ?? 0]) <= 1e-4);
}

/** The Bling emote's arm channels at every frame (linear between keys, channel delays applied). */
function blingPoses(): Pose[] {
  const clip = JSON.parse(readFileSync(new URL("../../fixtures/clips/emote-bling.json", import.meta.url), "utf8")) as {
    frames: number;
    beats: number;
    delay?: Record<string, number>;
    channels: Record<string, { b: number; v: number }[]>;
  };
  const at = (keys: { b: number; v: number }[], b: number) => {
    const k = keys.findIndex((x) => x.b > b);
    if (k <= 0) {
      const a = keys[keys.length - 1] as { b: number; v: number };
      const c = keys[0] as { b: number; v: number };
      const span = clip.beats - a.b + c.b;
      const d = b >= a.b ? b - a.b : b + clip.beats - a.b;
      return a.v + (c.v - a.v) * (span > 0 ? d / span : 0);
    }
    const a = keys[k - 1] as { b: number; v: number };
    const c = keys[k] as { b: number; v: number };
    return a.v + ((c.v - a.v) * (b - a.b)) / (c.b - a.b);
  };
  const poses: Pose[] = [];
  for (let f = 0; f < clip.frames; f++) {
    const values: Record<string, number> = {};
    for (const side of ["l", "r"] as const) {
      for (const b of ["upper_arm", "forearm", "hand"]) {
        const ch = `${b}_${side}`;
        const keys = clip.channels[ch];
        if (!keys?.length) throw new Error(`Bling clip has no ${ch} channel`);
        const lag = clip.delay?.[ch] ?? 0;
        const frame = (f - lag + clip.frames) % clip.frames;
        values[ch] = at(keys, (frame / clip.frames) * clip.beats);
      }
    }
    poses.push({ label: `bling f${f}`, values });
  }
  return poses;
}

/** A CPU render with ids, writable so the controls can paint damage into it. */
interface Frame {
  w: number;
  h: number;
  left: number;
  top: number;
  /** Top slot index + 1 per pixel (0 = background). */
  slots: Int16Array;
  /** 1 where the top pixel is a contour stroke. */
  ink: Uint8Array;
  /** Luma of the rendered pixel. */
  luma: Float32Array;
  /** Joints per side (world px): elbow, wrist. */
  joints: Record<Side, { x: number; y: number }[]>;
}

function pose(sk: Skeleton, values: Record<string, number>) {
  sk.setToSetupPose();
  for (const [bone, v] of Object.entries(values)) {
    const b = sk.getBone(bone);
    b.pose.rotation = b.data.rotation + v;
  }
  sk.updateWorldTransform("none");
}

function render(sk: Skeleton, textures: ReturnType<typeof load>["textures"], values: Record<string, number>): Frame {
  pose(sk, values);
  const joints = {} as Frame["joints"];
  for (const side of ["l", "r"] as const) {
    const sfx = `_${side}`;
    joints[side] = [sk.getBone(`forearm${sfx}`).world, sk.getBone(`hand${sfx}`).world].map((p) => ({ x: p.x, y: p.y }));
  }
  const all = [...joints.l, ...joints.r];
  const pad = REACH + 20;
  const left = Math.floor(Math.min(...all.map((p) => p.x)) - pad);
  const top = Math.floor(Math.min(...all.map((p) => p.y)) - pad);
  const w = Math.ceil(Math.max(...all.map((p) => p.x)) + pad) - left;
  const h = Math.ceil(Math.max(...all.map((p) => p.y)) + pad) - top;
  const R = softRender(sk, textures, { width: w, height: h, left, top, ids: true });
  const slots = R.topSlot as Int16Array;
  const texels = R.topTexel as Int32Array;
  const ink = new Uint8Array(w * h);
  const luma = new Float32Array(w * h);
  const d = R.image.data;
  for (let i = 0; i < ink.length; i++) {
    if (slots[i] && (texels[i] as number) < 0) ink[i] = 1;
    luma[i] = 0.3 * (d[i * 4] as number) + 0.59 * (d[i * 4 + 1] as number) + 0.11 * (d[i * 4 + 2] as number);
  }
  return { w, h, left, top, slots, ink, luma, joints };
}

/** Two-pass chamfer distance (1, sqrt 2) to the seed pixels (0 at a seed); the image edge is not a seed. */
function chamfer(w: number, h: number, seed: (i: number) => boolean): Float32Array {
  const dist = new Float32Array(w * h);
  for (let i = 0; i < dist.length; i++) dist[i] = seed(i) ? 0 : 1e6;
  const relax = (i: number, j: number, step: number) => {
    const v = (dist[j] as number) + step;
    if (v < (dist[i] as number)) dist[i] = v;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) relax(i, i - 1, 1);
    if (y > 0) {
      relax(i, i - w, 1);
      if (x > 0) relax(i, i - w - 1, Math.SQRT2);
      if (x < w - 1) relax(i, i - w + 1, Math.SQRT2);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) relax(i, i + 1, 1);
    if (y < h - 1) {
      relax(i, i + w, 1);
      if (x < w - 1) relax(i, i + w + 1, Math.SQRT2);
      if (x > 0) relax(i, i + w - 1, Math.SQRT2);
    }
  }
  return dist;
}

interface Findings {
  gaps: number;
  thin: number;
  spurs: number;
  maxRadius: number;
  specks: number;
  /** First offending pixel per kind (world px), for the report. */
  at: Record<string, number[]>;
}

function analyse(sk: Skeleton, F: Frame, side: Side): Findings {
  const { w, h, slots, ink, luma } = F;
  const limbSlots = new Set<number>();
  /** Segment per limb slot: 1 upper arm, 2 forearm and hand (one piece for the spur check). */
  const segment = new Map<number, number>();
  const limb = new RegExp(`^(upper_arm|forearm|hand)${side === "l" ? "" : "_r"}$`);
  sk.slots.forEach((s, k) => {
    if (!limb.test(s.data.name)) return;
    limbSlots.add(k + 1);
    segment.set(k + 1, s.data.name.startsWith("upper_arm") ? 1 : 2);
  });
  const isLimb = (i: number) => limbSlots.has(slots[i] as number);
  const near = (i: number) => {
    const x = F.left + (i % w) + 0.5;
    const y = F.top + Math.floor(i / w) + 0.5;
    return F.joints[side].some((j) => Math.hypot(x - j.x, y - j.y) <= REACH);
  };
  const dBg = chamfer(w, h, (i) => !slots[i]);
  const dOther = chamfer(w, h, (i) => !!slots[i] && !isLimb(i));
  // the limb ink alone (torso or other-arm strokes beside it are not one thick line)
  const dSkin = chamfer(w, h, (i) => !ink[i] || !isLimb(i));
  // distance to a pixel outside the ink's own limb segment (a forearm stroke lying over the upper
  // arm at a deep bend is beside upper-arm pixels, not a spur; forearm and hand are one segment, so
  // a tick at the wrist bridge is measured against the background only)
  const dForeign = new Map<number, Float32Array>();
  for (const g of [1, 2]) dForeign.set(g, chamfer(w, h, (i) => segment.get(slots[i] as number) !== g));
  const nb8 = (i: number, f: (j: number) => boolean) => {
    const x = i % w;
    const y = Math.floor(i / w);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h && f(yy * w + xx)) return true;
    }
    return false;
  };
  const out: Findings = { gaps: 0, thin: 0, spurs: 0, maxRadius: 0, specks: 0, at: {} };
  const hit = (kind: "gaps" | "thin" | "spurs" | "specks", i: number) => {
    if (!out[kind]) out.at[kind] = [F.left + (i % w), F.top + Math.floor(i / w)];
    out[kind]++;
  };
  for (let i = 0; i < w * h; i++) {
    if (!isLimb(i) || !near(i)) continue;
    if (ink[i]) {
      out.maxRadius = Math.max(out.maxRadius, dSkin[i] as number);
      const foreign = (dForeign.get(segment.get(slots[i] as number) as number) as Float32Array)[i] as number;
      if (Math.min(dBg[i] as number, foreign) > STROKE + SPUR_SLACK) hit("spurs", i);
      continue;
    }
    const occluded = (dOther[i] as number) <= OCCLUDER;
    const touchesBg = nb8(i, (j) => !slots[j]);
    if (touchesBg && !occluded) hit("gaps", i);
    else if (!touchesBg && !occluded && (dBg[i] as number) < STROKE - THIN_SLACK && nb8(i, (j) => !!ink[j])) hit("thin", i);
    if ((luma[i] as number) < SPECK_LUMA) hit("specks", i);
  }
  return out;
}

const failed = (f: Findings) => f.gaps > 0 || f.thin > 0 || f.spurs > 0 || f.specks > 0 || f.maxRadius > STROKE / 2 + WIDTH_SLACK;
const report = (label: string, side: Side, f: Findings) => `${label} [${side}]: ${JSON.stringify({ ...f, maxRadius: +f.maxRadius.toFixed(2) })}`;

/**
 * Outer outline pixels of the wrist line: forearm or hand ink beside the background within REACH of
 * the wrist joint (the hand bone's origin sits inside the fist), clear of other body parts; nearest
 * to the wrist first.
 */
function wristOutline(sk: Skeleton, F: Frame, side: Side): number[] {
  const wrist = F.joints[side][1] as { x: number; y: number };
  const own = new RegExp(`^(forearm|hand)${side === "l" ? "" : "_r"}$`);
  const ownSlots = new Set<number>();
  sk.slots.forEach((s, k) => {
    if (own.test(s.data.name)) ownSlots.add(k + 1);
  });
  const dOther = chamfer(F.w, F.h, (i) => !!F.slots[i] && !ownSlots.has(F.slots[i] as number) && !/upper_arm/.test(sk.slots[(F.slots[i] as number) - 1]?.data.name ?? ""));
  const res: { i: number; d: number }[] = [];
  for (let i = 0; i < F.w * F.h; i++) {
    if (!F.ink[i] || !ownSlots.has(F.slots[i] as number) || (dOther[i] as number) <= OCCLUDER + STROKE) continue;
    const x = i % F.w;
    const y = Math.floor(i / F.w);
    const d = Math.hypot(F.left + x + 0.5 - wrist.x, F.top + y + 0.5 - wrist.y);
    if (d > REACH - 3) continue;
    let bgNb = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < F.w && yy < F.h && !F.slots[yy * F.w + xx]) bgNb = true;
    }
    if (bgNb) res.push({ i, d });
  }
  return res.sort((u, v) => u.d - v.d).map((r) => r.i);
}

function copyFrame(F: Frame): Frame {
  return { ...F, slots: F.slots.slice(), ink: F.ink.slice(), luma: F.luma.slice() };
}

describe("extreme arms: one outline through elbow and wrist at every declared angle ()", () => {
  const { raw, sk, textures } = load();
  const run = (poses: Pose[]) => {
    const bad: string[] = [];
    for (const p of poses) {
      const F = render(sk, textures, p.values);
      for (const side of ["l", "r"] as const) {
        const f = analyse(sk, F, side);
        if (failed(f)) bad.push(report(p.label, side, f));
      }
    }
    return bad;
  };

  it("the body carries the round-8 joins (two per hand) and the elbow handover (coverFrom)", () => {
    const skin = raw.skins[Object.keys(raw.skins)[0] as string];
    const joins = skin?.contourJoins ?? [];
    for (const hand of ["hand", "hand_r"]) expect(joins.filter((j) => j.b.slot === hand || j.a.slot === hand).length, hand).toBe(2);
    const coverFrom = Object.values(skin?.contours ?? {}).flatMap((bySlot) => Object.values(bySlot)).filter((c) => !!c.coverFrom);
    expect(coverFrom.length).toBeGreaterThanOrEqual(4);
  });

  it("elbows never fold outward: the body declares the rule and every Bling frame obeys it", () => {
    expect(elbowLimits(raw).length).toBe(2);
    // 27 corner/midpoint combinations minus 12: the sides pair min with max (left raise -15 with right raise 105 and
    // the reverse), so the arm that hangs carries a 35/70 outward bend in 2 of 3 elbow steps at each end, x3 hand steps
    expect(limitPoses(raw).length).toBe(15);
    expect(blingPoses().filter((p) => !elbowRuleOk(raw, p.values)).map((p) => p.label)).toEqual([]);
  });

  it("limit corners and midpoints, both arms posed together", () => {
    expect(run(limitPoses(raw))).toEqual([]);
  }, 300_000);

  /**
   * Known issue: at Bling f85 the right fist outline's end lies outside the
   * forearm line and the join redraws it inward, exposing one fist-skin pixel past the stroke. The fix
   * (a pose-dependent fist clip) is deferred. Exactly this finding is expected: the test fails if it
   * grows past 1 px, if it disappears (clean this list up), or if any other finding appears.
   */
  const KNOWN: Record<string, (f: Findings) => boolean> = {
    "bling f85 [r]": (f) => f.gaps === 1 && !f.thin && !f.spurs && !f.specks && f.maxRadius <= STROKE / 2 + WIDTH_SLACK,
  };

  it("every frame of the Bling emote, both arms (one listed known issue)", () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const p of blingPoses()) {
      const F = render(sk, textures, p.values);
      for (const side of ["l", "r"] as const) {
        const f = analyse(sk, F, side);
        if (!failed(f)) continue;
        const key = `${p.label} [${side}]`;
        if (KNOWN[key]?.(f)) seen.add(key);
        else bad.push(report(p.label, side, f));
      }
    }
    expect(bad).toEqual([]);
    expect([...seen].sort(), "known issues still present (remove fixed ones from KNOWN)").toEqual(Object.keys(KNOWN).sort());
  }, 600_000);

  it("damaged controls fail: an attached spur, a thinned wrist line, a stretch of wrist line removed", () => {
    // base: the first Bling frame whose left arm passes with its wrist line against the background,
    // clear of other body parts
    const side: Side = "l";
    let F: Frame | undefined;
    let outline: number[] = [];
    for (const p of blingPoses()) {
      const G = render(sk, textures, p.values);
      if (failed(analyse(sk, G, side))) continue;
      outline = wristOutline(sk, G, side);
      if (outline.length > 5) {
        F = G;
        break;
      }
    }
    if (!F) throw new Error("no passing Bling frame with an open wrist line for the controls");
    const dBg = chamfer(F.w, F.h, (i) => !F.slots[i]);
    const p = outline[0] as number;
    const px = p % F.w;
    const py = Math.floor(p / F.w);
    // inward direction: toward the larger background distance, measured 6 px around p
    let nx = 0;
    let ny = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const j = (py + dy) * F.w + px + dx;
      const v = (dBg[j] as number) >= 1e5 ? 0 : (dBg[j] as number);
      nx += dx * v;
      ny += dy * v;
    }
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const skinSlot = F.slots[p] as number;
    const setSkin = (G: Frame, j: number) => {
      G.ink[j] = 0;
      G.slots[j] = skinSlot;
      G.luma[j] = 200;
    };

    // (a) a 2 x 20 px ink spur attached to the outline, running into the skin
    const spur = copyFrame(F);
    for (let t = 0; t < 20 + STROKE; t++) for (let s = 0; s < 2; s++) {
      const j = Math.round(py + ny * t - nx * s) * F.w + Math.round(px + nx * t + ny * s);
      spur.ink[j] = 1;
      spur.slots[j] = skinSlot;
    }
    const fa = analyse(sk, spur, side);
    expect(fa.spurs, report("spur control", side, fa)).toBeGreaterThan(0);

    // (b) the inner 6 px of the wrist line repainted as skin (a 12 px stretch around p)
    const thin = copyFrame(F);
    for (let i = 0; i < F.w * F.h; i++) {
      if (!F.ink[i] || (dBg[i] as number) <= STROKE - 6) continue;
      if (Math.hypot((i % F.w) - px, Math.floor(i / F.w) - py) > STROKE + 6) continue;
      setSkin(thin, i);
    }
    const fb = analyse(sk, thin, side);
    expect(fb.thin, report("thin control", side, fb)).toBeGreaterThan(0);

    // (c) a 6 px stretch of the wrist line removed (repainted as skin across its full width)
    const gap = copyFrame(F);
    for (let i = 0; i < F.w * F.h; i++) {
      if (!F.ink[i]) continue;
      const dx = (i % F.w) - px;
      const dy = Math.floor(i / F.w) - py;
      const along = Math.abs(-ny * dx + nx * dy);
      const across = nx * dx + ny * dy;
      if (along <= 3 && across >= -2 && across <= STROKE + 2) setSkin(gap, i);
    }
    const fc = analyse(sk, gap, side);
    expect(fc.gaps, report("gap control", side, fc)).toBeGreaterThan(0);
  }, 120_000);
});

/*
 * Armpit ticks. The DRESSED body is
 * posed with both arms at those raises (forearm 35, and 24 / 62 where the armpit triangles stretch
 * most) and rendered on the CPU with ids. Within ARMPIT px of each armpit junction (the tank armhole
 * contour's point at the torso's armpit corner), no pixel of a tank slot may be texture ink darker
 * than SPECK_LUMA: the strokes are the garment's only outline, so dark texels there are its painted
 * ring stretched out from under the stroke. A dark 3 px band painted beside the stroke must fail.
 * The side line's remaining 1 px step at the junction (the shoulder corrective lifts the torso's
 * armpit corner while the arm-weighted triangle above swings out) is a listed open issue in the plan,
 * not gated here.
 */
const ARMPIT = 30;
const ARMPIT_POSES: [number, number][] = [[16, 35], [24, 62], [40, 35], [61, 35]];

describe("armpit ticks on the dressed body ()", () => {
  const raw = JSON.parse(readFileSync(new URL("template7-shoulder-legs.anim.json", RIG), "utf8")) as RawDoc;
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(new URL("template7-shoulder-legs.atlas.json", RIG), "utf8")));
  const textures = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(fileURLToPath(new URL(p.file, RIG)))] as const)));
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  // the armpit junction: the armhole edge point nearest the torso's armpit corner at rest (lowest
  // point of the edge that the upper arm moves)
  const junction = (side: Side) => {
    const c = sk.activeContours.find((k) => sk.contourSlot(k).data.name === (side === "l" ? "tank_armhole" : "tank_armhole_r"));
    if (!c) throw new Error(`no tank armhole contour (${side})`);
    const p = new Float32Array(c.pointCount * 2);
    sk.computeContourPoints(c, p);
    return { c, p };
  };
  // the junction index per side: the first edge point from the flank end that a full raise (u61)
  // moves more than 5 px (the torso's armpit corner the shoulder corrective lifts)
  const at = (side: Side) => {
    pose(sk, {});
    const rest = junction(side).p;
    pose(sk, { upper_arm_l: 61, forearm_l: 35, upper_arm_r: -61, forearm_r: -35 });
    const moved = junction(side).p;
    for (let i = 0; i < rest.length / 2; i++) if (Math.hypot((moved[i * 2] as number) - (rest[i * 2] as number), (moved[i * 2 + 1] as number) - (rest[i * 2 + 1] as number)) > 5) return i;
    throw new Error(`no armpit junction on the tank armhole (${side})`);
  };
  const junctionIndex = { l: at("l"), r: at("r") };
  const frame = (u: number, f: number) => {
    pose(sk, { upper_arm_l: u, forearm_l: f, upper_arm_r: -u, forearm_r: -f });
    const centres = (["l", "r"] as const).map((side) => {
      const { p } = junction(side);
      const k = junctionIndex[side];
      return { x: p[k * 2] as number, y: p[k * 2 + 1] as number };
    });
    const left = Math.floor(Math.min(...centres.map((q) => q.x)) - ARMPIT - 4);
    const top = Math.floor(Math.min(...centres.map((q) => q.y)) - ARMPIT - 4);
    const w = Math.ceil(Math.max(...centres.map((q) => q.x)) + ARMPIT + 4) - left;
    const h = Math.ceil(Math.max(...centres.map((q) => q.y)) + ARMPIT + 4) - top;
    const R = softRender(sk, textures, { width: w, height: h, left, top, ids: true });
    return { R, w, h, left, top, centres };
  };
  const ticks = (F: ReturnType<typeof frame>, luma: (i: number) => number) => {
    const tank = new Set(sk.slots.filter((s) => /^tank/.test(s.data.name)).map((s) => s.index + 1));
    const slots = F.R.topSlot as Int16Array;
    const texels = F.R.topTexel as Int32Array;
    let n = 0;
    let at = "";
    for (let i = 0; i < F.w * F.h; i++) {
      if (!tank.has(slots[i] as number) || (texels[i] as number) < 0 || luma(i) >= SPECK_LUMA) continue;
      const x = F.left + (i % F.w);
      const y = F.top + Math.floor(i / F.w);
      if (!F.centres.some((q) => Math.hypot(x - q.x, y - q.y) <= ARMPIT)) continue;
      n++;
      at ||= `${x},${y}`;
    }
    return { n, at };
  };
  const lumaOf = (F: ReturnType<typeof frame>) => (i: number) => {
    const d = F.R.image.data;
    return 0.3 * (d[i * 4] as number) + 0.59 * (d[i * 4 + 1] as number) + 0.11 * (d[i * 4 + 2] as number);
  };

  it("no painted ink shows inside the tank's line at either armpit (upper arm 16-61, both arms)", () => {
    const bad: string[] = [];
    for (const [u, f] of ARMPIT_POSES) {
      const F = frame(u, f);
      const t = ticks(F, lumaOf(F));
      if (t.n) bad.push(`u${u} f${f}: ${t.n} dark tank texels, first at ${t.at}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it("damaged control: a dark 3 px band beside the armhole stroke fails", () => {
    const F = frame(61, 35);
    const slots = F.R.topSlot as Int16Array;
    const texels = F.R.topTexel as Int32Array;
    const base = lumaOf(F);
    // tank texels within 3 px of a tank stroke pixel near the junction become ink
    const tank = new Set(sk.slots.filter((s) => /^tank/.test(s.data.name)).map((s) => s.index + 1));
    const dark = new Uint8Array(F.w * F.h);
    for (let i = 0; i < F.w * F.h; i++) {
      if (!tank.has(slots[i] as number) || (texels[i] as number) >= 0) continue;
      const x = i % F.w;
      const y = Math.floor(i / F.w);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= F.w || yy >= F.h) continue;
        const j = yy * F.w + xx;
        if (tank.has(slots[j] as number) && (texels[j] as number) >= 0) dark[j] = 1;
      }
    }
    const t = ticks(F, (i) => (dark[i] ? 30 : base(i)));
    expect(t.n).toBeGreaterThan(0);
  }, 120_000);
});
