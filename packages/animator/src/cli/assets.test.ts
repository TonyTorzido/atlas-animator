import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORMAT_ID } from "../core/format.js";
import { createImage, type MutableImage } from "../tools/image.js";
import { readPng, writePng } from "../tools/png.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { main } from "./animator.js";
import { atlasImport, outlineTrace } from "./assets.js";
import { applyCommands } from "../tools/commands.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "animator-assets-"));
  dirs.push(dir);
  const doc = join(dir, "mob.anim.json");
  writeFileSync(
    doc,
    JSON.stringify({ format: FORMAT_ID, name: "mob", canvas: { width: 64, height: 64, originX: 32, originY: 60 }, bones: [{ name: "root" }, { name: "arm", parent: "root", x: 10, y: -20, rotation: 90 }], ...extra })
  );
  return { dir, doc };
}

/** A canvas-size PNG with opaque blocks (each [x, y, w, h]). */
function blocks(path: string, rects: readonly [number, number, number, number][]): string {
  const image: MutableImage = createImage(64, 64);
  for (const [x0, y0, w, h] of rects) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) image.data.set([200, 100, 50, 255], (y * 64 + x) * 4);
  }
  writePng(path, image);
  return path;
}

const quiet = async (argv: string[]) => {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await main(argv);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

describe("atlas import (item 3)", () => {
  it("plans without writing; --dry-run writes nothing at all", async () => {
    const { dir, doc } = workspace();
    const png = blocks(join(dir, "body.png"), [[20, 20, 10, 10]]);
    const plan = atlasImport(doc, JSON.parse(readFileSync(doc, "utf8")), [png], new Map());
    expect(plan.files.map((f) => f.path)).toContain(join(dir, "mob.b1.atlas.json"));
    expect(existsSync(join(dir, "mob.atlas.json"))).toBe(false);
    const before = readFileSync(doc, "utf8");
    expect(await quiet(["atlas", "import", doc, png, "--dry-run"])).toBe(0);
    expect(existsSync(join(dir, "mob.atlas.json"))).toBe(false);
    expect(existsSync(join(dir, "mob.0.png"))).toBe(false);
    expect(readFileSync(doc, "utf8")).toBe(before);
  });

  it("an invalid batch writes no asset file", async () => {
    const { dir, doc } = workspace();
    const png = blocks(join(dir, "body.png"), [[20, 20, 10, 10]]);
    expect(await quiet(["atlas", "import", doc, png, "--bone", "nope"])).toBe(1);
    expect(existsSync(join(dir, "mob.atlas.json"))).toBe(false);
  });

  it("a second import keeps the regions of the first", async () => {
    const { dir, doc } = workspace();
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "body.png"), [[20, 20, 10, 10]])])).toBe(0);
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "tail.png"), [[40, 40, 6, 6]])])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "mob.atlas.json"), "utf8")) as { pages: { regions: Record<string, unknown> }[] };
    const regions = manifest.pages.flatMap((page) => Object.keys(page.regions)).sort();
    expect(regions).toEqual(["body/body", "body/tail"]);
  });

  it("rejects an atlas whose manifest is missing, and a scale change", async () => {
    const { dir, doc } = workspace({ atlas: { pages: ["mob.0.png"], scale: 1 } });
    const png = blocks(join(dir, "body.png"), [[20, 20, 10, 10]]);
    expect(() => atlasImport(doc, JSON.parse(readFileSync(doc, "utf8")), [png], new Map())).toThrow(/manifest .* is missing/);
    const fresh = workspace();
    expect(await quiet(["atlas", "import", fresh.doc, blocks(join(fresh.dir, "body.png"), [[20, 20, 10, 10]])])).toBe(0);
    expect(() => atlasImport(fresh.doc, JSON.parse(readFileSync(fresh.doc, "utf8")), [png], new Map([["scale", "0.5"]]))).toThrow(/keeps one scale/);
  });

  it("places an existing slot in its own bone's frame and rejects a conflicting --bone", () => {
    const { dir, doc } = workspace({ slots: [{ name: "hand", bone: "arm" }] });
    const raw = JSON.parse(readFileSync(doc, "utf8"));
    const png = blocks(join(dir, "hand.png"), [[30, 30, 4, 4]]);
    const plan = atlasImport(doc, raw, [png], new Map());
    const add = plan.commands.find((c) => c.op === "attachment.add") as unknown as { attachment: { x: number; y: number; rotation?: number } };
    // Part centre (32, 32) in the arm frame: the arm sits at (42, 40) on the canvas, turned 90 degrees.
    expect(add.attachment.rotation).toBeCloseTo(-90, 6);
    expect(plan.commands.some((c) => c.op === "slot.add")).toBe(false);
    expect(() => atlasImport(doc, raw, [png], new Map([["bone", "root"]]))).toThrow(/exists on bone 'arm'/);
  });
});

describe("atlas import --swaps and pivot sidecars (cut-out swap sets, 2026-10-22)", () => {
  it("imports <slot>__<attachment>.png files as a swap set on one slot", () => {
    const { dir, doc } = workspace({ slots: [{ name: "hand", bone: "arm" }] });
    const raw = JSON.parse(readFileSync(doc, "utf8"));
    const a = blocks(join(dir, "hand__fist.png"), [[30, 30, 4, 4]]);
    const b = blocks(join(dir, "hand__guard.png"), [[28, 30, 6, 4]]);
    const plan = atlasImport(doc, raw, [a, b], new Map([["swaps", true]]));
    const adds = plan.commands.filter((c) => c.op === "attachment.add") as unknown as { slot: string; name: string; attachment: { path: string } }[];
    expect(adds.map((c) => `${c.slot}/${c.name}`)).toEqual(["hand/fist", "hand/guard"]);
    expect(adds.map((c) => c.attachment.path)).toEqual(["body/hand__fist", "body/hand__guard"]);
    expect(plan.commands.some((c) => c.op === "slot.add")).toBe(false);
    expect(() => atlasImport(doc, raw, [blocks(join(dir, "plain.png"), [[1, 1, 2, 2]])], new Map([["swaps", true]]))).toThrow(/<slot>__<attachment>/);
  });

  it("a new swap slot is added once, showing its first drawing", () => {
    const { dir, doc } = workspace();
    const raw = JSON.parse(readFileSync(doc, "utf8"));
    const a = blocks(join(dir, "hand__fist.png"), [[30, 30, 4, 4]]);
    const b = blocks(join(dir, "hand__guard.png"), [[28, 30, 6, 4]]);
    const plan = atlasImport(doc, raw, [a, b], new Map<string, string | true>([["swaps", true], ["bone", "arm"]]));
    const slots = plan.commands.filter((c) => c.op === "slot.add") as unknown as { name: string; attachment: string }[];
    expect(slots).toEqual([expect.objectContaining({ name: "hand", attachment: "fist" })]);
  });

  it("a .pivot.json sidecar puts the pivot pixel on the bone start and the drawn direction along the bone", () => {
    const { dir, doc } = workspace({ slots: [{ name: "hand", bone: "arm" }] });
    const raw = JSON.parse(readFileSync(doc, "utf8"));
    // a 20x10 piece drawn pointing screen-right, its pivot at the middle of its left edge
    const image: MutableImage = createImage(20, 10);
    for (let i = 0; i < 200; i++) image.data.set([200, 100, 50, 255], i * 4);
    const png = join(dir, "hand__guard.png");
    writePng(png, image);
    writeFileSync(join(dir, "hand__guard.pivot.json"), JSON.stringify({ pivot: [0, 5], angle: 0 }));
    const plan = atlasImport(doc, raw, [png], new Map([["swaps", true]]));
    const add = plan.commands.find((c) => c.op === "attachment.add") as unknown as { attachment: { x: number; y: number; rotation?: number } };
    // the arm bone points straight down (90 deg): the piece turns to point down, its centre 10 px along the bone
    expect(add.attachment.x).toBeCloseTo(10, 6);
    expect(add.attachment.y).toBeCloseTo(0, 6);
    expect(add.attachment.rotation ?? 0).toBeCloseTo(0, 6);
    writeFileSync(join(dir, "hand__guard.pivot.json"), JSON.stringify({ pivot: [0] }));
    expect(() => atlasImport(doc, raw, [png], new Map([["swaps", true]]))).toThrow(/needs \{"pivot"/);
  });
});

describe("atlas import transaction", () => {
  const listing = (dir: string) => readdirSync(dir).sort();
  const regionWidth = (dir: string) => {
    const manifest = JSON.parse(readFileSync(join(dir, "mob.atlas.json"), "utf8")) as { pages: { file: string; regions: Record<string, { w?: number; width?: number }> }[] };
    const page = manifest.pages.find((pg) => pg.regions["body/body"]);
    const region = page?.regions["body/body"] as { w?: number; width?: number };
    expect(existsSync(join(dir, page?.file as string))).toBe(true);
    return region.w ?? region.width;
  };

  it("an invalid --limits is rejected before any file is written", async () => {
    const { dir, doc } = workspace();
    const png = blocks(join(dir, "body.png"), [[20, 20, 10, 10]]);
    const before = listing(dir);
    const text = readFileSync(doc, "utf8");
    expect(await quiet(["atlas", "import", doc, png, "--limits", "bogus"])).toBe(2);
    expect(listing(dir)).toEqual(before);
    expect(readFileSync(doc, "utf8")).toBe(text);
  });

  it("--dry-run neither repairs the document nor appends to its log", async () => {
    const { dir, doc } = workspace();
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "body.png"), [[20, 20, 10, 10]])])).toBe(0);
    // An edit outside the bus: a normal open would append an `external` entry.
    writeFileSync(doc, JSON.stringify(JSON.parse(readFileSync(doc, "utf8")), null, 3));
    const log = readFileSync(join(dir, "mob.anim.log.ndjson"), "utf8");
    const text = readFileSync(doc, "utf8");
    const before = listing(dir);
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "tail.png"), [[40, 40, 6, 6]]), "--dry-run"])).toBe(0);
    expect(readFileSync(join(dir, "mob.anim.log.ndjson"), "utf8")).toBe(log);
    expect(readFileSync(doc, "utf8")).toBe(text);
    expect(listing(dir)).toEqual([...before, "tail.png"].sort());
  });

  it("a replacement import is a new bundle; undo restores the previous assets and redo the new ones", async () => {
    const { dir, doc } = workspace();
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "body.png"), [[20, 20, 10, 10]])])).toBe(0);
    expect(regionWidth(dir)).toBe(10);
    expect(await quiet(["atlas", "import", doc, blocks(join(dir, "body.png"), [[5, 5, 24, 24]])])).toBe(0);
    expect(regionWidth(dir)).toBe(24);
    expect(listing(dir).filter((f) => /^mob\.b\d+\.atlas\.json$/.test(f))).toEqual(["mob.b1.atlas.json", "mob.b2.atlas.json"]);
    expect(await quiet(["undo", doc])).toBe(0);
    expect(regionWidth(dir)).toBe(10);
    expect(await quiet(["redo", doc])).toBe(0);
    expect(regionWidth(dir)).toBe(24);
  });
});

describe("outline trace components (item 4)", () => {
  it("traces every disconnected component by default, each its own hull, and lists them", () => {
    const { dir, doc } = workspace();
    const png = blocks(join(dir, "pair.png"), [
      [8, 8, 14, 14],
      [40, 36, 10, 10]
    ]);
    expect(atlasImport(doc, JSON.parse(readFileSync(doc, "utf8")), [png], new Map()).commands.length).toBeGreaterThan(0);
    return quiet(["atlas", "import", doc, png]).then((code) => {
      expect(code).toBe(0);
      const raw = JSON.parse(readFileSync(doc, "utf8"));
      const all = outlineTrace(raw, png, new Map([["slot", "pair"]]));
      const generated = all.commands.filter((c) => c.op === "mesh.generate");
      expect(generated).toHaveLength(2);
      // The padded outline never leaves the imported region (UVs clamp there: no edge stretch).
      const region = raw.skins.body.attachments.pair.pair as { width: number; height: number };
      for (const c of generated) for (const [x, y] of (c as unknown as { outline: { outer: [number, number][] } }).outline.outer) {
        expect(x >= 0 && y >= 0 && x <= region.width && y <= region.height).toBe(true);
      }
      const applied = applyCommands(raw, all.commands) as unknown as { doc: { slots: { name: string; bone: string }[] } };
      expect(applied.doc.slots.map((s) => s.name)).toContain("pair_part2");
      expect(all.notes.join("\n")).toMatch(/2 components/);
      const largest = outlineTrace(raw, png, new Map([["slot", "pair"], ["components", "largest"]]));
      expect(largest.commands.filter((c) => c.op === "mesh.generate")).toHaveLength(1);
      expect(largest.notes.join("\n")).toMatch(/dropped/);
    });
  });
});

describe("CLI gaps from the second rig acceptance (nest mouse)", () => {
  it("atlas trim crops to the opaque bounds plus the pad", async () => {
    const { dir } = workspace();
    const png = blocks(join(dir, "src.png"), [[20, 10, 6, 30]]);
    const out = join(dir, "trim.png");
    expect(await quiet(["atlas", "trim", png, out, "--pad", "3"])).toBe(0);
    const trimmed = readPng(out);
    expect([trimmed.width, trimmed.height]).toEqual([12, 36]);
    expect(trimmed.data[(3 * 12 + 3) * 4 + 3]).toBe(255);
    expect(trimmed.data[(2 * 12 + 3) * 4 + 3]).toBe(0);
  });

  it("bone add --world/--tip places a bone at canvas points under a rotated parent", async () => {
    const { doc } = workspace();
    expect(await quiet(["bone", "add", doc, "hand", "--parent", "arm", "--world", "40,30", "--tip", "52,21"])).toBe(0);
    const loaded = loadAnimDocument(JSON.parse(readFileSync(doc, "utf8")));
    const skeleton = new Skeleton(loaded);
    skeleton.x = loaded.canvas.originX;
    skeleton.y = loaded.canvas.originY;
    skeleton.updateWorldTransform("none");
    const hand = skeleton.getBone("hand");
    const start = hand.localToWorld(0, 0, { x: 0, y: 0 });
    const end = hand.localToWorld(hand.data.length, 0, { x: 0, y: 0 });
    expect(start.x).toBeCloseTo(40, 3);
    expect(start.y).toBeCloseTo(30, 3);
    expect(end.x).toBeCloseTo(52, 3);
    expect(end.y).toBeCloseTo(21, 3);
    expect(await quiet(["apply", doc, JSON.stringify({ op: "bone.add", name: "bad", world: [1, 2], x: 3 })])).toBe(1);
  });

  it("info shows roles (explicit and inferred), budgets and chains", async () => {
    const { doc } = workspace({ budgets: { bodyVertices: 100 } });
    expect(await quiet(["apply", doc, JSON.stringify({ op: "bone.set", name: "arm", role: "limb" })])).toBe(0);
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      expect(await main(["info", doc])).toBe(0);
    } finally {
      process.stdout.write = out;
    }
    const text = lines.join("");
    expect(text).toMatch(/roles \(\* = inferred; set with bone\.set role\): root \w+\*, arm limb\b/);
    expect(text).toContain('budgets: {"bodyVertices":100');
    expect(text).toContain("chains: none declared");
  });

  it("atlas split cuts a part off along a line (original pixels, overlap band of its own texels) and weights.seam binds both sides", async () => {
    const { dir, doc } = workspace();
    // A body block and a tail block joined by a bridge at x 30..34.
    const png = blocks(join(dir, "mob.png"), [[10, 20, 20, 20], [30, 26, 4, 8], [34, 20, 16, 20]]);
    const rest = join(dir, "body.png");
    const part = join(dir, "tail.png");
    expect(await quiet(["atlas", "split", png, "--line", "32,15,32,45", "--seed", "45,30", "--out", rest, "--part", part, "--overlap", "4"])).toBe(0);
    const r = readPng(rest);
    const t = readPng(part);
    const a = (img: MutableImage, x: number, y: number) => img.data[(y * 64 + x) * 4 + 3];
    expect([a(r, 15, 30), a(r, 45, 30), a(r, 33, 30)]).toEqual([255, 0, 0]);
    expect([a(t, 15, 30), a(t, 45, 30), a(t, 33, 30)]).toEqual([0, 255, 255]);
    // The overlap band: tail texels extruded just across the cut, under the body.
    expect(a(t, 29, 30)).toBe(255);
    expect(a(t, 20, 30)).toBe(0);
    // weights.seam: vertices along the cut go to the named bone.
    expect(await quiet(["atlas", "import", doc, rest])).toBe(0);
    expect(await quiet(["outline", "trace", doc, rest, "--slot", "body", "--spacing", "4"])).toBe(0);
    expect(await quiet(["apply", doc, JSON.stringify({ op: "weights.bind", skin: "body", slot: "body", name: "body", bone: "root" })])).toBe(0);
    expect(await quiet(["apply", doc, JSON.stringify({ op: "weights.seam", skin: "body", slot: "body", name: "body", bone: "arm", line: [[32, 15], [32, 45]], hard: 3, soft: 6 })])).toBe(0);
    const mesh = JSON.parse(readFileSync(doc, "utf8")).skins.body.attachments.body.body as { bones: string[]; vertices: number[] };
    expect(mesh.bones).toContain("arm");
  });
});
