/*
 * Atlas Animator: original implementation.
 *
 * The `animator` command line (plan 4.3, Phase 5). Every edit is a command from the command bus
 * (src/tools/commands.ts) and goes through the document's log (src/tools/documentStore.ts);
 * nothing writes a document any other way. Reference: packages/animator/README.md.
 *
 *   animator ops [filter] [--json]                      the command vocabulary
 *   animator new <doc> --name <n> --size WxH [--origin X,Y]
 *   animator info <doc> [--json]                        bones, slots, skins, constraints, clips
 *   animator apply <doc> '<command json>'... [--dry-run] [--check command|end] [--limits warn|reject|off]
 *   animator apply-script <doc> <script.jsonl|.json> [--dry-run] [--check ...] [--limits ...]
 *   animator undo|redo <doc> [--steps N]
 *   animator log <doc> [--last N] [--json]
 *   animator watch <doc>                                prints log entries as they land
 *   animator validate --contract <rig.anim.json> [--contract-file CONTRACT.json] [--json]   checks a rig against the swag contract (src/cli/validateContract.ts)
 *   animator validate <doc> [--atlas <rig.atlas.json>] [--outfits tunic+cape,...] [--preset humanoid] [--body-vertices N] [--poses]
 *   animator weights overview <doc> [<doc>...] --out <png> [--skins body,...] [--ambiguous]   weight colours, docs side by side (--ambiguous marks weights.auto ambiguous vertices)
 *   animator diff <a> [<b>] [--git <rev>] [--json]
 *   animator render <doc> [--clip C] [--mp4 F] [--gif F] [--sheet F] [--png-dir D] ...
 *   animator atlas import <doc> <png...> [--skin body] [--bone root] [--scale 1]   pack PNGs, add slots + regions
 *   animator atlas split <in.png> --line X1,Y1,X2,Y2 --seed X,Y --out <rest.png> --part <part.png> [--overlap 14]   cut an appendage off (original pixels only)
 *   animator atlas trim <in.png> <out.png> [--pad 16]   crop a source PNG to its opaque bounds + pad (prints the --size/--origin to use)
 *   animator bone add <doc> <name> [--parent P] --world X,Y [--tip X,Y] [--limits MIN,MAX]   bone.add from canvas points
 *   animator rest-fidelity <doc> <source.png> [--out <prefix>] [--controls]   setup pose vs the source art (exit 1 on fail)
 *   animator layers plan|extract|validate|enforce|check|pack|build ...           layered parts (src/cli/layers.ts)
 *   animator outline trace <doc> <png> --slot S [--target N | --spacing P] [--tolerance 2.5] [--components all|largest]   region -> mesh from the PNG hull
 *   animator export-spine <doc> <outDir> [--name N] [--clips a,b] [--clips-from other.anim.json] [--no-atlas]   Spine 4.2 JSON + images + .atlas (src/cli/exportSpine.ts)
 *   animator validate-publish --rig <rig dir> [--repo <root>] [--require-clips] [--json]   checks a published rig + atlas + mapped clips (src/cli/validatePublish.ts)
 *   animator import-spine <spine.json> --merge <rigdir|rig.anim.json> [--clips a,b] [--dry-run]   meshes, weights, linked meshes and deform back into the rig (src/cli/importSpineMeshes.ts)
 *   animator import-spine-clips <spine.json> --rig <rigdir> [--clips a,b] [--loop a,b] [--trim] [--dry-run]   Spine clips back into the rig document (src/cli/importSpine.ts)
 *   animator rig --canonical <preset.json> --out <dir> [--review <dir>] [--preset humanoid]   build the canonical body + gates
 *
 * Exit codes: 0 ok, 1 failed (invalid document, rejected command, render error), 2 usage.
 * Run with `pnpm --filter @atlas-animator/core animator <command> ...` (or tsx src/cli/animator.ts).
 */
import { garmentImportCommand } from "./garmentImport.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
import { parseAnimDocument, formatIssue } from "../core/formatLoader.js";
import { applyCommands, CommandError, describeCommands, parseScript, type Command, type CommandNote } from "../tools/commands.js";
import { diffDocuments, formatDiff } from "../tools/diff.js";
import type { JsonObject } from "../tools/jsonPatch.js";
import { applyToFile, createDocumentFile, historyOf, openDocument, readDocument, readLog, stepHistory, type LogEntry } from "../tools/documentStore.js";
import { HUMANOID_BODY } from "../tools/humanoid.js";
import type { BodyPreset } from "../tools/bodyPreset.js";
import type { RgbaImage } from "../tools/image.js";
import { readPng, writePng } from "../tools/png.js";
import { inferRoles } from "../tools/rigPoses.js";
import { grid, jointContactSheet, weightHeatSheet, weightOverview } from "../tools/review.js";
import { formatValidationIssue, texturesFromAtlas, validateRig, type ValidationReport } from "../tools/validate.js";
import type { ValidationCompanion } from "../tools/validateGeometry.js";

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["controls", "sparse", "json", "dry-run", "help", "apply", "distal", "poses", "canonical", "ambiguous", "register", "swaps", "no-atlas"]);

class UsageError extends Error {}

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positional, flags };
}

const flag = (args: Args, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const has = (args: Args, name: string) => args.flags.has(name);

function numberFlag(args: Args, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got '${value}')`);
  return n;
}

function pairFlag(args: Args, name: string, separator: RegExp): [number, number] | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parts = value.split(separator).map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) throw new UsageError(`--${name} must look like ${separator.source === "x" ? "WxH" : "X,Y"} (got '${value}')`);
  return parts as [number, number];
}

function requireDocument(args: Args, usage: string): string {
  const path = args.positional[0];
  if (!path) throw new UsageError(`usage: ${usage}`);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  return path;
}

const print = (text: string) => process.stdout.write(`${text}\n`);

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

function checkMode(args: Args): "command" | "end" {
  const check = flag(args, "check") ?? "command";
  if (check !== "command" && check !== "end") throw new UsageError("--check must be 'command' or 'end'");
  return check;
}

/** Live pose limits for key commands: warn by default on the CLI. */
function limitsMode(args: Args): "off" | "warn" | "reject" {
  const mode = flag(args, "limits") ?? "warn";
  if (mode !== "off" && mode !== "warn" && mode !== "reject") throw new UsageError("--limits must be 'warn', 'reject' or 'off'");
  return mode;
}

function describeEntry(entry: LogEntry): string {
  const what = entry.kind === "apply" || entry.kind === "create" ? `${entry.commands?.length ?? 0} command(s)` : entry.target !== undefined ? `entry ${entry.target}` : "";
  return `#${entry.seq} ${entry.kind} ${what} by ${entry.source} at ${entry.time}: ${entry.patch.length} patch op(s), ${entry.before || "(new)"} -> ${entry.after}`;
}

async function runCommands(args: Args, path: string, commands: Command[]): Promise<number> {
  const check = checkMode(args);
  const mode = limitsMode(args);
  // --check end validates the whole clip once at the end; under reject a failure there keeps the
  // batch (written and logged, nothing reverted) and exits 1, so the script can be fixed forward.
  const limits = check === "end" && mode === "reject" ? "warn" : mode;
  const reportNotes = (notes: readonly CommandNote[] | undefined) => {
    for (const note of notes ?? []) process.stderr.write(`${note.level === "warning" ? "warning" : "note"} [${note.message.match(/^command \d+ \(([^)]+)\)/)?.[1] ?? "command"}] ${note.message}
`);
  };
  const reportLimits = (warnings: readonly string[] | undefined, written: boolean): number => {
    for (const line of warnings ?? []) process.stderr.write(`warning [limits] ${line}
`);
    if (!warnings?.length || mode !== "reject") return 0;
    process.stderr.write(`rejected: the batch leaves the pose limits at the end (--check end)${written ? "; the batch is written and logged (undo it, or fix it with more commands)" : ""}
`);
    return 1;
  };
  if (has(args, "dry-run")) {
    // Plan: a genuinely read-only reader (no crash repair, no external-edit log entry).
    const result = applyCommands(readDocument(path).doc, commands, { check, limits });
    print(JSON.stringify({ patch: result.patch, inverse: result.inverse }, null, has(args, "json") ? 0 : 1));
    print(`dry run: ${commands.length} command(s) valid, ${result.patch.length} patch op(s); nothing written`);
    reportNotes(result.notes);
    return reportLimits(result.limitWarnings, false);
  }
  const result = applyToFile(path, commands, { check, limits, source: "cli" });
  if (result.repaired === "recovered") print("note: re-applied the last logged batch (the previous write was interrupted)");
  if (result.repaired === "external") print("note: the file was changed outside the command log; recorded as an external edit (undo stops there)");
  if (has(args, "json")) print(JSON.stringify(result.entry));
  else print(describeEntry(result.entry));
  reportNotes(result.notes);
  return reportLimits(result.limitWarnings, true);
}

async function apply(args: Args): Promise<number> {
  const path = requireDocument(args, "animator apply <doc> '<command json>'...");
  const texts = args.positional.slice(1);
  if (texts.length === 0) throw new UsageError("give at least one command as JSON, e.g. '{\"op\":\"bone.set\",\"name\":\"chest\",\"rotation\":5}'");
  const commands = texts.flatMap((text) => {
    try {
      const value: unknown = JSON.parse(text);
      return (Array.isArray(value) ? value : [value]) as Command[];
    } catch {
      throw new UsageError(`not valid JSON: ${text}`);
    }
  });
  return runCommands(args, path, commands);
}

async function applyScript(args: Args): Promise<number> {
  const path = requireDocument(args, "animator apply-script <doc> <script.jsonl>");
  const script = args.positional[1];
  if (!script) throw new UsageError("usage: animator apply-script <doc> <script.jsonl|script.json>");
  return runCommands(args, path, parseScript(readFileSync(script, "utf8")));
}

async function history(direction: "undo" | "redo", args: Args): Promise<number> {
  const path = requireDocument(args, `animator ${direction} <doc> [--steps N]`);
  const steps = numberFlag(args, "steps") ?? 1;
  const results = stepHistory(path, direction, steps);
  for (const result of results) print(describeEntry(result.entry));
  if (results.length === 0) print(`nothing to ${direction}`);
  // Plan: the atlas pointer follows the document back to its previous asset bundle.
  if (results.length > 0) {
    const synced = (await import("./assets.js")).syncAtlasPointer(path);
    if (synced) print(`atlas: ${synced}`);
  }
  return 0;
}

function newDocument(args: Args): number {
  const path = args.positional[0];
  const name = flag(args, "name");
  const size = pairFlag(args, "size", /x/);
  if (!path || !name || !size) throw new UsageError("usage: animator new <doc.anim.json> --name <name> --size WxH [--origin X,Y]");
  const origin = pairFlag(args, "origin", /,/);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const command: Command = { op: "doc.new", name, width: size[0], height: size[1], ...(origin ? { originX: origin[0], originY: origin[1] } : {}) };
  const result = createDocumentFile(path, [command]);
  print(describeEntry(result.entry));
  return 0;
}

function log(args: Args): number {
  const path = requireDocument(args, "animator log <doc> [--last N]");
  const entries = readLog(path).slice(-(numberFlag(args, "last") ?? 20));
  if (has(args, "json")) for (const entry of entries) print(JSON.stringify(entry));
  else {
    for (const entry of entries) {
      print(describeEntry(entry));
      for (const command of entry.commands ?? []) print(`    ${JSON.stringify(command)}`);
    }
    const stacks = historyOf(readLog(path));
    print(`undo available: ${stacks.undo.length}, redo available: ${stacks.redo.length}`);
  }
  return 0;
}

async function watchLog(args: Args): Promise<number> {
  const path = requireDocument(args, "animator watch <doc>");
  let seen = readLog(path).at(-1)?.seq ?? 0;
  print(`watching ${path} (from entry #${seen}); Ctrl+C stops`);
  const logPath = resolve(path).replace(/\.json$/i, "") + ".log.ndjson";
  const report = () => {
    for (const entry of readLog(path)) {
      if (entry.seq <= seen) continue;
      seen = entry.seq;
      print(has(args, "json") ? JSON.stringify(entry) : describeEntry(entry));
    }
  };
  watch(dirname(logPath), (_event, file) => {
    if (file && basename(String(file)) === basename(logPath)) report();
  });
  return new Promise(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function ops(args: Args): number {
  const filter = args.positional[0];
  const list = describeCommands().filter((entry) => !filter || entry.op.startsWith(filter));
  if (has(args, "json")) {
    print(JSON.stringify(list, null, 1));
    return 0;
  }
  for (const entry of list) {
    print(`${entry.op}  ${entry.params.join(" ")}`);
    print(`    ${entry.summary}`);
    print(`    e.g. ${JSON.stringify(entry.example)}`);
  }
  return 0;
}

/** `animator bone add <doc> <name> --world X,Y [--tip X,Y]`: bone.add from canvas points, no JSON to quote. */
async function boneCommand(args: Args): Promise<number> {
  const [verb, doc, name] = args.positional;
  const usage = "usage: animator bone add <doc> <name> [--parent P] --world X,Y [--tip X,Y] [--length L] [--rotation R] [--limits MIN,MAX]";
  if (verb !== "add" || !doc || !name) throw new UsageError(usage);
  const pair = (key: string): [number, number] | undefined => {
    const value = flag(args, key);
    if (value === undefined) return undefined;
    const parts = value.split(",").map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new UsageError(`--${key} must look like X,Y (got '${value}')`);
    return parts as [number, number];
  };
  const world = pair("world");
  if (!world) throw new UsageError(usage);
  const tip = pair("tip");
  const limits = pair("limits");
  const command: Command = { op: "bone.add", name, world, ...(tip ? { tip } : {}), ...(flag(args, "parent") ? { parent: flag(args, "parent") } : {}), ...(numberFlag(args, "length") !== undefined ? { length: numberFlag(args, "length") } : {}), ...(numberFlag(args, "rotation") !== undefined ? { rotation: numberFlag(args, "rotation") } : {}), ...(limits ? { limits: { min: limits[0], max: limits[1] } } : {}) } as Command;
  return runCommands({ ...args, positional: [doc] }, requireDocument({ ...args, positional: [doc] }, usage), [command]);
}

function info(args: Args): number {
  const path = requireDocument(args, "animator info <doc>");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = parseAnimDocument(raw);
  if (!parsed.ok) {
    for (const issue of parsed.issues) print(formatIssue(issue));
    return 1;
  }
  const doc = parsed.document;
  const summary = {
    name: doc.name,
    revision: doc.revision,
    canvas: doc.canvas,
    bones: doc.bones.map((bone) => ({ name: bone.name, parent: bone.parent ?? null, x: bone.x, y: bone.y, rotation: bone.rotation, length: bone.length, ...(bone.limits ? { limits: bone.limits } : {}), ...(bone.skin ? { skin: true } : {}) })),
    slots: doc.slots.map((slot) => ({ name: slot.name, bone: slot.bone, attachment: slot.attachment, ...(slot.blend !== "normal" ? { blend: slot.blend } : {}) })),
    drawOrder: doc.drawOrder ?? doc.slots.map((slot) => slot.name),
    skins: Object.fromEntries(
      Object.entries(doc.skins).map(([name, skin]) => [
        name,
        {
          attachments: Object.fromEntries(Object.entries(skin.attachments).map(([slot, list]) => [slot, Object.entries(list).map(([n, a]) => `${n} (${a.type}${a.type === "mesh" ? `, ${a.uvs.length / 2} vertices${a.bones ? ", weighted" : ""}` : ""})`)])),
          ...(skin.hides.length ? { hides: skin.hides } : {}),
          ...(skin.bones.length ? { bones: skin.bones } : {})
        }
      ])
    ),
    constraints: { ik: doc.ik.map((c) => c.name), transform: doc.transform.map((c) => c.name), physics: doc.physics.map((c) => c.name) },
    driven: doc.driven.map((d) => `${d.name} (${d.bone}, ${d.keys.length} keys)`),
    events: Object.keys(doc.events),
    clips: Object.fromEntries(
      Object.entries(doc.animations).map(([name, clip]) => {
        const timelines = [
          ...Object.entries(clip.bones).flatMap(([bone, t]) => Object.entries(t).map(([kind, keys]) => `bone ${bone} ${kind} [${(keys ?? []).map((k) => k.time).join(", ")}]`)),
          ...Object.entries(clip.slots).flatMap(([slot, t]) => Object.entries(t).map(([kind, keys]) => `slot ${slot} ${kind} [${(keys ?? []).map((k) => k.time).join(", ")}]`)),
          ...Object.entries(clip.ik).map(([n, keys]) => `ik ${n} [${keys.map((k) => k.time).join(", ")}]`),
          ...Object.entries(clip.transform).map(([n, keys]) => `transform ${n} [${keys.map((k) => k.time).join(", ")}]`),
          ...Object.entries(clip.physics).flatMap(([n, t]) => Object.entries(t).map(([kind, keys]) => `physics ${n} ${kind} [${(keys ?? []).map((k) => k.time).join(", ")}]`)),
          ...Object.entries(clip.deform).flatMap(([skin, slots]) => Object.entries(slots).flatMap(([slot, atts]) => Object.entries(atts).map(([a, keys]) => `deform ${skin}/${slot}/${a} [${keys.map((k) => k.time).join(", ")}]`))),
          ...(clip.drawOrder.length ? [`drawOrder [${clip.drawOrder.map((k) => k.time).join(", ")}]`] : []),
          ...(clip.events.length ? [`events ${clip.events.map((e) => `${e.name}@${e.time}`).join(", ")}`] : [])
        ];
        return [name, { duration: clip.duration, loop: clip.loop, timelines }];
      })
    ),
    warnings: parsed.warnings.map(formatIssue)
  };
  if (has(args, "json")) {
    print(JSON.stringify(summary, null, 1));
    return 0;
  }
  print(`${doc.name} r${doc.revision}: canvas ${doc.canvas.width}x${doc.canvas.height}, origin ${doc.canvas.originX},${doc.canvas.originY}`);
  print(`bones (${doc.bones.length}):`);
  const depth = new Map<string, number>();
  for (const bone of summary.bones) {
    const d = bone.parent ? (depth.get(bone.parent) ?? 0) + 1 : 0;
    depth.set(bone.name, d);
    print(`  ${"  ".repeat(d)}${bone.name}  x ${bone.x} y ${bone.y} rot ${bone.rotation} len ${bone.length}${bone.limits ? ` limits ${bone.limits.min}..${bone.limits.max}` : ""}${bone.skin ? " (skin bone)" : ""}`);
  }
  print(`slots, back to front: ${summary.drawOrder.join(", ")}`);
  for (const slot of summary.slots) print(`  ${slot.name} on ${slot.bone}, shows ${slot.attachment ?? "nothing"}${slot.blend ? `, ${slot.blend}` : ""}`);
  for (const [name, skin] of Object.entries(summary.skins)) {
    print(`skin ${name}${skin.hides ? ` hides ${skin.hides.join(", ")}` : ""}${skin.bones ? ` bones ${skin.bones.join(", ")}` : ""}`);
    for (const [slot, list] of Object.entries(skin.attachments)) print(`  ${slot}: ${list.join("; ")}`);
  }
  // Second rig acceptance: roles (explicit, else inferred), budgets and authoring chains.
  const roles = inferRoles(doc);
  const roleLine = doc.bones.map((bone) => `${bone.name} ${bone.role ?? `${roles.roles.get(bone.name) ?? "other"}*`}`);
  print(`roles (* = inferred; set with bone.set role): ${roleLine.join(", ")}`);
  if (doc.budgets) print(`budgets: ${JSON.stringify(doc.budgets)}`);
  const chains = doc.authoring?.chains ?? [];
  print(chains.length ? `chains: ${chains.map((c) => `${c.id}${c.role ? ` (${c.role})` : ""}${c.parent ? ` <- ${c.parent}` : ""}: ${c.bones.join(">")}`).join("; ")}` : "chains: none declared (inferred for review poses)");
  print(`constraints: ik [${summary.constraints.ik.join(", ")}] transform [${summary.constraints.transform.join(", ")}] physics [${summary.constraints.physics.join(", ")}]`);
  if (summary.driven.length) print(`driven: ${summary.driven.join("; ")}`);
  print(`events: ${summary.events.join(", ") || "none"}`);
  for (const [name, clip] of Object.entries(summary.clips)) {
    print(`clip ${name}: ${clip.duration}s${clip.loop ? " loop" : ""}`);
    for (const line of clip.timelines) print(`  ${line}`);
  }
  for (const warning of summary.warnings) print(warning);
  return 0;
}

function printReport(report: ValidationReport): void {
  for (const issue of report.issues) print(formatValidationIssue(issue));
  const errors = report.issues.filter((issue) => issue.severity === "error").length;
  const warnings = report.issues.length - errors;
  print(report.ok ? `valid (${warnings} warning(s))` : `INVALID: ${errors} error(s), ${warnings} warning(s)`);
}

function loadAtlas(path: string): { pack: AtlasPack; textures: Map<string, RgbaImage> } {
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const pages = new Map(pack.pages.map((page) => [page.file, readPng(join(dirname(path), page.file))]));
  return { pack, textures: texturesFromAtlas(pack, pages) };
}

function validate(args: Args): number {
  const input = requireDocument(args, "animator validate <rig.anim.json> [--atlas <rig.atlas.json>] [--outfits tunic+cape,...]");
  const raw: unknown = JSON.parse(readFileSync(input, "utf8"));
  const atlasPath = flag(args, "atlas") ?? input.replace(/\.anim\.json$/, ".atlas.json");
  const atlas = existsSync(atlasPath) && atlasPath !== input ? loadAtlas(atlasPath) : null;
  // Declared outfit combinations (item skins worn together, the body implied): `a+b,c+d`.
  const outfits = (flag(args, "outfits") ?? "").split(",").filter(Boolean).map((outfit) => outfit.split("+").filter(Boolean));
  // The rig's validation companion (regions, allowances, exceptions, poses; hash-checked).
  const companionPath = input.replace(/\.anim\.json$/, ".validation.json");
  const companion = existsSync(companionPath) && companionPath !== input ? (JSON.parse(readFileSync(companionPath, "utf8")) as ValidationCompanion) : undefined;
  // Budgets: the document's `budgets` over --preset's, under --body-vertices N.
  const bodyVertices = numberFlag(args, "body-vertices");
  const presetName = flag(args, "preset");
  const preset = presetName === undefined ? undefined : BODY_PRESETS[presetName];
  if (presetName !== undefined && !preset) throw new UsageError(`unknown --preset ${presetName} (known: ${Object.keys(BODY_PRESETS).join(", ")})`);
  const extra = { ...(bodyVertices === undefined ? {} : { budgets: { bodyVertices } }), ...(preset ? { preset } : {}) };
  // Joints come from the document's authoring block (validateRig's default).
  const report = validateRig(raw, atlas ? { atlas: atlas.pack, textures: atlas.textures, outfits, companion, ...extra } : { outfits, companion, ...extra });
  printReport(report);
  if (has(args, "poses")) {
    print(`geometry: ${report.geometry.findings.length} finding(s), worst ${report.geometry.worst || "none"}; tears poses judged: ${new Set(report.tears.map((t) => t.pose)).size}`);
  }
  return report.ok ? 0 : 1;
}

/** Body presets the CLI knows by name (--preset). */
const BODY_PRESETS: Record<string, BodyPreset> = { [HUMANOID_BODY.name]: HUMANOID_BODY };

/**
 * `animator weights overview <doc> [<doc>...] --out <png>`: each document's weights overview (every
 * weighted mesh, vertices coloured by their bones' mix, at the setup pose; textures from the
 * sibling `.atlas.json` when present), side by side, labelled folder/file.
 */
function weights(args: Args): number {
  const [verb, ...docs] = args.positional;
  const out = flag(args, "out");
  if (verb !== "overview" || docs.length === 0 || !out) throw new UsageError("usage: animator weights overview <doc> [<doc>...] --out <png> [--skins body,...] [--ambiguous]");
  const skins = (flag(args, "skins") ?? "body").split(",").filter(Boolean);
  const tiles = docs.map((path) => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const loaded = parseAnimDocument(raw);
    if (!loaded.ok) throw new Error(`${path}: ${loaded.issues.map(formatIssue).join("; ")}`);
    const atlasPath = path.replace(/.anim.json$/, ".atlas.json");
    const textures = atlasPath !== path && existsSync(atlasPath) ? loadAtlas(atlasPath).textures : new Map<string, RgbaImage>();
    const markers = has(args, "ambiguous") ? ambiguousMarkers(raw, skins, path) : undefined;
    return { image: weightOverview(loaded.document, textures, skins, markers), label: `${basename(dirname(resolve(path)))}/${basename(path)}` };
  });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writePng(out, grid(tiles, tiles.length));
  print(`wrote ${out} (${tiles.length} document(s))`);
  return 0;
}

/**
 * `--ambiguous`: re-runs `weights.auto` in memory on each weighted mesh of the setup
 * attachments, with the mesh's own bone table as the tree (each bone hung from its nearest table
 * ancestor), and returns the ambiguous vertex IDs per slot for the overlay. Nothing is written.
 */
function ambiguousMarkers(raw: JsonObject, skins: readonly string[], path: string): Map<string, number[]> {
  const markers = new Map<string, number[]>();
  const parentOf = new Map(((raw["bones"] as { name: string; parent?: string }[] | undefined) ?? []).map((b) => [b.name, b.parent]));
  const setup = new Map(((raw["slots"] as { name: string; attachment?: string }[] | undefined) ?? []).map((s) => [s.name, s.attachment]));
  for (const skin of skins) {
    const attachments = (((raw["skins"] as JsonObject | undefined)?.[skin] as JsonObject | undefined)?.["attachments"] ?? {}) as Record<string, Record<string, { type?: string; bones?: string[] }>>;
    for (const [slot, byName] of Object.entries(attachments)) {
      for (const [name, mesh] of Object.entries(byName)) {
        if (mesh.type !== "mesh" || !mesh.bones?.length || setup.get(slot) !== name) continue;
        const table = new Set(mesh.bones);
        const parentIn = (bone: string) => {
          for (let at = parentOf.get(bone); at !== undefined; at = parentOf.get(at)) if (table.has(at)) return at;
          return undefined;
        };
        const order: string[] = [];
        const visit = (bone: string) => {
          if (order.includes(bone)) return;
          const parent = parentIn(bone);
          if (parent !== undefined) visit(parent);
          order.push(bone);
        };
        for (const bone of mesh.bones) visit(bone);
        const roots = order.filter((bone) => parentIn(bone) === undefined);
        if (roots.length !== 1) {
          print(`note: ${path} ${skin}/${slot}/${name}: ${roots.length} root bones in the weight table; no ambiguity overlay`);
          continue;
        }
        const chains = order.map((bone) => ({ bones: [bone], ...(parentIn(bone) !== undefined ? { parent: parentIn(bone) as string } : {}) }));
        try {
          const result = applyCommands(raw, [{ op: "weights.auto", skin, slot, name, chains }], { limits: "off" });
          const vertices = result.notes.flatMap((note) => note.vertices ?? []);
          if (vertices.length > 0) markers.set(slot, vertices);
          print(`ambiguous: ${path} ${skin}/${slot}/${name}: ${vertices.length} vertex(es)${vertices.length > 0 ? ` (${vertices.slice(0, 16).map((v) => `v${v}`).join(", ")}${vertices.length > 16 ? ", ..." : ""})` : ""}`);
        } catch (error) {
          print(`note: ${path} ${skin}/${slot}/${name}: ambiguity not recomputed (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }
  return markers;
}

function readGitVersion(rev: string, path: string): unknown {
  const absolute = resolve(path);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(absolute), encoding: "utf8" });
  if (top.status !== 0) throw new Error(`${path} is not inside a git repository`);
  const rel = relative(top.stdout.trim(), absolute).split("\\").join("/");
  const shown = spawnSync("git", ["show", `${rev}:${rel}`], { cwd: top.stdout.trim(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (shown.status !== 0) throw new Error(`git show ${rev}:${rel} failed: ${shown.stderr.trim()}`);
  return JSON.parse(shown.stdout);
}

function diff(args: Args): number {
  const [a, b] = args.positional;
  const rev = flag(args, "git");
  if (!a || (!b && !rev)) throw new UsageError("usage: animator diff <old.anim.json> <new.anim.json> | animator diff <doc> --git <rev> (rev = old side)");
  const before = b ? JSON.parse(readFileSync(a, "utf8")) : readGitVersion(rev as string, a);
  const after = JSON.parse(readFileSync(b ?? a, "utf8"));
  const changes = diffDocuments(before, after);
  print(has(args, "json") ? JSON.stringify(changes, null, 1) : formatDiff(changes));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

async function render(args: Args): Promise<number> {
  const path = requireDocument(args, "animator render <doc> [--clip C] [--mp4 F] [--gif F] [--sheet F] [--png-dir D]");
  const outputs = ["mp4", "gif", "sheet", "png-dir", "png"].filter((name) => has(args, name));
  if (outputs.length === 0) throw new UsageError("give at least one output: --mp4 <file>, --gif <file>, --sheet <file>, --png-dir <dir> or --png <file> (first frame)");
  const { renderFrames, writeGif, writeMp4, writePngSequence, writeSheet } = await import("./render.js");
  const size = pairFlag(args, "size", /x/);
  const origin = pairFlag(args, "origin", /,/);
  const background = flag(args, "background");
  const skins = flag(args, "skins");
  const started = Date.now();
  const result = await renderFrames({
    document: path,
    ...(flag(args, "atlas") ? { atlas: flag(args, "atlas") as string } : {}),
    clip: flag(args, "clip") ?? null,
    ...(skins ? { skins: skins.split(",").filter(Boolean) } : {}),
    ...(numberFlag(args, "fps") !== undefined ? { fps: numberFlag(args, "fps") as number } : {}),
    ...(numberFlag(args, "frames") !== undefined ? { frames: numberFlag(args, "frames") as number } : {}),
    ...(numberFlag(args, "scale") !== undefined ? { scale: numberFlag(args, "scale") as number } : {}),
    ...(size ? { width: size[0], height: size[1] } : {}),
    ...(origin ? { x: origin[0], y: origin[1] } : {}),
    ...(numberFlag(args, "warmup") !== undefined ? { warmup: numberFlag(args, "warmup") as number } : {}),
    ...(background === undefined ? {} : { background: background === "transparent" ? null : parseInt(background.replace(/^#|^0x/, ""), 16) })
  });
  print(`rendered ${result.frames.length} frame(s) of ${result.clip ?? "the setup pose"} at ${result.width}x${result.height}, ${result.fps} fps (${result.renderer}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (result.missingTextures.length) print(`warning: missing textures: ${result.missingTextures.join(", ")}`);
  const written: string[] = [];
  const pngDir = flag(args, "png-dir");
  if (pngDir) written.push(`${writePngSequence(result, pngDir).length} frames in ${pngDir}`);
  const png = flag(args, "png");
  if (png) {
    mkdirSync(dirname(resolve(png)), { recursive: true });
    writeFileSync(png, result.frames[0]?.png as Buffer);
    written.push(png);
  }
  const mp4 = flag(args, "mp4");
  if (mp4) {
    writeMp4(result, mp4);
    written.push(`${mp4} (${statSync(mp4).size} bytes)`);
  }
  const gif = flag(args, "gif");
  if (gif) {
    writeGif(result, gif);
    written.push(`${gif} (${statSync(gif).size} bytes)`);
  }
  const sheet = flag(args, "sheet");
  if (sheet) {
    writeSheet(result, sheet, { ...(numberFlag(args, "sheet-count") ? { count: numberFlag(args, "sheet-count") as number } : {}), ...(numberFlag(args, "sheet-columns") ? { columns: numberFlag(args, "sheet-columns") as number } : {}) });
    written.push(sheet);
  }
  for (const line of written) print(`wrote ${line}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Rig (Phase 4)
// ---------------------------------------------------------------------------------------------

export function writeReviewImages(doc: NonNullable<ValidationReport["document"]>, textures: ReadonlyMap<string, RgbaImage>, dir: string, body?: BodyPreset): string[] {
  const written: string[] = [];
  const write = (name: string, image: RgbaImage | null) => {
    if (!image) return;
    writePng(join(dir, name), image);
    written.push(join(dir, name));
  };
  write("weights-overview.png", weightOverview(doc, textures));
  // One heat sheet per weighted slot of the document (unweighted slots give none).
  for (const slot of doc.slots) write(`weights-${slot.name}.png`, weightHeatSheet(doc, textures, slot.name));
  write("joints-sheet.png", jointContactSheet(doc, textures));
  write("joints-sheet-wireframe.png", jointContactSheet(doc, textures, { wireframe: true }));
  // Close-ups: canvas crops are body-preset data, never CLI constants.
  for (const crop of body?.reviewCrops ?? []) write(`${crop.name}.png`, jointContactSheet(doc, textures, { frame: crop.frame(doc.canvas), scale: crop.scale, columns: crop.columns }));
  return written;
}

/**
 * `animator rig --canonical <preset.json> --out <dir>`: the canonical body (the only rig
 * path): the surface preset is built by buildRig and written by writeRig (document, atlas, source
 * SVG, validation companion), its contract gates run and `<preset>.gates.json` is written beside.
 * The raster path from a figure PNG (cut parts, joint pieces, fades) was retired in.
 */
async function rig(args: Args): Promise<number> {
  const input = args.positional[0];
  const out = flag(args, "out");
  const usage = "usage: animator rig --canonical <preset.json> --out <dir> [--review <dir>] [--preset humanoid]  (the raster rig from a figure PNG was retired in)";
  if (!has(args, "canonical") || !input || !out) throw new UsageError(usage);
  const { runSurface } = await import("./surface.js");
  const { ok, summary } = await runSurface({ preset: input, out });
  const files = summary.files as { document: string; atlas: string };
  print(`rigged ${basename(input)} (canonical): ${files.document}`);
  for (const line of (summary.failures as string[] | undefined) ?? []) process.stderr.write(`gate failed: ${line}
`);
  print(`gates: ${ok ? "green" : "red"} (${join(resolve(out), `${String(summary.preset)}.gates.json`)})`);
  const review = flag(args, "review");
  if (review) {
    const atlas = loadAtlas(files.atlas);
    const report = validateRig(JSON.parse(readFileSync(files.document, "utf8")), { atlas: atlas.pack, textures: atlas.textures });
    const presetName = flag(args, "preset");
    const body = presetName ? BODY_PRESETS[presetName] : undefined;
    if (presetName && !body) throw new UsageError(`unknown --preset '${presetName}' (known: ${Object.keys(BODY_PRESETS).join(", ")})`);
    mkdirSync(review, { recursive: true });
    if (report.document) for (const file of writeReviewImages(report.document, atlas.textures, review, body)) print(`wrote ${file}`);
  }
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

/** `animator atlas import...` and `animator outline trace...` (src/cli/assets.ts). */
async function assetCommand(group: "atlas" | "outline", args: Args): Promise<number> {
  const verb = args.positional[0];
  if (group === "atlas" && verb === "split") {
    const [, input] = args.positional;
    const nums = (key: string, n: number) => {
      const parts = (flag(args, key) ?? "").split(",").map(Number);
      if (parts.length !== n || !parts.every(Number.isFinite)) throw new UsageError(`--${key} needs ${n} comma-separated numbers`);
      return parts;
    };
    const restOut = flag(args, "out");
    const partOut = flag(args, "part");
    if (!input || !restOut || !partOut) throw new UsageError("usage: animator atlas split <in.png> --line X1,Y1,X2,Y2 --seed X,Y --out <rest.png> --part <part.png> [--overlap 14]");
    const result = (await import("./assets.js")).splitPng(input, nums("line", 4) as [number, number, number, number], nums("seed", 2) as [number, number], restOut, partOut, numberFlag(args, "overlap") ?? 14);
    print(`wrote ${restOut} (${result.rest} px) and ${partOut} (${result.part} px + ${result.band} px overlap band); import the part first so it draws behind, trace it with a finer --spacing, then weights.seam both meshes on the bone they hang from`);
    return 0;
  }
  if (group === "atlas" && verb === "trim") {
    const [, input, output] = args.positional;
    if (!input || !output) throw new UsageError("usage: animator atlas trim <in.png> <out.png> [--pad 16]");
    const trimmed = (await import("./assets.js")).trimPng(input, output, numberFlag(args, "pad") ?? 16);
    print(`wrote ${output}: ${trimmed.width}x${trimmed.height} (opaque ${trimmed.opaque.width}x${trimmed.opaque.height} at ${trimmed.opaque.x},${trimmed.opaque.y} of the input, pad ${trimmed.pad})`);
    print(`next: animator new <doc> --name <n> --size ${trimmed.width}x${trimmed.height} --origin <X,Y>, then atlas import <doc> ${output}`);
    return 0;
  }
  const want = group === "atlas" ? "import" : "trace";
  if (verb !== want) throw new UsageError(group === "atlas" ? "usage: animator atlas import <doc> <png...> [--skin body] [--bone root] [--scale 1] [--swaps]" : "usage: animator outline trace <doc> <png> --slot S [--skin body] [--name N] [--target 320 | --spacing P] [--tolerance 2.5] [--components all|largest]");
  const rest: Args = { ...args, positional: args.positional.slice(1) };
  const path = requireDocument(rest, `animator ${group} ${want} <doc> ...`);
  // Plan: every option is validated before anything is read for writing or written.
  const check = checkMode(rest);
  const mode = limitsMode(rest);
  const dryRun = has(rest, "dry-run");
  const assets = await import("./assets.js");
  // --dry-run reads the file only (no repair, no log entry); a real run opens it through the log.
  const raw = (dryRun ? readDocument(path).doc : openDocument(path).stored.doc) as Record<string, unknown>;
  const plan = group === "atlas" ? assets.atlasImport(path, raw, rest.positional.slice(1), rest.flags) : assets.outlineTrace(raw, rest.positional[1], rest.flags);
  for (const note of plan.notes) print(`note: ${note}`);
  if (dryRun) {
    for (const file of plan.files) print(`would write ${file.path}`);
    return runCommands(rest, path, plan.commands);
  }
  // The batch must apply under the run's own options (a --limits reject failure included) before
  // any asset is written. --check end with reject keeps the batch (runCommands), so it warns here.
  applyCommands(raw as JsonObject, plan.commands, { check, limits: check === "end" && mode === "reject" ? "warn" : mode });
  // Transaction: a new immutable bundle, then the document commit that points at it,
  // then the pointer. A failed commit removes the unreferenced bundle; an interrupted run leaves
  // either an orphan bundle (document unchanged) or a stale pointer that the next sync repairs.
  const written = assets.writePlanFiles(plan);
  for (const file of written) print(`wrote ${file}`);
  let code: number;
  try {
    code = await runCommands(rest, path, plan.commands);
  } catch (error) {
    assets.removePlanFiles(written);
    if (written.length > 0) process.stderr.write(`removed the unreferenced bundle (${written.length} file(s))\n`);
    throw error;
  }
  const synced = written.length > 0 ? assets.syncAtlasPointer(path) : null;
  if (synced) print(`atlas: ${synced}`);
  return code;
}

const COMMANDS: Record<string, (args: Args) => number | Promise<number>> = {
  ops,
  new: newDocument,
  info,
  apply,
  "apply-script": applyScript,
  undo: (args) => history("undo", args),
  redo: (args) => history("redo", args),
  log,
  watch: watchLog,
  validate: async (args) => (args.flags.has("contract") ? (await import("./validateContract.js")).validateContractCommand(String(args.flags.get("contract") ?? ""), args.flags) : validate(args)),
  diff,
  render,
  garment: (args) => (args.positional[0] === "import" ? garmentImportCommand(args.positional.slice(1), args.flags) : (process.stderr.write("usage: animator garment import <rig.anim.json> <art.png> <out dir> [flags]\n"), 2)),
  atlas: (args) => assetCommand("atlas", args),
  outline: (args) => assetCommand("outline", args),
  rig,
  weights,
  bone: boneCommand,
  "rest-fidelity": async (args) => {
    const [doc, art] = args.positional;
    if (!doc || !art) throw new UsageError("usage: animator rest-fidelity <doc> <source.png> [--out <prefix>] [--controls]");
    const out = flag(args, "out") ?? join(dirname(resolve(doc)), "rest-fidelity");
    return (await import("./restFidelity.js")).restFidelityCommand(resolve(doc), resolve(art), out, has(args, "controls"));
  },
  surface: async (args) => (await import("./surface.js")).surfaceCommand(args.positional, args.flags),
  "ref-compare": async (args) => (await import("./refCompare.js")).refCompareCommand(args.positional, args.flags),
  "cap-arc-sheet": async (args) => (await import("./capArcSheet.js")).capArcSheetCommand(args.positional, args.flags),
  "pivot-fit": async (args) => (await import("./pivotFit.js")).pivotFitCommand(args.positional, args.flags),
  layers: async (args) => (await import("./layers.js")).layersCommand(args.positional, args.flags),
  "export-spine": async (args) => (await import("./exportSpine.js")).exportSpineCommand(args.positional, args.flags),
  "validate-publish": async (args) => (await import("./validatePublish.js")).validatePublishCommand(args.positional, args.flags),
  "import-spine": async (args) => (await import("./importSpineMeshes.js")).importSpineMeshesCommand(args.positional, args.flags),
  "import-spine-clips": async (args) => (await import("./importSpine.js")).importSpineCommand(args.positional, args.flags)
};

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const run = command ? COMMANDS[command] : undefined;
  if (!run) {
    process.stderr.write(`usage: animator <${Object.keys(COMMANDS).join("|")}> ...  (reference: packages/animator/README.md)\n`);
    return 2;
  }
  try {
    return await run(parseArgs(rest));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof CommandError ? "rejected: " : "error: "}${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const stem = (path: string) => resolve(path).replace(/\.[cm]?[jt]s$/, "");
const invokedDirectly = process.argv[1] !== undefined && stem(process.argv[1]) === stem(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    // `watch` never resolves; every other command exits with its code.
    process.exitCode = code;
  });
}
