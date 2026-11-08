import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { MutableImage } from "./image.js";
import { readPng } from "./png.js";
import { checkHolesAndSeeThrough, checkOutlineContrast, checkPaintOutsideAllowed, checkPaletteOutliers, checkRegistration, runSwagChecks } from "./swagChecks.js";
import { loadSwagContext, renderGuide, type SwagContext } from "./swagGuide.js";
import { DEFAULT_BODY_RIG, DEFAULT_DOMAIN, SWAG_RULES_DIR } from "./swagTypes.js";

/*
 * Swag checks (swag-rules/STYLE.md): each check must pass on the approved jacket and fail, with a plain-English reason, on a deliberately damaged copy.
 */
const GOOD = `${SWAG_RULES_DIR}examples/good/kungfu-jacket-approved.png`;
const have = existsSync(GOOD) && existsSync(DEFAULT_BODY_RIG) && existsSync(DEFAULT_DOMAIN);

const clone = (img: MutableImage): MutableImage => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });
const idx = (img: MutableImage, x: number, y: number) => (y * img.width + x) * 4;

/** Fills a rectangle with one colour. */
function rect(img: MutableImage, x0: number, y0: number, w: number, h: number, c: [number, number, number, number]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(c, idx(img, x, y));
}

/** Moves the art by (dx, dy) whole pixels. */
function shifted(img: MutableImage, dx: number, dy: number): MutableImage {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) } as MutableImage;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = x - dx;
    const sy = y - dy;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    out.data.set(img.data.subarray(idx(img, sx, sy), idx(img, sx, sy) + 4), idx(out, x, y));
  }
  return out;
}

/** Scales the art about the canvas point (cx, cy) by k (nearest neighbour). */
function scaled(img: MutableImage, k: number, cx: number, cy: number): MutableImage {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) } as MutableImage;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = Math.round(cx + (x - cx) / k);
    const sy = Math.round(cy + (y - cy) / k);
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    out.data.set(img.data.subarray(idx(img, sx, sy), idx(img, sx, sy) + 4), idx(out, x, y));
  }
  return out;
}

describe("swag checks", () => {
  it("has its fixtures (a missing fixture fails, never skips)", () => {
    expect(have).toBe(true);
  });

  let ctx: SwagContext;
  let good: MutableImage;
  beforeAll(() => {
    ctx = loadSwagContext({ rigPath: DEFAULT_BODY_RIG, domainPath: DEFAULT_DOMAIN });
    good = readPng(GOOD);
  });

  it("the guide has the standard size and an allowed area that contains the body core", () => {
    expect([ctx.width, ctx.height]).toEqual([1086, 1448]);
    let allowed = 0;
    let coreOutside = 0;
    for (let i = 0; i < ctx.allowed.length; i++) { if (ctx.allowed[i]) allowed++; if (ctx.core[i] && !ctx.allowed[i]) coreOutside++; }
    expect(allowed).toBeGreaterThan(50_000);
    expect(coreOutside).toBe(0);
    const g = renderGuide(ctx);
    expect([g.width, g.height]).toEqual([1086, 1448]);
  });

  it("every check passes on the approved jacket", () => {
    const r = runSwagChecks(good, ctx);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("outline contrast: any hue passes when darker than the fill; fails on an outline as light as the fill", () => {
    const r = checkOutlineContrast(good, ctx); // the approved jacket's red-brown outline is fine: it is darker
    expect(r.pass).toBe(true);
    const light = clone(good);
    for (let i = 0; i < light.data.length; i += 4) if (light.data[i + 3] && light.data[i] === 53 && light.data[i + 1] === 15) light.data.set([150, 150, 160], i);
    const l = checkOutlineContrast(light, ctx);
    expect(l.pass).toBe(false);
    expect(l.reason).toMatch(/not dark enough/);
    const none = checkOutlineContrast({ width: good.width, height: good.height, data: new Uint8Array(good.data.length) }, ctx);
    expect(none.pass).toBe(false);
  });

  it("palette outliers: fails on a gradient and on noise", () => {
    const grad = clone(good);
    for (let y = 700; y < 900; y++) for (let x = 440; x < 530; x++) {
      const o = idx(grad, x, y);
      if (grad.data[o + 3] === 255 && (grad.data[o + 2] as number) >= 0x30 && (grad.data[o] as number) < 0x40) grad.data.set([40 + (y - 700), 40 + (x - 440) * 2, 200 - (y - 700)], o);
    }
    const a = checkPaletteOutliers(grad, ctx);
    expect(a.pass).toBe(false);
    expect(a.reason).toMatch(/flat cel shading/);
    const noisy = clone(good);
    let s = 7;
    for (let i = 0; i < noisy.data.length; i += 4) if (noisy.data[i + 3] === 255) { s = (s * 1103515245 + 12345) & 0x7fffffff; noisy.data.set([s & 255, (s >> 8) & 255, (s >> 16) & 255], i); }
    expect(checkPaletteOutliers(noisy, ctx).pass).toBe(false);
  });

  it("paint outside the allowed area: fails on a block filling the arm gap and on a bulging sleeve", () => {
    const block = clone(good);
    rect(block, 400, 835, 60, 80, [44, 44, 52, 255]); // fills the left arm/torso gap and the area beside it
    const r = checkPaintOutsideAllowed(block, ctx);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/outside the allowed area/);
    const wide = clone(good);
    rect(wide, 250, 760, 80, 100, [44, 44, 52, 255]); // a flared sleeve far past the arm
    expect(checkPaintOutsideAllowed(wide, ctx).pass).toBe(false);
  });

  it("paint outside the allowed area: the canvas border is not allowed (an empty allowed area allows nothing)", () => {
    const corner = { width: ctx.width, height: ctx.height, data: new Uint8Array(ctx.width * ctx.height * 4) };
    corner.data.set([40, 40, 40, 255], 0);
    const empty = { width: ctx.width, height: ctx.height, allowed: new Uint8Array(ctx.width * ctx.height), overflow: new Uint8Array(ctx.width * ctx.height) };
    const r = checkPaintOutsideAllowed(corner, empty);
    expect(r.metrics.outsidePx).toBe(1);
    expect(checkPaintOutsideAllowed(corner, empty, { maxOutsidePx: 0 }).pass).toBe(false);
    const edge = clone(good);
    rect(edge, ctx.width - 6, 300, 6, 40, [40, 40, 40, 255]); // paint on the right canvas edge, far from the item
    expect(checkPaintOutsideAllowed(edge, ctx).metrics.outsidePx).toBe((checkPaintOutsideAllowed(good, ctx).metrics.outsidePx as number) + 240);
  });

  it("paint outside the allowed area: passes where the user declared an overflow zone", () => {
    const wide = clone(good);
    rect(wide, 250, 760, 80, 100, [44, 44, 52, 255]);
    const zone = new Uint8Array(ctx.overflow);
    for (let y = 740; y < 900; y++) for (let x = 240; x < 340; x++) zone[y * ctx.width + x] = 1;
    expect(checkPaintOutsideAllowed(wide, { ...ctx, overflow: zone }).pass).toBe(true);
  });

  it("holes and see-through: fails on an enclosed hole and on a semi-transparent patch", () => {
    const hole = clone(good);
    rect(hole, 500, 760, 24, 24, [0, 0, 0, 0]); // a hole in the torso
    const h = checkHolesAndSeeThrough(hole, ctx);
    expect(h.pass).toBe(false);
    expect(h.reason).toMatch(/hole/);
    const ghost = clone(good);
    for (let y = 760; y < 800; y++) for (let x = 560; x < 600; x++) { const o = idx(ghost, x, y); if (ghost.data[o + 3] === 255) ghost.data[o + 3] = 200; }
    const g = checkHolesAndSeeThrough(ghost, ctx);
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/semi-transparent/);
  });

  it("cracks: fails on a slit open to the item's edge (not an enclosed hole)", () => {
    // an 80 px long, 4 px wide transparent slit cut in from the left flank of the torso
    const slit = clone(good);
    let x0 = 0;
    for (let x = 300; x < 600; x++) if (good.data[idx(good, x, 800) + 3] === 255 && ctx.required[800 * ctx.width + x + 30]) { x0 = x; break; }
    expect(x0).toBeGreaterThan(0);
    rect(slit, x0, 798, 80, 4, [0, 0, 0, 0]);
    const r = checkHolesAndSeeThrough(slit, ctx);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/slit/);
    expect(runSwagChecks(slit, ctx).passed).toBe(false);
  });

  it("cracks and registration: dropping the art's top quarter inside the neck and shoulder zone fails", () => {
    let y0 = ctx.height;
    let y1 = 0;
    for (let i = 0; i < ctx.allowed.length; i++) if (ctx.allowed[i]) { const y = Math.floor(i / ctx.width); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cut = y0 + Math.round((y1 - y0) / 4);
    const top = clone(good);
    for (let y = 0; y < cut; y++) for (let x = 0; x < ctx.width; x++) if (ctx.neckZone[y * ctx.width + x]) top.data[idx(top, x, y) + 3] = 0;
    const reg = checkRegistration(top, ctx);
    expect(reg.pass).toBe(false);
    expect(reg.reason).toMatch(/covers only/);
    expect(checkHolesAndSeeThrough(top, ctx).pass).toBe(false);
    expect(runSwagChecks(top, ctx).passed).toBe(false);
  });

  it("registration: paint inside a declared overflow zone is not counted as scale drift", () => {
    const wide = clone(good);
    rect(wide, 250, 760, 80, 100, [44, 44, 52, 255]);
    const zone = new Uint8Array(ctx.overflow);
    for (let y = 740; y < 900; y++) for (let x = 240; x < 340; x++) zone[y * ctx.width + x] = 1;
    expect(checkRegistration(wide, ctx).pass).toBe(false); // undeclared: the item is too wide
    const r = checkRegistration(wide, { ...ctx, overflow: zone });
    expect(r.pass).toBe(true);
    expect(r.metrics.overflowPx).toBeGreaterThan(0);
  });

  it("registration: fails on an offset, on scale drift, and on a wrong canvas size", () => {
    const off = checkRegistration(shifted(good, 8, -7), ctx);
    expect(off.pass).toBe(false);
    expect(off.reason).toMatch(/too far/);
    const big = checkRegistration(scaled(good, 1.12, 543, 800), ctx);
    expect(big.pass).toBe(false);
    const small = checkRegistration(scaled(good, 0.85, 543, 800), ctx);
    expect(small.pass).toBe(false);
    const wrong = checkRegistration({ width: 500, height: 500, data: new Uint8Array(500 * 500 * 4) }, ctx);
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toMatch(/exactly 1086x1448/);
  });
});
