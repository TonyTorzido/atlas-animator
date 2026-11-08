/*
 * Atlas Animator: the Publish validator (Batch 9, PL-10 / PL-03).
 *
 * Reads what the editor's "Publish to project folder" wrote into a repo (`packages/animator/publish-manifest.json`, the rig folder
 * `packages/animator/rigs/<rig>/` and published clips in `packages/animator/clips/`) and checks that it loads the way a game
 * loader would load it:
 *   - every file the manifest lists is there with the hash Publish recorded;
 *   - every rig document loads (`loadAnimDocument`), its atlas manifest parses and every page is a whole PNG of the listed size;
 *   - every attachment of every skin resolves: regions and meshes to an atlas region, linked meshes to a mesh;
 *   - every skin placeholder resolves: an item skin's art on a slot sits under the slot's setup (placeholder) attachment name,
 *     so wearing the skin swaps it in (a slot whose placeholder the default skin leaves empty is "empty until worn", not an error);
 *   - every clip mapped in `clipMap.json` exists (a warning, or an error with `requireClips`), and every published clip only
 *     keys bones / slots / constraints the rig has.
 * It prints a report and exits 1 on any error. Nothing is written.
 *
 *   tsx src/cli/validatePublish.ts --repo <repo root> --rig <rig dir> [--require-clips] [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import type { AnimDocument } from "../core/format.js";
import { CLIP_MAP, type ClipMap } from "../clipMap.js";
import { decodePng } from "../tools/png.js";

export const PUBLISH_MANIFEST_REL = "packages/animator/publish-manifest.json";
export const PUBLISH_MANIFEST_FORMAT = "atlas-publish-manifest@1";
const RIGS_REL = "packages/animator/rigs";
const CLIPS_REL = "packages/animator/clips";

export interface PublishManifest {
  format: typeof PUBLISH_MANIFEST_FORMAT;
  rigs: Record<string, { publishedAt: string; target: string; files: Record<string, string> }>;
  clips: Record<string, { publishedAt: string; target: string; sha1: string }>;
}

export interface ValidateOptions {
  repoRoot: string;
  rig: string;
  /** Missing mapped clips are errors instead of warnings. */
  requireClips?: boolean;
  clipMap?: ClipMap;
}

export interface ValidateReport {
  ok: boolean;
  rig: string;
  errors: string[];
  warnings: string[];
  /** One line per check that passed, for the report. */
  passed: string[];
  counts: { documents: number; pages: number; attachments: number; placeholders: number; mappedClips: number; publishedClips: number };
  /** Catalogue clips with a clipMap row and no published clip file. */
  missingClips: string[];
}

const sha1 = (bytes: Buffer): string => createHash("sha1").update(bytes).digest("hex");

export function readPublishManifest(repoRoot: string): PublishManifest | null {
  const file = resolve(repoRoot, PUBLISH_MANIFEST_REL);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as PublishManifest;
  if (raw.format !== PUBLISH_MANIFEST_FORMAT) throw new Error(`${PUBLISH_MANIFEST_REL}: expected format ${PUBLISH_MANIFEST_FORMAT}`);
  return { format: raw.format, rigs: raw.rigs ?? {}, clips: raw.clips ?? {} };
}

export function validatePublish(o: ValidateOptions): ValidateReport {
  const map = o.clipMap ?? CLIP_MAP;
  const errors: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];
  const counts = { documents: 0, pages: 0, attachments: 0, placeholders: 0, mappedClips: 0, publishedClips: 0 };
  const missingClips: string[] = [];
  const done = (): ValidateReport => ({ ok: errors.length === 0, rig: o.rig, errors, warnings, passed, counts, missingClips });

  let manifest: PublishManifest | null;
  try {
    manifest = readPublishManifest(o.repoRoot);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return done();
  }
  if (!manifest) {
    errors.push(`nothing was published here: ${PUBLISH_MANIFEST_REL} is missing`);
    return done();
  }
  const entry = manifest.rigs[o.rig];
  if (!entry) {
    errors.push(`rig '${o.rig}' was never published (no entry in ${PUBLISH_MANIFEST_REL})`);
    return done();
  }
  const rigDir = resolve(o.repoRoot, RIGS_REL, o.rig);

  // 1. Files and hashes.
  let hashOk = 0;
  for (const [file, hash] of Object.entries(entry.files)) {
    const abs = resolve(rigDir, file);
    if (!existsSync(abs)) errors.push(`${file}: listed in the publish manifest but missing from ${RIGS_REL}/${o.rig}`);
    else if (sha1(readFileSync(abs)) !== hash) errors.push(`${file}: differs from what Publish wrote (stale or edited after publishing)`);
    else hashOk++;
  }
  if (hashOk) passed.push(`${hashOk} published file(s) match their manifest hashes`);

  // 2. Documents, atlases, attachments, placeholders.
  const docs = Object.keys(entry.files).filter((f) => f.endsWith(".anim.json") && !f.includes("/"));
  if (!docs.length) errors.push(`rig '${o.rig}' has no published .anim.json document`);
  const rigs: { name: string; doc: AnimDocument }[] = [];
  for (const file of docs) {
    const abs = resolve(rigDir, file);
    if (!existsSync(abs)) continue;
    let doc: AnimDocument;
    try {
      doc = loadAnimDocument(JSON.parse(readFileSync(abs, "utf8")), { source: file });
    } catch (error) {
      errors.push(`${file}: does not load: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      continue;
    }
    counts.documents++;
    rigs.push({ name: file, doc });
    const atlasFile = file.replace(/\.anim\.json$/, ".atlas.json");
    let atlas: AtlasPack | null = null;
    try {
      atlas = atlasPackSchema.parse(JSON.parse(readFileSync(resolve(rigDir, atlasFile), "utf8")));
    } catch (error) {
      errors.push(`${atlasFile}: missing or not an atlas-pack@1 manifest (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
    const regions = new Set<string>();
    if (atlas) {
      for (const page of atlas.pages) {
        for (const p of Object.keys(page.regions)) regions.add(p);
        const pageFile = resolve(rigDir, page.file);
        if (!existsSync(pageFile)) {
          errors.push(`${atlasFile}: page ${page.file} is missing`);
          continue;
        }
        try {
          const img = decodePng(readFileSync(pageFile));
          if (img.width !== page.width || img.height !== page.height) errors.push(`${page.file}: is ${img.width}x${img.height}, the atlas says ${page.width}x${page.height}`);
          else counts.pages++;
        } catch (error) {
          errors.push(`${page.file}: not a readable PNG (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const listed = new Set(atlas.pages.map((p) => p.file));
      const stale = (doc.atlas?.pages ?? []).filter((p) => !listed.has(p));
      if (stale.length) warnings.push(`${file}: atlas.pages lists ${stale.length} page(s) the atlas manifest does not have (${stale.slice(0, 3).join(", ")}); regions still resolve through the manifest`);
    }

    const skins = Object.keys(doc.skins);
    const defaultSkin = skins[0];
    const resolveAtt = (skin: string, slot: string, name: string, depth = 0): string | null => {
      const a = doc.skins[skin]?.attachments[slot]?.[name];
      if (!a) return `no attachment '${name}'`;
      if (a.type === "region" || a.type === "mesh") return regions.has(a.path) ? null : `image '${a.path}' is not in the atlas`;
      if (a.type === "linkedMesh") {
        if (depth > 4) return "linked mesh chain is too deep";
        const src = doc.skins[a.source.skin]?.attachments[a.source.slot]?.[a.source.attachment];
        if (!src || (src.type !== "mesh" && src.type !== "linkedMesh")) return `linked mesh source ${a.source.skin}/${a.source.slot}/${a.source.attachment} is not a mesh`;
        const own = regions.has(a.path) ? null : `image '${a.path}' is not in the atlas`;
        return own ?? resolveAtt(a.source.skin, a.source.slot, a.source.attachment, depth + 1);
      }
      return null; // points and other non-image attachments resolve to themselves
    };
    for (const skin of skins) {
      for (const [slot, byName] of Object.entries(doc.skins[skin]!.attachments)) {
        for (const name of Object.keys(byName)) {
          counts.attachments++;
          const why = resolveAtt(skin, slot, name);
          if (why) errors.push(`${file}: ${skin}/${slot}/${name}: ${why}`);
        }
      }
    }
    let emptyUntilWorn = 0;
    for (const slot of doc.slots) {
      const placeholder = slot.attachment;
      if (!placeholder) continue;
      if (!defaultSkin || !doc.skins[defaultSkin]?.attachments[slot.name]?.[placeholder]) emptyUntilWorn++;
      for (const skin of skins.slice(1)) {
        const own = doc.skins[skin]?.attachments[slot.name];
        if (!own || !Object.keys(own).length) continue;
        counts.placeholders++;
        // The attachment itself was resolved above; here only its name matters (a different name never shows when worn).
        if (!own[placeholder]) warnings.push(`${file}: skin '${skin}': art on slot '${slot.name}' is not under the placeholder name '${placeholder}', so wearing the skin does not show it`);
      }
    }
    if (emptyUntilWorn) passed.push(`${file}: ${emptyUntilWorn} slot placeholder(s) are empty until a skin is worn`);
  }
  if (counts.documents) passed.push(`${counts.documents} document(s) load; ${counts.pages} atlas page(s) are whole PNGs; ${counts.attachments} attachment(s) and ${counts.placeholders} skin placeholder(s) checked`);

  // 3. Clips: mapped ones exist, published ones key only what the rig has.
  const clipsDir = resolve(o.repoRoot, CLIPS_REL);
  const keyed = (clip: Record<string, unknown>): { bones: string[]; slots: string[] } => ({
    bones: Object.keys((clip["bones"] as object | undefined) ?? {}),
    slots: Object.keys((clip["slots"] as object | undefined) ?? {})
  });
  const checkClip = (name: string, abs: string) => {
    let clip: Record<string, unknown>;
    try {
      clip = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    } catch (error) {
      errors.push(`clip ${name}: not JSON (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    const k = keyed(clip);
    for (const { name: doc, doc: d } of rigs) {
      const bones = new Set(d.bones.map((b) => b.name));
      const slots = new Set(d.slots.map((s) => s.name));
      const badBones = k.bones.filter((b) => !bones.has(b));
      const badSlots = k.slots.filter((s) => !slots.has(s));
      if (badBones.length || badSlots.length) warnings.push(`clip ${name}: keys ${[...badBones.map((b) => `bone ${b}`), ...badSlots.map((s) => `slot ${s}`)].slice(0, 4).join(", ")} that ${doc} does not have`);
    }
    const pub = manifest!.clips[name];
    if (pub && sha1(readFileSync(abs)) !== pub.sha1) errors.push(`clip ${name}: differs from what Publish wrote`);
    counts.publishedClips++;
  };
  for (const [editorId, row] of Object.entries(map.clips)) {
    counts.mappedClips++;
    const candidates = [`${editorId}.clip.json`, `${row.source}.clip.json`];
    const found = candidates.find((c) => existsSync(join(clipsDir, c)));
    if (!found) {
      missingClips.push(editorId);
      (o.requireClips ? errors : warnings).push(`mapped clip ${editorId} (game ${row.game.map((g) => g.id).join(", ")}) is not published yet`);
      continue;
    }
    checkClip(found, join(clipsDir, found));
  }
  const mappedFiles = new Set(Object.entries(map.clips).flatMap(([id, r]) => [`${id}.clip.json`, `${r.source}.clip.json`]));
  for (const name of Object.keys(manifest.clips)) {
    if (mappedFiles.has(name)) continue;
    const abs = join(clipsDir, name);
    if (!existsSync(abs)) errors.push(`clip ${name}: listed in the publish manifest but missing from ${CLIPS_REL}`);
    else {
      checkClip(name, abs);
      warnings.push(`clip ${name}: published but not in the game (no clipMap.json row)`);
    }
  }
  const existingMapped = counts.mappedClips - missingClips.length;
  passed.push(`${existingMapped} of ${counts.mappedClips} mapped clip(s) published`);
  return done();
}

export function formatReport(r: ValidateReport): string {
  const lines = [`validate-publish ${r.rig}: ${r.ok ? "PASS" : "FAIL"} (${r.errors.length} error(s), ${r.warnings.length} warning(s))`];
  for (const p of r.passed) lines.push(`  ok    ${p}`);
  for (const e of r.errors) lines.push(`  ERROR ${e}`);
  for (const w of r.warnings) lines.push(`  warn  ${w}`);
  return lines.join("\n");
}

export async function validatePublishCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const repo = flags.get("repo");
  const rig = flags.get("rig") ?? positional[0];
  if (typeof rig !== "string") {
    process.stderr.write("usage: animator validate-publish --rig <rig dir> [--repo <repo root>] [--require-clips] [--json]\n");
    return 2;
  }
  const report = validatePublish({ repoRoot: typeof repo === "string" ? repo : resolve(process.cwd(), "../.."), rig, requireClips: flags.has("require-clips") });
  process.stdout.write(flags.has("json") ? `${JSON.stringify(report, null, 1)}\n` : `${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags.set(a.slice(2), argv[++i]!);
    else flags.set(a.slice(2), true);
  }
  validatePublishCommand(positional, flags).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`validate-publish: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
