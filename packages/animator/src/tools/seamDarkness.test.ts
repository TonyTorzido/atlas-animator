import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writePng } from "./png.js";

/*
 * scripts/polish-seam-ink.py check: near-seam darkness is judged per material, each material
 * against its own interior. A two-material garment (steel plate meeting cloth sleeves on the seam, with an
 * antialiased edge) passes; a dark band on either side of that seam still fails.
 */
const SCRIPT = fileURLToPath(new URL("../../scripts/polish-seam-ink.py", import.meta.url));
const W = 200, H = 120, SEAM = 90;
const SLEEVE = [86, 101, 119], STEEL = [194, 204, 212];

function garment(paint: (x: number, y: number) => number[]): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...paint(x, y), 255], (y * W + x) * 4);
  return { width: W, height: H, data };
}
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + ((b[i] as number) - v) * t));
// sleeve left of the seam, steel right of it, a 2 px antialiased edge on the seam
const twoMaterial = (x: number) => (x < SEAM - 1 ? SLEEVE : x > SEAM ? STEEL : mix(SLEEVE, STEEL, x === SEAM - 1 ? 0.33 : 0.67));

function check(paint: (x: number, y: number) => number[], extra: string[] = []): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "seam-"));
  writePng(join(dir, "tex.png"), garment(paint));
  const mask = new Uint8Array(W * H * 4);
  for (let y = 15; y < H - 15; y++) for (const x of [SEAM - 1, SEAM]) mask.set([255, 255, 255, 255], (y * W + x) * 4);
  writePng(join(dir, "mask.png"), { width: W, height: H, data: mask });
  const r = spawnSync("python", [SCRIPT, "check", join(dir, "tex.png"), join(dir, "mask.png"), "--rect", `0,0,${W},${H}`, ...extra], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// The seam check is a Python script (numpy, Pillow, scipy); skip when those are not installed.
const PYTHON_DEPS = spawnSync("python", ["-c", "import numpy, PIL, scipy"], { encoding: "utf8" }).status === 0;

describe.skipIf(!PYTHON_DEPS)("seam darkness check (per material)", { timeout: 30_000 }, () => {
  it("a clean two-material seam passes", () => {
    const r = check((x) => twoMaterial(x));
    expect(r.out).toMatch(/PASS/);
    expect(r.status).toBe(0);
  });

  it("a dark band on the sleeve side of a two-material seam fails", () => {
    const r = check((x, y) => (x >= SEAM - 6 && x < SEAM - 1 && y > 30 && y < 90 ? [62, 72, 84] : twoMaterial(x)));
    expect(r.out).toMatch(/FAIL/);
    expect(r.status).toBe(1);
  });

  // (premium kung-fu jacket): a near-black fabric (lum 47) sits below the default lum > 60 interior
  // cut, so without --ink the check cannot see it; with --ink (the outline colour) it is measured
  const BLACK = [47, 47, 51], INK = [42, 18, 10];
  const blackSmudge = (x: number, y: number) => (x >= SEAM - 5 && x <= SEAM + 4 && y > 30 && y < 90 ? [30, 30, 33] : BLACK);
  const blackInkTrim = (x: number, y: number) => (x >= 20 && x < 26 ? INK : BLACK); // ink line work far from the seam

  it("a near-black garment: without --ink the check warns that it cannot see the fabric", () => {
    const r = check(blackSmudge);
    expect(r.out).toMatch(/WARNING .* not measured/);
  });

  it("a near-black garment with --ink: a clean seam passes, ink trim away from it is ignored", () => {
    const r = check(blackInkTrim, ["--ink", INK.join(",")]);
    expect(r.out).toMatch(/PASS/);
    expect(r.status).toBe(0);
  });

  it("a near-black garment with --ink: a dark smudge along the seam fails", () => {
    const r = check(blackSmudge, ["--ink", INK.join(",")]);
    expect(r.out).toMatch(/FAIL/);
    expect(r.status).toBe(1);
  });

  //: the --ink override is per material. Mail (and lamellar) is an intrinsically dark pattern: its ring gaps
  // (luminance < 60) are the material, not seam shading, and its rings compress toward the seam. The domain's
  // seamCheck block marks it "dark", so those texels are read in the default mode; plain fabric keeps the override.
  const MAIL = [125, 132, 140], GAP = [40, 44, 50], JADE = [46, 122, 90];
  // mail on the left (sparse gap rows every 20 px, every 2 px within 8 px of the seam: the rings compress there; two
  // gap shades so neither is common enough to be a material base of its own), jade cloth on the right
  const GAP2 = [44, 48, 54];
  const mail = (x: number, y: number) => (x < SEAM ? (y % (SEAM - x <= 8 ? 2 : 20) === 0 ? (x % 2 ? GAP : GAP2) : MAIL) : JADE);
  const mailDomain = () => {
    const dir = mkdtempSync(join(tmpdir(), "seamdom-"));
    const p = join(dir, "d.domain.json");
    writeFileSync(p, JSON.stringify({ seamCheck: { ink: INK, materials: [{ name: "mail", rgb: MAIL, pattern: "dark" }, { name: "cloth", rgb: JADE, pattern: "plain" }, { name: "mail gaps", rgb: GAP, pattern: "dark" }] } }));
    return p;
  };

  it("mail compressing toward the seam: --ink everywhere counts its ring gaps as a smudge (the old one-off flag)", () => {
    const r = check(mail, ["--ink", INK.join(",")]);
    expect(r.out).toMatch(/FAIL/);
  });

  it("mail compressing toward the seam passes with the domain's per-material config (mail = dark pattern)", () => {
    const r = check(mail, ["--domain", mailDomain()]);
    expect(r.out).toMatch(/PASS/);
    expect(r.status).toBe(0);
  });

  it("with the per-material config a shade band on the mail along the seam still fails", () => {
    const r = check((x, y) => (x >= SEAM - 6 && x < SEAM && y > 30 && y < 90 ? [100, 106, 114] : mail(x, y)), ["--domain", mailDomain()]);
    expect(r.out).toMatch(/FAIL/);
    expect(r.status).toBe(1);
  });

  it("with the per-material config a smudge on the plain cloth along the seam still fails", () => {
    const r = check((x, y) => (x >= SEAM && x <= SEAM + 5 && y > 30 && y < 90 ? [26, 80, 56] : mail(x, y)), ["--domain", mailDomain()]);
    expect(r.out).toMatch(/FAIL/);
    expect(r.status).toBe(1);
  });

  it("a shade band on the steel side of a two-material seam fails", () => {
    const r = check((x, y) => (x > SEAM && x <= SEAM + 5 && y > 30 && y < 90 ? [150, 160, 170] : twoMaterial(x)));
    expect(r.out).toMatch(/FAIL/);
    expect(r.status).toBe(1);
  });
});
