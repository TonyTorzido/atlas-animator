/*
 * Atlas Animator: original implementation.
 *
 * `animator layers...`: the preservation-first layered-parts pipeline.
 *
 *   layers plan <source.png> --rig <rig.anim.json> --parts <parts.json> --out <dir>
 *   layers extract <dir>
 *   layers validate <manifest.json>
 *   layers enforce <manifest.json> <part> <generated.png> [--out <png>] [--prompt-file <txt>] [--tool T] [--model M]
 *   layers check <manifest.json> [--out <dir>] [--ink 90]
 *   layers sheet <manifest.json> [--out <dir>] [--scale 3]
 *   layers pack <manifest.json> [--out <dir>] [--subject creature]
 *   layers build <manifest.json> --out <dir>/<name>.anim.json [--scale 1]
 *
 * `build` makes a fresh rig document from the manifest: the rig's skeleton and constraints, then
 * per part (draw order) `atlas import` of the stored full-canvas PNG (unit scale, slot on the
 * part's bone), `outline trace`, the part's weight domain (allowed bones), the weight tree as
 * authoring chains with sibling branches kept apart (overlap connections), the manifest joints as
 * authoring joints, weights, and the draw order. It only reads accepted PNGs (hash-checked against
 * the manifest): rebuilding never regenerates art.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readPng } from "../tools/png.js";
import { applyToFile, createDocumentFile, readDocument } from "../tools/documentStore.js";
import type { Command } from "../tools/commands.js";
import { sha256File } from "../tools/layers/core.js";
import { checkManifestFile, writeReviewSheets } from "../tools/layers/check.js";
import { enforceFile, extractFolder, readJson, writeJson, writePlanFolder } from "../tools/layers/files.js";
import { resolveRef, validateManifest, type LayerManifest } from "../tools/layers/manifest.js";
import { writeCompletionPacks } from "../tools/layers/pack.js";
import { partsSpecSchema, planLayers } from "../tools/layers/plan.js";
import { chainsFor, rigView } from "../tools/layers/rig.js";

type Flags = ReadonlyMap<string, string | true>;
const text = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const USAGE = [
  "usage: animator layers plan <source.png> --rig <rig.anim.json> --parts <parts.json> --out <dir>",
  "       animator layers extract <dir>",
  "       animator layers validate <manifest.json>",
  "       animator layers enforce <manifest.json> <part> <generated.png> [--out <png>] [--prompt-file <txt>] [--tool T] [--model M] [--register]",
  "       animator layers check <manifest.json> [--out <dir>] [--ink 90]",
  "       animator layers sheet <manifest.json> [--out <dir>] [--scale 3]",
  "       animator layers pack <manifest.json> [--out <dir>] [--subject creature]",
  "       animator layers build <manifest.json> --out <dir>/<name>.anim.json [--scale 1]"
].join("\n");

const print = (line: string) => process.stdout.write(`${line}\n`);

export async function layersCommand(positional: string[], flags: Flags): Promise<number> {
  const [verb, ...rest] = positional;
  switch (verb) {
    case "plan": {
      const source = rest[0];
      const rig = text(flags, "rig");
      const parts = text(flags, "parts");
      const out = text(flags, "out");
      if (!source || !rig || !parts || !out) throw new Error(USAGE);
      const spec = partsSpecSchema.parse(readJson(parts));
      const plan = planLayers(readPng(source), readJson(rig), spec);
      const file = writePlanFolder(resolve(out), plan, { source, rig, partsSpec: parts, skin: spec.skin });
      for (const p of file.parts) print(`${p.id}: visible ${p.area.visible} px, completion ${p.area.completion} px, uncertain ${p.area.uncertain} px, ${p.seeds} seed px${p.outline ? `, outline ${p.outline.widthPx} px ${p.outline.color}` : ""}`);
      for (const j of file.joints) print(`joint ${j.parent} -> ${j.child} (${j.pivotBone}): radius ${j.radius}, margin ${j.margin}, ${j.back} behind ${j.front}, exposed ${j.exposedArea} px, unfillable ${j.unfillable} px, cracks ${j.probes.map((p) => p.cracks).join("/")}`);
      for (const note of file.notes) print(`note: ${note}`);
      print(`wrote ${join(resolve(out), "plan.json")}, overlay.png, occlusion.json, masks/`);
      return 0;
    }
    case "extract": {
      const dir = rest[0];
      if (!dir) throw new Error(USAGE);
      const { written } = extractFolder(resolve(dir));
      print(`wrote ${written.length} file(s); manifest ${join(resolve(dir), "manifest.json")}`);
      return 0;
    }
    case "validate": {
      const path = rest[0];
      if (!path) throw new Error(USAGE);
      const dir = dirname(resolve(path));
      const raw = readJson(path) as { rig?: { path?: string } };
      let bones: Set<string> | undefined;
      try {
        const rig = readJson(resolveRef(dir, { path: String(raw.rig?.path) })) as { bones?: { name: string }[] };
        bones = new Set((rig.bones ?? []).map((b) => b.name));
      } catch {
        bones = undefined;
      }
      const { issues } = validateManifest(raw, { baseDir: dir, ...(bones ? { bones } : {}) });
      for (const issue of issues) print(`${issue.severity}: ${issue.message}`);
      const errors = issues.filter((i) => i.severity === "error").length;
      print(errors === 0 ? "manifest ok" : `${errors} error(s)`);
      return errors === 0 ? 0 : 1;
    }
    case "enforce": {
      const [manifest, part, generated] = rest;
      if (!manifest || !part || !generated) throw new Error(USAGE);
      const promptFile = text(flags, "prompt-file");
      const { stats, output, registration } = enforceFile(manifest, part, generated, {
        ...(flags.has("register") ? { register: true } : {}),
        ...(text(flags, "out") ? { out: text(flags, "out") as string } : {}),
        record: { prompt: promptFile ? readFileSync(promptFile, "utf8") : null, tool: text(flags, "tool") ?? null, model: text(flags, "model") ?? null }
      });
      if (registration) print(`registered: scale ${registration.scale}, offset (${registration.dx}, ${registration.dy}), trusted-pixel error ${registration.error}/255`);
      print(`wrote ${output}: kept ${stats.kept} generated px, restored ${stats.restored} trusted px (${stats.driftedTrusted} had drifted), dropped ${stats.droppedOutside} px outside the allowed areas`);
      return 0;
    }
    case "check": {
      const manifest = rest[0];
      if (!manifest) throw new Error(USAGE);
      const ink = text(flags, "ink");
      const { report, reportPath, sheetPath } = checkManifestFile(manifest, { ...(text(flags, "out") ? { out: text(flags, "out") as string } : {}), ...(ink ? { inkThreshold: Number(ink) } : {}) });
      print(`rest: ${report.rest.pass ? "PASS" : "FAIL"} (protected ${report.rest.protected.pixels} px, ${report.rest.protected.over1} over 1, max ${report.rest.protected.maxDiff}; band ${report.rest.band.pixels} px, ${(report.rest.band.fraction * 100).toFixed(2)}% within 3)`);
      for (const j of report.joints) {
        const cracks = j.probes.reduce((s, p) => s + p.cracks, 0);
        const caps = j.probes.reduce((s, p) => s + p.exposedCaps, 0);
        print(`joint ${j.parent} -> ${j.child}: coverage ${j.coverage ? "PASS" : "FAIL"} (${cracks} crack px, ${caps} exposed cap px over ${j.probes.length} probes), outline ${j.outline ? "PASS" : "FAIL"}`);
      }
      print(`fringe: ${report.fringe.pass ? "PASS" : "FAIL"} (${report.fringe.pixels} px)`);
      print(`gates: ${Object.entries(report.gates).map(([k, v]) => `${k} ${v ? "pass" : "FAIL"}`).join(", ")}`);
      print(`wrote ${reportPath} and ${sheetPath}`);
      return report.pass ? 0 : 1;
    }
    case "sheet": {
      const manifest = rest[0];
      if (!manifest) throw new Error(USAGE);
      const sheets = writeReviewSheets(manifest, { ...(text(flags, "out") ? { out: text(flags, "out") as string } : {}), scale: Number(text(flags, "scale") ?? 3) });
      print(`wrote ${sheets.rest} and ${sheets.probes}`);
      return 0;
    }
    case "pack": {
      const manifest = rest[0];
      if (!manifest) throw new Error(USAGE);
      const packs = writeCompletionPacks(manifest, { ...(text(flags, "out") ? { out: text(flags, "out") as string } : {}), ...(text(flags, "subject") ? { subject: text(flags, "subject") as string } : {}) });
      for (const p of packs) print(`${p.part}: ${p.completionPx} px to complete -> ${p.folder}`);
      if (packs.length === 0) print("no part has a completion area");
      return 0;
    }
    case "build": {
      const manifest = rest[0];
      const out = text(flags, "out");
      if (!manifest || !out) throw new Error(USAGE);
      const result = await buildFromManifest(manifest, out, { scale: Number(text(flags, "scale") ?? 1) });
      print(`built ${result.doc}: ${result.slots.length} slot(s) ${result.slots.join(", ")}`);
      return 0;
    }
    default:
      throw new Error(USAGE);
  }
}

const BONE_FIELDS = ["length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit", "role", "skin", "limits"] as const;
const CONSTRAINT_KEYS = ["ik", "transform", "physics"] as const;
const MARKER = "layers-build.json";

/** `layers build`: see the file comment. Returns the document path and its slots in draw order. */
export async function buildFromManifest(manifestPath: string, outDoc: string, options: { scale?: number } = {}): Promise<{ doc: string; slots: string[] }> {
  const dir = dirname(resolve(manifestPath));
  const raw = readJson(manifestPath);
  const { manifest, issues } = validateManifest(raw, { baseDir: dir });
  const errors = issues.filter((i) => i.severity === "error");
  if (!manifest || errors.length > 0) throw new Error(`the manifest does not validate (no art is regenerated; fix the inputs): ${errors.map((e) => e.message).join("; ")}`);
  const m: LayerManifest = manifest;
  const docPath = resolve(outDoc);
  if (!docPath.endsWith(".anim.json")) throw new Error("--out must name a <name>.anim.json document");
  const outDir = dirname(docPath);
  // A rebuild replaces only what the previous build wrote (listed in its marker).
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    const marker = join(outDir, MARKER);
    if (!existsSync(marker)) throw new Error(`${outDir} is not empty and holds no ${MARKER}: build into a fresh folder`);
    const previous = readJson(marker) as { files: string[] };
    for (const file of previous.files) {
      const path = resolve(outDir, file);
      if (dirname(path).startsWith(outDir)) rmSync(path, { recursive: true, force: true });
    }
    rmSync(marker, { force: true });
  }
  mkdirSync(join(outDir, "parts"), { recursive: true });
  const rigRaw = readJson(resolveRef(dir, m.rig)) as Record<string, unknown>;
  const source = readPng(resolveRef(dir, m.source));
  const view = rigView(rigRaw, source);
  const name = basename(docPath).replace(/\.anim\.json$/, "").replace(/[^A-Za-z0-9_-]/g, "_");
  const skins = [...new Set(m.parts.map((p) => p.skin))];
  const create: Command[] = [{ op: "doc.new", name, width: source.width, height: source.height, originX: view.doc.canvas.originX - view.offset.x, originY: view.doc.canvas.originY - view.offset.y, skin: skins[0] ?? "body" }];
  for (const bone of (rigRaw["bones"] as Record<string, unknown>[]) ?? []) {
    if (bone["parent"] === undefined) continue;
    const add: Record<string, unknown> = { op: "bone.add", name: bone["name"], parent: bone["parent"] };
    for (const key of BONE_FIELDS) if (bone[key] !== undefined) add[key] = bone[key];
    create.push(add as Command);
  }
  for (const kind of CONSTRAINT_KEYS) for (const constraint of (rigRaw[kind] as unknown[] | undefined) ?? []) create.push({ op: "constraint.add", kind, constraint } as Command);
  createDocumentFile(docPath, create, "layers build");
  if (skins.length > 1) applyToFile(docPath, skins.slice(1).map((s) => ({ op: "skin.add", name: s }) as Command), { source: "layers build" });

  const { main } = await import("./animator.js");
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  const run = async (argv: string[]) => {
    const code = await main(argv);
    if (code !== 0) throw new Error(`animator ${argv.join(" ")} exited with ${code}`);
  };
  for (const id of m.drawOrder) {
    const part = byId.get(id) as LayerManifest["parts"][number];
    const staged = join(outDir, "parts", `${part.slot}.png`);
    copyFileSync(resolveRef(dir, part.image), staged);
    await run(["atlas", "import", docPath, staged, "--bone", part.bone, "--skin", part.skin, "--scale", String(options.scale ?? 1)]);
    await run(["outline", "trace", docPath, staged, "--slot", part.slot, "--skin", part.skin, "--name", part.attachment]);
  }
  // Every traced component slot (<slot>, <slot>_partN) gets the part's domain, weights and place.
  const doc = readDocument(docPath).doc as { slots: { name: string; attachment?: string }[] };
  const slotsOf = (slot: string) => doc.slots.filter((s) => s.name === slot || new RegExp(`^${slot}_part\\d+$`).test(s.name)).map((s) => s.name);
  const domains: Record<string, unknown>[] = [];
  const weights: Command[] = [];
  const drawOrder: string[] = [];
  const parents = new Map([...view.bones.values()].map((b) => [b.name, b.parent]));
  for (const id of m.drawOrder) {
    const part = byId.get(id) as LayerManifest["parts"][number];
    for (const slot of slotsOf(part.slot)) {
      const attachment = slot === part.slot ? part.attachment : slot;
      domains.push({ id: slot === part.slot ? part.domainId : `${part.domainId}_${slot.slice(part.slot.length + 1)}`, skin: part.skin, slot, attachment, bones: part.allowedBones });
      weights.push(
        part.allowedBones.length === 1
          ? ({ op: "weights.bind", skin: part.skin, slot, name: attachment, bone: part.allowedBones[0] } as Command)
          : ({ op: "weights.auto", skin: part.skin, slot, name: attachment, chains: chainsFor(parents, part.allowedBones) } as Command)
      );
      // A few smoothing passes: abrupt weight steps along a hull edge fold the outline in motion.
      if (part.allowedBones.length > 1) weights.push({ op: "weights.smooth", skin: part.skin, slot, name: attachment, iterations: 3 } as Command);
      drawOrder.push(slot);
    }
  }
  const joints = m.joints.map((j) => ({ parent: (byId.get(j.parentPart) as LayerManifest["parts"][number]).slot, child: (byId.get(j.childPart) as LayerManifest["parts"][number]).slot, pivotBone: j.pivotBone }));
  // Authoring chains per multi-bone domain (the weight tree), and sibling branches (chains hanging
  // from the same bone: a tail and a hind leg off the pelvis, two ears off the head) as overlap
  // connections, so no influence crosses between two appendages.
  const chains: Record<string, unknown>[] = [];
  const connections: Record<string, unknown>[] = [];
  const seenDomains = new Set<string>();
  for (const id of m.drawOrder) {
    const part = byId.get(id) as LayerManifest["parts"][number];
    if (part.allowedBones.length < 2 || seenDomains.has(part.domainId)) continue;
    seenDomains.add(part.domainId);
    const tree = chainsFor(parents, part.allowedBones);
    const chainId = (k: number) => `${part.domainId}_chain${k}`;
    const ownerOf = (bone: string) => tree.findIndex((c) => c.bones.includes(bone));
    tree.forEach((c, k) => chains.push({ id: chainId(k), bones: c.bones, ...(c.parent ? { parent: chainId(ownerOf(c.parent)) } : {}) }));
    for (let a = 0; a < tree.length; a++) {
      for (let b = a + 1; b < tree.length; b++) {
        const pa = (tree[a] as { parent?: string }).parent;
        if (pa && pa === (tree[b] as { parent?: string }).parent) connections.push({ between: [chainId(a), chainId(b)], kind: "overlap" });
      }
    }
  }
  applyToFile(docPath, [{ op: "patch", patch: [{ op: "add", path: "/authoring", value: { ...(chains.length > 0 ? { chains } : {}), ...(connections.length > 0 ? { connections } : {}), domains, joints } }] } as Command], { source: "layers build" });
  applyToFile(docPath, weights, { source: "layers build" });
  applyToFile(docPath, [{ op: "patch", patch: [{ op: "add", path: "/drawOrder", value: drawOrder }] } as Command], { source: "layers build" });
  // The folder was empty (or cleared above): everything in it now is this build's.
  writeJson(join(outDir, MARKER), { manifest: { path: resolve(manifestPath), sha256: sha256File(manifestPath) }, doc: basename(docPath), files: readdirSync(outDir) });
  return { doc: docPath, slots: drawOrder };
}
