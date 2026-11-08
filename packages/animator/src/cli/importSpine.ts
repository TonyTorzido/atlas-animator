/*
 * Atlas Animator: original implementation.
 *
 * `animator import-spine-clips <spine.json> --rig <rigdir|rig.anim.json> [--clips a,b] [--loop a,b] [--trim] [--dry-run]`
 *
 * The inverse of `export-spine` for animations: reads a Spine 4.x skeleton JSON (the export, edited in Spine, or a
 * clip authored there) and merges its animations into the rig document as `atlas-anim@1` clips.
 *
 * Kept: bone rotate / translate / scale / shear timelines (combined or per-axis, linear / stepped / bezier curves), IK and transform
 * constraint mix timelines, events. Dropped (warned): slot attachment / colour and draw-order timelines (export-spine bakes them from this
 * runtime's driven keys, which the runtime evaluates itself; an existing clip keeps its own), deform, physics, path, sequence, inherit.
 * The rig's setup pose, bones, slots and skins are never touched; a backup of the document is written first.
 *
 * Inverse conversions (see exportSpine.ts): the y mirror (rotation / shear / translate y negated), IK `bendPositive` inverted, and the weapon:
 * export moves the `weapon` bone's origin onto the grip, so rotating it pivots about the grip. The grip is recovered by comparing the Spine
 * setup bone with the rig bone; a rotating weapon then gets translate keys baked at every clip frame so the pose matches rotation about the
 * rig's own origin.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CurveSet } from "../core/curves.js";
import { DEFAULT_CLIP_FPS, type AnimDocument, type CurveSpec } from "../core/format.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { DEG_TO_RAD } from "../core/math.js";

type Json = Record<string, unknown>;

export interface SpineImportOptions {
  /** Spine skeleton JSON. */
  spine: string;
  /** Rig directory (holds `<dir name>.anim.json`, or the only `.anim.json`) or the document itself. */
  rig: string;
  /** Spine animations to import; default all. */
  clips?: string[];
  /** Clip names to mark looping when they are new (existing clips keep their flag). */
  loop?: string[];
  /** Use the Spine animation's end as the duration even when an existing clip is longer. */
  trim?: boolean;
  dryRun?: boolean;
}

export interface SpineImportedClip {
  name: string;
  replaced: boolean;
  duration: number;
  bones: number;
  ik: number;
  transform: number;
  events: number;
}

export interface SpineImportResult {
  document: string;
  backup: string | null;
  dryRun: boolean;
  clips: SpineImportedClip[];
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const num = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const numberOr = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function resolveRigDocument(rig: string): string {
  const path = resolve(rig);
  if (!existsSync(path)) throw new Error(`no rig at ${path}`);
  if (statSync(path).isFile()) return path;
  const named = join(path, `${basename(path)}.anim.json`);
  if (existsSync(named)) return named;
  const docs = readdirSync(path).filter((f) => f.endsWith(".anim.json"));
  if (docs.length === 1) return join(path, docs[0] as string);
  throw new Error(docs.length === 0 ? `no .anim.json in ${path}` : `several .anim.json in ${path} (${docs.join(", ")}); pass the document itself`);
}

/** One channel of a timeline: key times, values and the curve of the span after each key. */
interface Chan {
  times: number[];
  values: number[];
  spans: CurveSpec[];
}

const sameSpec = (a: CurveSpec, b: CurveSpec): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Spine curve of channel `c` of a key (to the next key) as a normalised spec. */
export function readCurve(key: Json, c: number, t0: number, t1: number, v0: number, v1: number, warn: (m: string) => void, where: string): CurveSpec {
  const curve = key.curve;
  if (curve === undefined || curve === null) return "linear";
  if (curve === "stepped") return "stepped";
  let p: number[] | null = null;
  if (Array.isArray(curve)) {
    const part = curve.slice(4 * c, 4 * c + 4);
    if (part.length === 4 && part.every((v) => typeof v === "number")) p = part as number[];
  } else if (typeof curve === "number") {
    // The 4.0-era form: `curve` is cx1, then c2 c3 c4 (cy1 cx2 cy2); further channels continue c5.. .
    const raw = c === 0 ? [curve, key.c2, key.c3, key.c4] : [4 * c + 1, 4 * c + 2, 4 * c + 3, 4 * c + 4].map((i) => key[`c${i}`]);
    if (raw.every((v) => typeof v === "number")) p = raw as number[];
  }
  if (!p) {
    warn(`${where}: curve not understood, imported linear`);
    return "linear";
  }
  const dt = t1 - t0;
  const dv = v1 - v0;
  if (dt <= 0) return "linear";
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  const rx1 = ((p[0] as number) - t0) / dt;
  const rx2 = ((p[2] as number) - t0) / dt;
  const cx1 = clamp(rx1);
  const cx2 = clamp(rx2);
  if (Math.abs(rx1 - cx1) > 1e-6 || Math.abs(rx2 - cx2) > 1e-6) warn(`${where}: bezier handle outside its time span, clamped`);
  // A flat span has no value change to take a fraction of; the handles' time fractions keep it a straight ramp.
  const cy1 = Math.abs(dv) < 1e-9 ? cx1 : ((p[1] as number) - v0) / dv;
  const cy2 = Math.abs(dv) < 1e-9 ? cx2 : ((p[3] as number) - v0) / dv;
  const out: [number, number, number, number] = [num(cx1), num(cy1), num(cx2), num(cy2)];
  const linear = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  if (out.every((v, i) => Math.abs(v - (linear[i] as number)) < 1e-5)) return "linear";
  return out;
}

/** Channels of a key array: `fields` give each channel's JSON name and default. Keys are sorted by time. */
function readChannels(
  keys: unknown,
  fields: readonly { name: string; def: number; alt?: string }[],
  warn: (m: string) => void,
  where: string
): Chan[] {
  const list = (Array.isArray(keys) ? keys : []).filter(isObject).sort((a, b) => numberOr(a.time, 0) - numberOr(b.time, 0));
  const chans: Chan[] = fields.map(() => ({ times: [], values: [], spans: [] }));
  for (const key of list) {
    const time = num(numberOr(key.time, 0));
    fields.forEach((f, c) => {
      const chan = chans[c] as Chan;
      chan.times.push(time);
      chan.values.push(numberOr(key[f.name] ?? (f.alt ? key[f.alt] : undefined), f.def));
    });
  }
  list.forEach((key, k) => {
    const next = list[k + 1];
    fields.forEach((_, c) => {
      const chan = chans[c] as Chan;
      chan.spans.push(
        next ? readCurve(key, c, chan.times[k] as number, chan.times[k + 1] as number, chan.values[k] as number, chan.values[k + 1] as number, warn, `${where} @${chan.times[k]}`) : "linear"
      );
    });
  });
  return chans;
}

const curves = new CurveSet(1, 1);
function fraction(spec: CurveSpec, u: number): number {
  curves.set(0, 0, spec);
  return curves.fraction(0, 0, Math.min(1, Math.max(0, u)));
}

/** Value of a channel at time t (first / last value outside the keys, the span's curve inside). */
function sampleChan(chan: Chan, t: number): number {
  const n = chan.times.length;
  if (n === 0) return 0;
  if (t <= (chan.times[0] as number)) return chan.values[0] as number;
  if (t >= (chan.times[n - 1] as number)) return chan.values[n - 1] as number;
  let k = 0;
  while (k + 1 < n && (chan.times[k + 1] as number) <= t) k++;
  const t0 = chan.times[k] as number;
  const t1 = chan.times[k + 1] as number;
  const v0 = chan.values[k] as number;
  const v1 = chan.values[k + 1] as number;
  return v0 + (v1 - v0) * fraction(chan.spans[k] as CurveSpec, (t - t0) / (t1 - t0));
}

interface MergedKey {
  time: number;
  values: number[];
  specs: CurveSpec[];
}

/**
 * Channels as one key list. Channels with the same key times merge exactly; otherwise the keys are the union of the times and a channel
 * without a key there is sampled (its curve over the inserted key is linear, or stepped when it was).
 */
function mergeChannels(chans: readonly (Chan | null)[], defaults: readonly number[], warn: (m: string) => void, where: string): MergedKey[] {
  const times = [...new Set(chans.flatMap((c) => c?.times ?? []))].sort((a, b) => a - b);
  let resampled = false;
  const keys: MergedKey[] = times.map((time) => ({
    time,
    values: chans.map((chan, c) => {
      if (!chan) return defaults[c] as number;
      const at = chan.times.indexOf(time);
      return at >= 0 ? (chan.values[at] as number) : sampleChan(chan, time);
    }),
    specs: chans.map((chan) => {
      if (!chan) return "linear";
      const at = chan.times.indexOf(time);
      if (at >= 0) return chan.spans[at] as CurveSpec;
      resampled = true;
      let k = 0;
      while (k + 1 < chan.times.length && (chan.times[k + 1] as number) <= time) k++;
      return time < (chan.times[0] as number) || time > (chan.times[chan.times.length - 1] as number) ? "linear" : chan.spans[k] === "stepped" ? "stepped" : "linear";
    })
  }));
  if (resampled) warn(`${where}: channels have different key times; keys were added and the inserted spans are linear`);
  return keys;
}

function collapse(names: readonly string[], specs: readonly CurveSpec[]): CurveSpec | Record<string, CurveSpec> {
  if (specs.every((s) => sameSpec(s, specs[0] as CurveSpec))) return specs[0] as CurveSpec;
  return Object.fromEntries(names.map((n, i) => [n, specs[i] as CurveSpec]));
}

function withCurve<T extends Json>(key: T, curve: unknown): T {
  if (curve !== "linear") (key as Json).curve = curve;
  return key;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

const AXES: readonly { target: "translate" | "scale" | "shear"; def: number; fx: (v: number) => number; fy: (v: number) => number }[] = [
  { target: "translate", def: 0, fx: num, fy: (v) => num(-v) },
  { target: "scale", def: 1, fx: num, fy: num },
  { target: "shear", def: 0, fx: (v) => num(-v), fy: (v) => num(-v) }
];

const TRANSFORM_CHANNELS = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const;

/** Grip of the weapon bone in its own frame (this format's y down), from the Spine setup bone moved onto it; null when it was not moved. */
function weaponGrip(doc: AnimDocument, spineBones: Json[]): { x: number; y: number; rotation: number } | null {
  const rig = doc.bones.find((b) => b.name === "weapon");
  const spine = spineBones.find((b) => b.name === "weapon");
  if (!rig || !spine) return null;
  const dx = numberOr(spine.x, 0) - rig.x;
  const dy = -numberOr(spine.y, 0) - rig.y;
  const r = rig.rotation * DEG_TO_RAD;
  const gx = Math.cos(r) * dx + Math.sin(r) * dy;
  const gy = -Math.sin(r) * dx + Math.cos(r) * dy;
  return Math.hypot(gx, gy) < 1e-4 ? null : { x: gx, y: gy, rotation: rig.rotation };
}

export function importSpineClips(options: SpineImportOptions): SpineImportResult {
  const warnings: string[] = [];
  const warn = (m: string): void => void warnings.push(m);
  const documentPath = resolveRigDocument(options.rig);
  const raw = JSON.parse(readFileSync(documentPath, "utf8")) as Json;
  const doc = loadAnimDocument(JSON.parse(JSON.stringify(raw)), { source: documentPath });
  const spine = JSON.parse(readFileSync(resolve(options.spine), "utf8")) as Json;
  const spineAnims = isObject(spine.animations) ? spine.animations : {};
  const spineBones = (Array.isArray(spine.bones) ? spine.bones : []).filter(isObject);
  const version = isObject(spine.skeleton) && typeof spine.skeleton.spine === "string" ? spine.skeleton.spine : "";
  if (version && !/^4\./.test(version)) warn(`Spine version ${version}: only 4.x JSON is read`);

  const names = options.clips ?? Object.keys(spineAnims);
  for (const n of names) if (!(n in spineAnims)) throw new Error(`no animation '${n}' in ${options.spine}; animations: ${Object.keys(spineAnims).join(", ") || "none"}`);

  const grip = weaponGrip(doc, spineBones);
  const boneNames = new Set(doc.bones.map((b) => b.name));
  const rawAnimations = isObject(raw.animations) ? raw.animations : {};
  const events: Json = isObject(raw.events) ? { ...raw.events } : {};
  const spineEvents = isObject(spine.events) ? spine.events : {};
  const imported: SpineImportedClip[] = [];
  const newAnimations: Json = { ...rawAnimations };

  for (const name of names) {
    const anim = spineAnims[name];
    if (!isObject(anim)) continue;
    const here = (m: string): void => warn(`clip '${name}': ${m}`);
    const existing = isObject(rawAnimations[name]) ? (rawAnimations[name] as Json) : null;
    const fps = typeof existing?.fps === "number" ? existing.fps : DEFAULT_CLIP_FPS;

    // Duration: the last key of any timeline, as Spine counts it.
    let end = 0;
    const touch = (list: unknown): void => {
      for (const k of Array.isArray(list) ? list : []) if (isObject(k)) end = Math.max(end, numberOr(k.time, 0));
    };
    const walk = (group: unknown): void => {
      if (!isObject(group)) return;
      for (const v of Object.values(group)) {
        if (Array.isArray(v)) touch(v);
        else if (isObject(v)) for (const inner of Object.values(v)) touch(inner);
      }
    };
    for (const part of ["bones", "slots", "ik", "transform", "constraints", "deform", "physics", "path"]) walk(anim[part]);
    touch(anim.events);
    touch(anim.drawOrder ?? anim.draworder);

    // ---- bones ----
    const bones: Json = {};
    const spineBoneTimelines = isObject(anim.bones) ? anim.bones : {};
    for (const [bone, tl] of Object.entries(spineBoneTimelines)) {
      if (!isObject(tl)) continue;
      if (!boneNames.has(bone)) {
        here(`bone '${bone}' is not in the rig, its timelines were skipped`);
        continue;
      }
      const out: Json = {};
      const where = `clip '${name}' bone '${bone}'`;
      const known = new Set(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary"]);
      for (const key of Object.keys(tl)) if (!known.has(key)) here(`bone '${bone}': '${key}' timeline is not supported and was dropped`);

      let rotate: Chan | null = null;
      if (Array.isArray(tl.rotate)) rotate = readChannels(tl.rotate, [{ name: "value", def: 0, alt: "angle" }], warn, `${where} rotate`)[0] as Chan;
      const axisKeys: Record<string, MergedKey[]> = {};
      for (const axis of AXES) {
        const combined = tl[axis.target];
        const xs = tl[`${axis.target}x`];
        const ys = tl[`${axis.target}y`];
        if (combined === undefined && xs === undefined && ys === undefined) continue;
        if (combined !== undefined && (xs !== undefined || ys !== undefined)) here(`bone '${bone}': both ${axis.target} and its per-axis timelines exist, the per-axis ones were dropped`);
        let chans: (Chan | null)[];
        if (combined !== undefined) {
          chans = readChannels(combined, [{ name: "x", def: axis.def }, { name: "y", def: axis.def }], warn, `${where} ${axis.target}`);
        } else {
          chans = [
            xs !== undefined ? (readChannels(xs, [{ name: "value", def: axis.def }], warn, `${where} ${axis.target}x`)[0] as Chan) : null,
            ys !== undefined ? (readChannels(ys, [{ name: "value", def: axis.def }], warn, `${where} ${axis.target}y`)[0] as Chan) : null
          ];
        }
        axisKeys[axis.target] = mergeChannels(chans, [axis.def, axis.def], warn, `${where} ${axis.target}`);
      }

      if (rotate && rotate.times.length > 0) {
        const r = rotate;
        out.rotate = r.times.map((time, k) => withCurve({ time, value: num(-(r.values[k] as number)) }, r.spans[k]));
      }
      for (const axis of AXES) {
        const keys = axisKeys[axis.target];
        if (!keys || keys.length === 0) continue;
        out[axis.target] = keys.map((k) => withCurve({ time: k.time, x: axis.fx(k.values[0] as number), y: axis.fy(k.values[1] as number) }, collapse(["x", "y"], k.specs)));
      }

      // The weapon bone pivots about the grip in the Spine data; the rig rotates it about its own origin.
      if (bone === "weapon" && grip && rotate && rotate.times.length > 0) {
        const r = rotate;
        if (tl.scale || tl.scalex || tl.scaley || tl.shear || tl.shearx || tl.sheary) here("weapon scale / shear keys are not corrected for the grip offset");
        const translateKeys = axisKeys.translate ?? [];
        const times = new Set<number>([...r.times, ...translateKeys.map((k) => k.time)]);
        const frames = Math.round(end * fps);
        for (let f = 0; f <= frames; f++) times.add(num(Math.min(f / fps, end)));
        const tchans: Chan[] | null =
          translateKeys.length > 0 ? [0, 1].map((c) => ({ times: translateKeys.map((k) => k.time), values: translateKeys.map((k) => k.values[c] as number), spans: translateKeys.map((k) => k.specs[c] as CurveSpec) })) : null;
        const turn = (a: number, x: number, y: number): [number, number] => [
          Math.cos(a * DEG_TO_RAD) * x - Math.sin(a * DEG_TO_RAD) * y,
          Math.sin(a * DEG_TO_RAD) * x + Math.cos(a * DEG_TO_RAD) * y
        ];
        out.translate = [...times]
          .sort((a, b) => a - b)
          .map((time) => {
            const angle = -sampleChan(r, time);
            const [ax, ay] = turn(grip.rotation, grip.x, grip.y);
            const [bx, by] = turn(grip.rotation + angle, grip.x, grip.y);
            const tx = tchans ? sampleChan(tchans[0] as Chan, time) : 0;
            const ty = tchans ? -sampleChan(tchans[1] as Chan, time) : 0;
            return { time, x: num(tx + ax - bx), y: num(ty + ay - by) };
          });
        here("weapon rotation pivots about the grip in Spine: translate keys were baked at every frame to rotate about the rig's origin");
      }
      if (Object.keys(out).length > 0) bones[bone] = out;
    }

    // ---- constraints ----
    const ik: Json = {};
    const transform: Json = {};
    const constraintSource = (kind: "ik" | "transform"): Json => {
      const direct = isObject(anim[kind]) ? (anim[kind] as Json) : {};
      const generic = isObject(anim.constraints) ? (anim.constraints as Json) : {};
      const merged: Json = { ...direct };
      for (const [cname, value] of Object.entries(generic)) {
        const isIk = doc.ik.some((c) => c.name === cname);
        const isTransform = doc.transform.some((c) => c.name === cname);
        if ((kind === "ik" && isIk) || (kind === "transform" && isTransform)) merged[cname] = value;
      }
      return merged;
    };
    for (const [cname, keys] of Object.entries(constraintSource("ik"))) {
      if (!doc.ik.some((c) => c.name === cname)) {
        here(`ik constraint '${cname}' is not in the rig, skipped`);
        continue;
      }
      if (!Array.isArray(keys)) {
        here(`ik constraint '${cname}': timeline form not understood, skipped`);
        continue;
      }
      const chans = readChannels(keys, [{ name: "mix", def: 1 }, { name: "softness", def: 0 }], warn, `clip '${name}' ik '${cname}'`);
      const merged = mergeChannels(chans, [1, 0], warn, `clip '${name}' ik '${cname}'`);
      const sorted = keys.filter(isObject).sort((a, b) => numberOr(a.time, 0) - numberOr(b.time, 0));
      if (merged.length === 0) continue;
      ik[cname] = merged.map((k, i) => {
        const src = (sorted[i] ?? {}) as Json;
        return withCurve(
          {
            time: k.time,
            mix: num(Math.min(1, Math.max(0, k.values[0] as number))),
            softness: num(Math.max(0, k.values[1] as number)),
            bendPositive: !(typeof src.bendPositive === "boolean" ? src.bendPositive : true),
            stretch: src.stretch === true,
            compress: src.compress === true
          },
          collapse(["mix", "softness"], k.specs)
        );
      });
    }
    for (const [cname, keys] of Object.entries(constraintSource("transform"))) {
      if (!doc.transform.some((c) => c.name === cname)) {
        here(`transform constraint '${cname}' is not in the rig, skipped`);
        continue;
      }
      if (!Array.isArray(keys)) {
        here(`transform constraint '${cname}': timeline form not understood, skipped`);
        continue;
      }
      // Spine: mixY follows mixX and mixScaleY follows mixScaleX when absent.
      const list = keys.filter(isObject).map((k) => ({ ...k, mixY: k.mixY ?? k.mixX ?? 1, mixScaleY: k.mixScaleY ?? k.mixScaleX ?? 1 }));
      const chans = readChannels(list, TRANSFORM_CHANNELS.map((n) => ({ name: n, def: 1 })), warn, `clip '${name}' transform '${cname}'`);
      const merged = mergeChannels(chans, TRANSFORM_CHANNELS.map(() => 1), warn, `clip '${name}' transform '${cname}'`);
      if (merged.length === 0) continue;
      transform[cname] = merged.map((k) => {
        const key: Json = { time: k.time };
        TRANSFORM_CHANNELS.forEach((n, i) => (key[n] = num(Math.min(1, Math.max(0, k.values[i] as number)))));
        return withCurve(key, collapse(TRANSFORM_CHANNELS, k.specs));
      });
    }

    // ---- path constraints ----
    const pathOut: Json = {};
    const PATH_CH = ["position", "spacing", "mixRotate", "mixX", "mixY"] as const;
    const pathSource: Json = isObject(anim.path) ? { ...(anim.path as Json) } : {};
    if (isObject(anim.constraints)) for (const [cname, value] of Object.entries(anim.constraints)) if (doc.path.some((c) => c.name === cname)) pathSource[cname] = value;
    for (const [cname, tl] of Object.entries(pathSource)) {
      const setup = doc.path.find((c) => c.name === cname);
      if (!setup) {
        here(`path constraint '${cname}' is not in the rig, skipped`);
        continue;
      }
      if (!isObject(tl)) {
        here(`path constraint '${cname}': timeline form not understood, skipped`);
        continue;
      }
      const where = `clip '${name}' path '${cname}'`;
      const chans = [
        tl.position ? readChannels(tl.position, [{ name: "value", def: setup.position }], warn, where)[0] : null,
        tl.spacing ? readChannels(tl.spacing, [{ name: "value", def: setup.spacing }], warn, where)[0] : null,
        ...(tl.mix
          ? readChannels(tl.mix, [{ name: "mixRotate", def: setup.mixRotate }, { name: "mixX", def: setup.mixX }, { name: "mixY", def: setup.mixY, alt: "mixX" }], warn, where)
          : [null, null, null])
      ] as (Chan | null)[];
      const merged = mergeChannels(chans, [setup.position, setup.spacing, setup.mixRotate, setup.mixX, setup.mixY], warn, where);
      if (merged.length === 0) continue;
      pathOut[cname] = merged.map((k) => {
        const key: Json = { time: k.time };
        PATH_CH.forEach((n, i) => {
          const v = k.values[i] as number;
          key[n] = num(i >= 2 ? Math.min(1, Math.max(0, v)) : v);
        });
        return withCurve(key, collapse(PATH_CH, k.specs));
      });
    }

    // ---- events ----
    const eventKeys: Json[] = [];
    for (const e of (Array.isArray(anim.events) ? anim.events : []).filter(isObject).sort((a, b) => numberOr(a.time, 0) - numberOr(b.time, 0))) {
      const ename = typeof e.name === "string" ? e.name : "";
      if (!ename) continue;
      if (!(ename in events)) {
        const def = isObject(spineEvents[ename]) ? (spineEvents[ename] as Json) : {};
        events[ename] = {
          ...(typeof def.int === "number" && def.int !== 0 ? { int: Math.round(def.int) } : {}),
          ...(typeof def.float === "number" && def.float !== 0 ? { float: def.float } : {}),
          ...(typeof def.string === "string" && def.string !== "" ? { string: def.string } : {}),
          ...(typeof def.audio === "string" && def.audio !== "" ? { audio: def.audio } : {})
        };
        here(`event '${ename}' was added to the rig's event list`);
      }
      const key: Json = { time: num(numberOr(e.time, 0)), name: ename };
      if (typeof e.int === "number") key.int = Math.round(e.int);
      if (typeof e.float === "number") key.float = e.float;
      if (typeof e.string === "string") key.string = e.string;
      if (e.volume !== undefined || e.balance !== undefined) here(`event '${ename}': volume / balance dropped`);
      eventKeys.push(key);
    }

    // ---- what is dropped ----
    const orderKeys = anim.drawOrder ?? anim.draworder;
    const slotCount = isObject(anim.slots) ? Object.keys(anim.slots).length : 0;
    const orderCount = Array.isArray(orderKeys) ? orderKeys.length : 0;
    // Image-sequence keys (Batch 12a): read onto slots of the rig that show a sequence; the rest of the slot timelines are dropped.
    const sequenceSlots: Json = {};
    const rigSequenceSlots = new Set<string>();
    for (const skin of Object.values(isObject(raw.skins) ? raw.skins : {})) {
      for (const [slot, byName] of Object.entries(isObject(skin) && isObject(skin.attachments) ? skin.attachments : {})) {
        if (Object.values(isObject(byName) ? byName : {}).some((a) => isObject(a) && isObject(a.sequence))) rigSequenceSlots.add(slot);
      }
    }
    let sequenceKeys = 0;
    for (const [slot, tl] of Object.entries(isObject(anim.slots) ? anim.slots : {})) {
      if (!isObject(tl) || !Array.isArray(tl.sequence)) continue;
      if (!rigSequenceSlots.has(slot)) {
        here(`slot '${slot}': the rig shows no image sequence there, its sequence keys were skipped`);
        continue;
      }
      const keys = tl.sequence.filter(isObject).map((k) => {
        const mode = String(k.mode ?? "hold");
        const base = mode.replace(/Reverse$/, "");
        if (mode !== base) here(`slot '${slot}': sequence mode '${mode}' has no reverse here, '${base}' used`);
        return { time: num(typeof k.time === "number" ? k.time : 0), mode: ["hold", "once", "loop", "pingpong"].includes(base) ? base : "hold", index: Math.max(0, Math.round(typeof k.index === "number" ? k.index : 0)), delay: num(typeof k.delay === "number" ? k.delay : 0) };
      });
      if (keys.length > 0) {
        sequenceSlots[slot] = { sequence: keys };
        sequenceKeys += keys.length;
      }
    }
    if (slotCount > 0 || orderCount > 0) {
      here(`${slotCount} slot timeline(s) and ${orderCount} draw-order key(s) dropped${existing ? " (the clip keeps its own)" : " (a new clip has none: the runtime's driven keys decide pieces)"}`);
    }
    for (const part of ["deform", "physics"]) {
      const v = anim[part];
      if (isObject(v) && Object.keys(v).length > 0) here(`'${part}' timelines are not supported and were dropped`);
    }

    // ---- merge ----
    const prior: Json = existing ?? {};
    if (Array.isArray(prior.events) && prior.events.length > 0 && eventKeys.length === 0) here(`the clip's ${prior.events.length} event(s) were replaced by Spine's (none)`);
    let duration = num(end);
    const priorDuration = typeof prior.duration === "number" ? prior.duration : 0;
    if (existing && priorDuration > duration && !options.trim) {
      here(`Spine's animation ends at ${duration}s, shorter than the clip's ${priorDuration}s: kept ${priorDuration}s (--trim uses Spine's)`);
      duration = priorDuration;
    }
    const clip: Json = {
      ...prior,
      duration,
      loop: typeof prior.loop === "boolean" ? prior.loop : (options.loop ?? []).includes(name),
      bones,
      ik,
      transform,
      path: pathOut,
      events: eventKeys
    };
    if (sequenceKeys > 0) {
      const priorSlots = isObject(prior.slots) ? prior.slots : {};
      const slots: Json = { ...priorSlots };
      for (const [slot, tl] of Object.entries(sequenceSlots)) slots[slot] = { ...(isObject(priorSlots[slot]) ? (priorSlots[slot] as Json) : {}), ...(tl as Json) };
      clip.slots = slots;
    }
    for (const field of ["ik", "transform", "path", "events"]) {
      const v = clip[field];
      const empty = Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0;
      if (empty && !(field in prior)) delete clip[field];
    }
    newAnimations[name] = clip;
    imported.push({ name, replaced: existing !== null, duration, bones: Object.keys(bones).length, ik: Object.keys(ik).length, transform: Object.keys(transform).length, events: eventKeys.length });
  }

  // Validate before anything is written.
  const merged: Json = { ...raw, animations: newAnimations };
  if (Object.keys(events).length > 0) merged.events = events;
  loadAnimDocument(JSON.parse(JSON.stringify(merged)), { source: documentPath });

  let backup: string | null = null;
  if (!options.dryRun) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    backup = `${documentPath}.bak-${stamp}`;
    copyFileSync(documentPath, backup);
    writeFileSync(documentPath, `${JSON.stringify(merged, null, 1)}\n`);
  }
  return { document: documentPath, backup, dryRun: options.dryRun === true, clips: imported, warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

export async function importSpineCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [spine] = positional;
  const rig = flags.get("rig");
  if (!spine || typeof rig !== "string") {
    process.stderr.write("usage: animator import-spine-clips <spine.json> --rig <rigdir|rig.anim.json> [--clips a,b] [--loop a,b] [--trim] [--dry-run]\n");
    return 2;
  }
  const list = (name: string): string[] | undefined => {
    const v = flags.get(name);
    return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  };
  const options: SpineImportOptions = { spine, rig };
  const clips = list("clips");
  const loop = list("loop");
  if (clips) options.clips = clips;
  if (loop) options.loop = loop;
  if (flags.has("trim")) options.trim = true;
  if (flags.has("dry-run")) options.dryRun = true;
  const result = importSpineClips(options);
  process.stdout.write(`spine import${result.dryRun ? " (dry run, nothing written)" : ""}: ${result.document}\n`);
  if (result.backup) process.stdout.write(`  backup: ${result.backup}\n`);
  for (const c of result.clips) {
    process.stdout.write(`  ${c.replaced ? "replaced" : "added"} '${c.name}': ${c.duration}s, ${c.bones} bone(s), ${c.ik} ik, ${c.transform} transform, ${c.events} event(s)\n`);
  }
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  return 0;
}
