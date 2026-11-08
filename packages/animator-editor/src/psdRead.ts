/*
 * Atlas Animator editor: a small PSD reader for the New rig parts import (pure; works in the browser and in Node).
 *
 * Reads 8-bit RGB(A) PSD files (version 1): the canvas size and every pixel layer with its rectangle and straight RGBA pixels, raw or
 * PackBits-compressed. Layers come back in FILE order, which is bottom first: the first record is the back-most layer, so the list is
 * already back-to-front (what the rig wants: last = front). Group dividers and empty layers are skipped. No dependency: the format is
 * a flat sequence of big-endian fields, and the editor only needs rectangles and pixels.
 */
export interface PsdLayer {
  name: string;
  /** Canvas pixels, top-left origin, y down. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Straight RGBA, width * height * 4. */
  rgba: Uint8ClampedArray;
}

/** Something in the PSD the New rig import does not reproduce (): the layer pixels are taken raw, so these change how the art looks. */
export interface PsdIssue {
  layer: string;
  kind: "blend" | "opacity" | "clipping" | "hidden" | "mask" | "effects" | "group" | "text" | "smart" | "adjustment" | "fill" | "vector";
  /** What was found, in plain words (the report line). */
  detail: string;
}

export interface PsdFile {
  width: number;
  height: number;
  /** Back to front. */
  layers: PsdLayer[];
  /** Composition properties the import ignores, one entry per layer and property. */
  issues: PsdIssue[];
}

const BLEND_NAMES: Record<string, string> = { pass: "pass through", norm: "normal", diss: "dissolve", dark: "darken", "mul ": "multiply", idiv: "colour burn", lbrn: "linear burn", dkCl: "darker colour", lite: "lighten", scrn: "screen", div: "colour dodge", lddg: "linear dodge", lgCl: "lighter colour", over: "overlay", sLit: "soft light", hLit: "hard light", vLit: "vivid light", lLit: "linear light", pLit: "pin light", hMix: "hard mix", diff: "difference", smud: "exclusion", fsub: "subtract", fdiv: "divide", "hue ": "hue", "sat ": "saturation", "colr": "colour", "lum ": "luminosity" };
const EFFECT_KEYS = new Set(["lrFX", "lfx2", "lmfx"]);
const ADJUST_KEYS = new Set(["brit", "levl", "curv", "expA", "hue2", "hue ", "blnc", "blwh", "phfl", "mixr", "clrL", "nvrt", "post", "thrs", "grdm", "selc", "vibA"]);

export class PsdError extends Error {}

export function readPsd(buffer: ArrayBuffer | Uint8Array): PsdFile {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u8 = () => view.getUint8(p++);
  const u16 = () => {
    const v = view.getUint16(p);
    p += 2;
    return v;
  };
  const i16 = () => {
    const v = view.getInt16(p);
    p += 2;
    return v;
  };
  const u32 = () => {
    const v = view.getUint32(p);
    p += 4;
    return v;
  };
  const i32 = () => {
    const v = view.getInt32(p);
    p += 4;
    return v;
  };
  const tag = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8());
    return s;
  };
  const skip = (n: number) => {
    p += n;
  };
  if (bytes.length < 26 || tag(4) !== "8BPS") throw new PsdError("not a PSD file");
  if (u16() !== 1) throw new PsdError("PSB (large document) files are not supported");
  p += 6;
  u16(); // channels of the composite
  const height = u32();
  const width = u32();
  if (u16() !== 8) throw new PsdError("only 8-bit PSD files are supported");
  if (u16() !== 3) throw new PsdError("only RGB PSD files are supported");
  skip(u32()); // colour mode data
  skip(u32()); // image resources
  const miscLen = u32();
  const miscEnd = p + miscLen;
  if (miscLen === 0) return { width, height, layers: [], issues: [] };
  const infoLen = u32();
  const infoEnd = p + infoLen;
  const count = Math.abs(i16());
  interface Rec {
    name: string;
    top: number;
    left: number;
    bottom: number;
    right: number;
    channels: { id: number; length: number }[];
    divider: boolean;
  }
  const recs: Rec[] = [];
  const issues: PsdIssue[] = [];
  for (let i = 0; i < count; i++) {
    const top = i32();
    const left = i32();
    const bottom = i32();
    const right = i32();
    const n = u16();
    const channels: { id: number; length: number }[] = [];
    for (let c = 0; c < n; c++) channels.push({ id: i16(), length: u32() });
    if (tag(4) !== "8BIM") throw new PsdError("bad layer record");
    const blend = tag(4);
    const opacity = u8();
    const clipping = u8();
    const flags = u8();
    p += 1; // filler
    const extraLen = u32();
    const extraEnd = p + extraLen;
    const maskLen = u32();
    skip(maskLen); // mask
    skip(u32()); // blending ranges
    const nameLen = u8();
    let name = "";
    for (let k = 0; k < nameLen; k++) name += String.fromCharCode(u8());
    // Additional layer information follows the name (padded to 4 bytes with its length byte): section dividers, effects, text, fills.
    const found = new Set<string>();
    let divider = 0;
    try {
      const rangesLen = view.getUint32(extraEnd - extraLen + 4 + maskLen);
      let q = extraEnd - extraLen + 4 + maskLen + 4 + rangesLen;
      q += (1 + nameLen + 3) & ~3;
      while (q + 12 <= extraEnd) {
        const sig = String.fromCharCode(bytes[q]!, bytes[q + 1]!, bytes[q + 2]!, bytes[q + 3]!);
        if (sig !== "8BIM" && sig !== "8B64") break;
        const key = String.fromCharCode(bytes[q + 4]!, bytes[q + 5]!, bytes[q + 6]!, bytes[q + 7]!);
        const len = view.getUint32(q + 8);
        found.add(key);
        if ((key === "lsct" || key === "lsdk") && len >= 4) divider = view.getUint32(q + 12);
        q += 12 + len + (len % 2);
      }
    } catch {
      // A damaged tail: report what was read.
    }
    const flag = (kind: PsdIssue["kind"], detail: string): void => void issues.push({ layer: name, kind, detail });
    if (divider === 1 || divider === 2) flag("group", `group '${name}': its layers are imported as separate parts and the group's own blend, opacity and mask are ignored`);
    else if (divider === 3) {
      // The closing marker of a group has no pixels and no name worth reporting.
    } else {
      if (blend !== "norm" && blend !== "pass") flag("blend", `blend mode ${BLEND_NAMES[blend] ?? blend.trim()} is ignored: the layer is imported as normal`);
      if (opacity < 255) flag("opacity", `opacity ${Math.round((opacity / 255) * 100)}% is ignored: the pixels are imported at full strength`);
      if (clipping !== 0) flag("clipping", "clipped to the layer below: the clip is not applied");
      if ((flags & 2) !== 0) flag("hidden", "hidden in the PSD but imported as a part (delete it in Setup or hide it in the PSD first)");
      if (maskLen > 0) flag("mask", "has a layer mask: the mask is not applied, the raw pixels are imported");
      if ([...found].some((k) => EFFECT_KEYS.has(k))) flag("effects", "has layer effects (shadow, glow, stroke...): they are not drawn into the part");
      if (found.has("TySh") || found.has("tySh")) flag("text", "is a text layer: only its rendered pixels are imported");
      if (found.has("SoLd") || found.has("PlLd") || found.has("PxSD")) flag("smart", "is a smart object: only its rendered pixels are imported");
      if ([...found].some((k) => ADJUST_KEYS.has(k))) flag("adjustment", "is an adjustment layer: it is not applied to the layers below");
      if (found.has("SoCo") || found.has("GdFl") || found.has("PtFl")) flag("fill", "is a fill layer: its colour or gradient is not imported");
      if (found.has("vmsk") || found.has("vsms")) flag("vector", "has a vector mask: it is not applied");
    }
    p = extraEnd;
    // Section dividers (groups) carry no pixels; their record is a zero-size rectangle.
    recs.push({ name, top, left, bottom, right, channels, divider: false });
  }
  const layers: PsdLayer[] = [];
  for (const r of recs) {
    const w = Math.max(0, r.right - r.left);
    const h = Math.max(0, r.bottom - r.top);
    const planes = new Map<number, Uint8Array>();
    for (const ch of r.channels) {
      const end = p + ch.length;
      if (w > 0 && h > 0 && ch.length >= 2) {
        const comp = u16();
        const plane = new Uint8Array(w * h);
        if (comp === 0) plane.set(bytes.subarray(p, p + w * h));
        else if (comp === 1) {
          const counts: number[] = [];
          for (let y = 0; y < h; y++) counts.push(u16());
          let o = 0;
          for (let y = 0; y < h; y++) {
            const rowEnd = p + counts[y]!;
            let x = 0;
            while (p < rowEnd && x < w) {
              const n = view.getInt8(p++);
              if (n >= 0) {
                for (let k = 0; k <= n && x < w; k++) plane[o + x++] = bytes[p++]!;
              } else if (n !== -128) {
                const v = bytes[p++]!;
                for (let k = 0; k < 1 - n && x < w; k++) plane[o + x++] = v;
              }
            }
            p = rowEnd;
            o += w;
          }
        } else throw new PsdError(`layer '${r.name}' uses unsupported compression ${comp}`);
        planes.set(ch.id, plane);
      }
      p = end;
    }
    if (w === 0 || h === 0) continue;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const R = planes.get(0);
    const G = planes.get(1);
    const B = planes.get(2);
    const A = planes.get(-1);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = R?.[i] ?? 0;
      rgba[i * 4 + 1] = G?.[i] ?? 0;
      rgba[i * 4 + 2] = B?.[i] ?? 0;
      rgba[i * 4 + 3] = A ? A[i]! : 255;
    }
    layers.push({ name: r.name, left: r.left, top: r.top, width: w, height: h, rgba });
  }
  void infoEnd;
  void miscEnd;
  return { width, height, layers, issues };
}

/** The report text for the New rig dialog: one line per issue, grouped by layer, or a single "nothing ignored" line. */
export function psdReportLines(issues: readonly PsdIssue[]): string[] {
  if (!issues.length) return ["Nothing is ignored: every layer is plain pixels at full strength."];
  const by = new Map<string, string[]>();
  for (const i of issues) by.set(i.layer, [...(by.get(i.layer) ?? []), i.detail]);
  return [...by].map(([layer, details]) => `${layer}: ${details.join("; ")}`);
}
