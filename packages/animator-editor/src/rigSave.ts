/*
 * Atlas Animator editor: saving Setup edits into a rig document (Node; used by the dev server).
 *
 * The editor keeps the command batches of the Setup edits it has applied. Save sends the batches the
 * file does not have yet (and how many saved ones to undo first, when the user undid past a save)
 * and the PNGs of imported images. The batches go through the document store (`applyToFile`), so each
 * one is an entry in the rig's append-only command log (`<rig>.anim.log.ndjson`) and the file's
 * history (`animator undo`) covers them. The request carries the hash of the file text the editor
 * last saw; a file that changed under the editor is refused instead of overwritten.
 *
 * Imported images (PL-11): each PNG the editor sends is kept as its import source in `<rig dir>/imports/<page file>`, and every
 * imported region (new ones, older one-page-per-image `*.imp-*.png` pages and the previous packed pages) is re-packed through
 * `atlasPacker.ts` into `<atlas>.packed-<hash>.<n>.png` pages at page scale (pixels copied, never resampled). The packed page
 * names carry a content hash, so the old manifest keeps pointing at the old pages until the new manifest replaces it: a crash
 * at any point leaves a manifest whose pages and regions agree. The document's `atlas.pages` is rewritten to match by a
 * `doc.set` folded into the save's last batch (same log entry, so Undo of that save takes it back with the edit).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { writeAtomic } from "./safeFs.js";
import { basename, dirname, resolve, sep } from "node:path";
import { atlasPackSchema } from "../../animator/src/core/atlasPack.js";
import { applyCommands, type Command } from "../../animator/src/tools/commands.js";
import { applyToFile, hashText, logPathFor, readDocument, stepHistory } from "../../animator/src/tools/documentStore.js";
import { packAtlas, type PackItem } from "../../animator/src/tools/atlasPacker.js";
import { cropImage } from "../../animator/src/tools/image.js";
import { decodePng, encodePng } from "../../animator/src/tools/png.js";

/** The hash a rig document's text has (the same one `rigHash` and Save rig answer). */
export const rigTextHash = hashText;

export const RIGS_DIR = "packages/animator/rigs";

/**
 * Where rig files live: a repo root (a string; rigs under <root>/packages/animator/rigs, the stock rigs) or the user's rig folder
 * ({ rigsDir }: <data>/rigs, see src/dataDirs.ts). Rig paths stay repo-relative ("packages/animator/rigs/<dir>/...") either way.
 */
export type RigRoot = string | { readonly rigsDir: string };
export const rigsDirOf = (root: RigRoot): string => (typeof root === "string" ? resolve(root, RIGS_DIR) : resolve(root.rigsDir));
/** The absolute file of a repo-relative rig path under a rig root (callers still check it stays inside rigsDirOf). */
export function rigAbs(root: RigRoot, rel: string): string {
  if (typeof root === "string") return resolve(root, rel);
  const clean = String(rel).split(String.fromCharCode(92)).join("/");
  if (clean === RIGS_DIR) return rigsDirOf(root);
  if (!clean.startsWith(`${RIGS_DIR}/`)) throw new SaveError(`expected a file under ${RIGS_DIR}`);
  return resolve(root.rigsDir, clean.slice(RIGS_DIR.length + 1));
}
const PAGE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.png$/;
const TEXTURE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export class SaveError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface SaveImage {
  /** Atlas page file name, written beside the atlas manifest. */
  file: string;
  /** Texture path of its one region. */
  path: string;
  /** `data:image/png;base64,...` */
  png: string;
}

export interface SaveRequest {
  /** Repo-relative rig document (`packages/animator/rigs/<dir>/<name>.anim.json`). */
  file: string;
  /** Repo-relative atlas manifest, needed when images are sent. */
  atlas?: string;
  /** Hash of the file text the editor last saw (from rigHash or the last save); null skips the check. */
  base: string | null;
  /** Saved batches to undo first. */
  undo: number;
  /** Batches to apply, oldest first. */
  batches: Command[][];
  images?: SaveImage[];
}

export interface SaveResult {
  hash: string;
  undone: number;
  applied: number;
  images: string[];
  /** The packed page files the imported images now live in (empty when nothing was re-packed). */
  packed: string[];
}

/** Pages that hold imported images: the old one-page-per-image files and the packed pages. */
export const isImportPage = (file: string): boolean => /\.imp-[^/]*\.png$/.test(file) || /\.packed-[0-9a-f]{8}\.\d+\.png$/.test(file);
export const IMPORTS_DIR = "imports";

function inside(repoRoot: RigRoot, rel: string, suffix: string): string {
  const path = rigAbs(repoRoot, rel);
  if (!path.startsWith(rigsDirOf(repoRoot) + sep) || !path.endsWith(suffix)) throw new SaveError(`expected a file under ${RIGS_DIR} ending in ${suffix}`);
  return path;
}

/** The hash of a rig document's text (the editor's `base`). */
export function rigHash(repoRoot: RigRoot, file: string): string {
  return readDocument(inside(repoRoot, file, ".anim.json")).hash;
}

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString("ascii", 12, 16) !== "IHDR") throw new SaveError("not a PNG image");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function saveRig(repoRoot: RigRoot, req: SaveRequest): SaveResult {
  const path = inside(repoRoot, req.file, ".anim.json");
  if (!existsSync(path)) throw new SaveError(`no rig document ${req.file}`, 404);
  const current = readDocument(path).hash;
  if (req.base !== null && current !== req.base) throw new SaveError(`${basename(path)} changed on disk since the editor opened it; nothing was saved (download your edits, apply them on the newer file, or reload theirs)`, 409);
  if (!Array.isArray(req.batches) || !req.batches.every((b) => Array.isArray(b))) throw new SaveError("batches must be a list of command lists");

  // Everything that can be checked without writing is checked first.
  const images = req.images ?? [];
  let manifestPath = "";
  let manifest: ReturnType<typeof atlasPackSchema.parse> | null = null;
  const decoded: { image: SaveImage; bytes: Buffer; width: number; height: number }[] = [];
  if (images.length) {
    if (!req.atlas) throw new SaveError("images need the atlas manifest path");
    manifestPath = inside(repoRoot, req.atlas, ".atlas.json");
    if (dirname(manifestPath) !== dirname(path)) throw new SaveError("the atlas manifest must sit beside the rig document");
    manifest = atlasPackSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    for (const image of images) {
      if (!PAGE_FILE.test(image.file) || !TEXTURE_PATH.test(image.path)) throw new SaveError(`bad image name '${image.file}' / '${image.path}'`);
      const m = /^data:image\/png;base64,(.+)$/.exec(image.png);
      if (!m) throw new SaveError("images must be PNG data URLs");
      const bytes = Buffer.from(m[1]!, "base64");
      decoded.push({ image, bytes, ...pngSize(bytes) });
    }
  }

  // Re-pack plan (PL-11), computed before the first write. Only a save with batches re-packs: the document change rides on its last batch.
  const dir = dirname(path);
  type Pack = { pages: { file: string; bytes: Buffer }[]; manifest: NonNullable<typeof manifest>; sources: { file: string; bytes: Buffer }[]; remove: string[] };
  let pack: Pack | null = null;
  if (manifest && req.batches.length) {
    const items: PackItem[] = [];
    const sources: { file: string; bytes: Buffer }[] = [];
    const fresh = new Set(decoded.map((d) => d.image.path));
    for (const d of decoded) {
      let image;
      try {
        image = decodePng(d.bytes);
      } catch (error) {
        throw new SaveError(`image ${d.image.file} is not a readable PNG: ${error instanceof Error ? error.message : String(error)}`);
      }
      items.push({ path: d.image.path, image });
      sources.push({ file: d.image.file, bytes: d.bytes });
    }
    const remove: string[] = [];
    for (const page of manifest.pages) {
      if (!isImportPage(page.file)) continue;
      remove.push(page.file);
      const regions = Object.entries(page.regions).filter(([p]) => !fresh.has(p));
      if (!regions.length) continue;
      const file = resolve(dir, page.file);
      if (!existsSync(file)) throw new SaveError(`atlas page ${page.file} is listed in ${basename(manifestPath)} but missing; nothing was saved`, 409);
      const bytes = readFileSync(file);
      const image = decodePng(bytes);
      // An old one-image page becomes its own import source (packed pages already had theirs written).
      if (/\.imp-[^/]*\.png$/.test(page.file) && !existsSync(resolve(dir, IMPORTS_DIR, page.file))) sources.push({ file: page.file, bytes });
      for (const [p, rect] of regions) items.push({ path: p, image: rect.x === 0 && rect.y === 0 && rect.width === image.width && rect.height === image.height ? image : cropImage(image, rect) });
    }
    const atlasBase = basename(manifestPath).replace(/\.atlas\.json$/, "");
    const tag = createHash("sha1");
    for (const it of [...items].sort((a, b) => (a.path < b.path ? -1 : 1))) tag.update(it.path).update(`${it.image.width}x${it.image.height}`).update(it.image.data);
    const packed = packAtlas(items, { name: `${atlasBase}.packed-${tag.digest("hex").slice(0, 8)}`, scale: 1 });
    const kept = manifest.pages.filter((p) => !isImportPage(p.file));
    const next = { ...manifest, pages: [...kept, ...packed.pack.pages] };
    pack = { pages: packed.pages.map((p) => ({ file: p.file, bytes: encodePng(p.image) })), manifest: next, sources, remove: remove.filter((f) => !packed.pages.some((p) => p.file === f)) };
  }

  // One transaction (): the document, its command log, the atlas manifest and every page image are read before the first write,
  // and any failure (an undo the log cannot do, a refused batch, an image or manifest write) puts every one of them back byte for byte.
  // The file then still has the hash the editor sent as `base`, so a retry sends the same batches without repeating a written prefix.
  const saved: { file: string; bytes: Buffer | null }[] = [];
  const keep = (file: string) => {
    if (!saved.some((s) => s.file === file)) saved.push({ file, bytes: existsSync(file) ? readFileSync(file) : null });
  };
  keep(path);
  keep(logPathFor(path));
  if (manifest) {
    keep(manifestPath);
    if (pack) {
      for (const p of pack.pages) keep(resolve(dir, p.file));
      for (const src of pack.sources) keep(resolve(dir, IMPORTS_DIR, src.file));
      for (const f of pack.remove) keep(resolve(dir, f));
    } else for (const { image } of decoded) keep(resolve(dir, image.file));
  }
  try {
    // New files first (import sources, packed pages under new names): until the manifest is replaced nothing points at them.
    if (pack) {
      for (const src of pack.sources) {
        mkdirSync(resolve(dir, IMPORTS_DIR), { recursive: true });
        writeAtomic(resolve(dir, IMPORTS_DIR, src.file), src.bytes);
      }
      for (const p of pack.pages) writeAtomic(resolve(dir, p.file), p.bytes);
    }
    let undone = 0;
    if (req.undo > 0) undone = stepHistory(path, "undo", req.undo, "editor").length;
    if (undone !== req.undo) throw new SaveError(`could only undo ${undone} of ${req.undo} saved batches (the command log has no more); nothing was saved, reload the page`, 409);
    let applied = 0;
    for (const [i, batch] of req.batches.entries()) {
      let commands: Command[] = batch;
      if (pack && i === req.batches.length - 1) commands = [...batch, ...pageListFix(readDocument(path).doc, batch, pack.manifest.pages.map((p) => p.file))];
      try {
        applyToFile(path, commands, { source: "editor", check: "command" });
      } catch (error) {
        throw new SaveError(`batch ${applied + 1} was refused, nothing was saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      applied++;
    }

    const written: string[] = [];
    if (pack) {
      writeAtomic(manifestPath, `${JSON.stringify(atlasPackSchema.parse(pack.manifest), null, 1)}\n`);
      for (const f of pack.remove) if (existsSync(resolve(dir, f))) unlinkSync(resolve(dir, f));
      written.push(...decoded.map((d) => d.image.file));
    } else if (manifest) {
      for (const { image, bytes, width, height } of decoded) {
        writeAtomic(resolve(dir, image.file), bytes);
        const page = { file: image.file, width, height, regions: { [image.path]: { x: 0, y: 0, width, height } } };
        const at = manifest.pages.findIndex((p) => p.file === image.file);
        if (at >= 0) manifest.pages[at] = page;
        else manifest.pages.push(page);
        written.push(image.file);
      }
      writeAtomic(manifestPath, `${JSON.stringify(atlasPackSchema.parse(manifest), null, 1)}\n`);
    }
    saveFault?.(applied);
    return { hash: readDocument(path).hash, undone, applied, images: written, packed: pack ? pack.pages.map((p) => p.file) : [] };
  } catch (error) {
    for (const { file, bytes } of saved) {
      if (bytes) writeAtomic(file, bytes);
      else if (existsSync(file)) unlinkSync(file);
    }
    const imports = resolve(dirname(path), IMPORTS_DIR);
    if (pack && existsSync(imports) && readdirSync(imports).length === 0) rmdirSync(imports);
    throw error;
  }
}

/**
 * The `doc.set` that makes the document's `atlas.pages` list the manifest's pages after `batch` runs: the batch's own pages
 * minus import pages that were re-packed, plus the packed pages. Empty when the list already matches or the rig has no atlas.
 */
function pageListFix(doc: unknown, batch: readonly Command[], manifestPages: readonly string[]): Command[] {
  let after: unknown;
  try {
    after = applyCommands(doc as never, batch, { check: "none" }).doc;
  } catch {
    return []; // applyToFile reports the refusal itself
  }
  const atlas = (after as { atlas?: { pages?: unknown; scale?: unknown } }).atlas;
  if (!atlas || !Array.isArray(atlas.pages)) return [];
  const pages = atlas.pages.map(String);
  const want = [...pages.filter((p) => !isImportPage(p)), ...manifestPages.filter((p) => isImportPage(p))];
  if (want.length === pages.length && want.every((p, i) => p === pages[i])) return [];
  return [{ op: "doc.set", atlas: { pages: want, scale: Number(atlas.scale ?? 1) } } as Command];
}

/** Unit-test hook: throws after every write of a save, so the rollback is proven on a disposable copy. */
let saveFault: ((applied: number) => void) | null = null;
export function setRigSaveFault(fn: ((applied: number) => void) | null): void {
  saveFault = fn;
}
