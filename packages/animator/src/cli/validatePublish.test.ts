import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLISH_MANIFEST_REL, validatePublish } from "./validatePublish.js";

const RIG = "kit-body-front0";
const SRC = new URL(`../../rigs/${RIG}/`, import.meta.url);
const sha1 = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");
let repo = "";
let dir = "";

/** A repo with the rig published the way the editor's Publish writes it (files + publish-manifest.json). */
function publish(extraClips: Record<string, unknown> = {}): void {
  const files: Record<string, string> = {};
  const atlas = JSON.parse(readFileSync(new URL(`${RIG}.atlas.json`, SRC), "utf8")) as { pages: { file: string }[] };
  for (const f of [`${RIG}.anim.json`, `${RIG}.atlas.json`, ...atlas.pages.map((p) => p.file)]) {
    copyFileSync(new URL(f, SRC), join(dir, f));
    files[f] = sha1(readFileSync(join(dir, f)));
  }
  const clips: Record<string, { publishedAt: string; target: string; sha1: string }> = {};
  mkdirSync(join(repo, "packages/animator/clips"), { recursive: true });
  for (const [name, clip] of Object.entries(extraClips)) {
    const text = JSON.stringify(clip);
    writeFileSync(join(repo, "packages/animator/clips", name), text);
    clips[name] = { publishedAt: "2026-10-27T00:00:00.000Z", target: `packages/animator/clips/${name}`, sha1: sha1(text) };
  }
  writeFileSync(join(repo, PUBLISH_MANIFEST_REL), JSON.stringify({ format: "atlas-publish-manifest@1", rigs: { [RIG]: { publishedAt: "2026-10-27T00:00:00.000Z", target: `packages/animator/rigs/${RIG}`, files } }, clips }));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "validate-publish-"));
  dir = join(repo, "packages/animator/rigs", RIG);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("validatePublish", () => {
  it("passes a whole publish: hashes, document, pages, attachments, placeholders; mapped clips found or listed missing", () => {
    publish({ "gather_chop.clip.json": { duration: 1, bones: { pelvis: { rotate: [{ time: 0, value: 0 }] } } }, "my_dance.clip.json": { duration: 1 } });
    const r = validatePublish({ repoRoot: repo, rig: RIG });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts.documents).toBe(1);
    expect(r.counts.pages).toBeGreaterThan(0);
    expect(r.counts.attachments).toBeGreaterThan(10);
    expect(r.counts.placeholders).toBeGreaterThan(0);
    expect(r.warnings.filter((w) => /placeholder name/.test(w))).toEqual([]);
    expect(r.missingClips).not.toContain("gather_chop");
    expect(r.missingClips).toContain("idle");
    expect(r.warnings.some((w) => /my_dance.*not in the game/.test(w))).toBe(true);
    expect(validatePublish({ repoRoot: repo, rig: RIG, requireClips: true }).ok).toBe(false);
  });

  it("fails a file changed after publishing, a truncated page, a missing region and a placeholder that resolves to nothing", () => {
    publish();
    const doc = JSON.parse(readFileSync(join(dir, `${RIG}.anim.json`), "utf8")) as { slots: { name: string; attachment?: string }[]; skins: Record<string, { attachments: Record<string, Record<string, { path?: string }>> }> };
    const atlas = JSON.parse(readFileSync(join(dir, `${RIG}.atlas.json`), "utf8")) as { pages: { file: string }[] };
    const page = atlas.pages[0]!.file;
    writeFileSync(join(dir, page), readFileSync(join(dir, page)).subarray(0, 200));
    const skin = Object.keys(doc.skins)[0]!;
    const slot = doc.slots.find((s) => s.attachment && doc.skins[skin]!.attachments[s.name]?.[s.attachment]?.path)!;
    doc.skins[skin]!.attachments[slot.name]![slot.attachment!]!.path = "nowhere/image";
    writeFileSync(join(dir, `${RIG}.anim.json`), JSON.stringify(doc));
    const r = validatePublish({ repoRoot: repo, rig: RIG });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(`${RIG}.anim.json: differs from what Publish wrote`))).toBe(true);
    expect(r.errors.some((e) => e.includes(`${page}: not a readable PNG`))).toBe(true);
    expect(r.errors.some((e) => e.includes("'nowhere/image' is not in the atlas"))).toBe(true);
  });

  it("refuses a repo with no publish and a rig that was never published", () => {
    expect(validatePublish({ repoRoot: repo, rig: RIG }).errors[0]).toMatch(/publish-manifest.json is missing/);
    publish();
    expect(validatePublish({ repoRoot: repo, rig: "hero" }).errors[0]).toMatch(/never published/);
  });
});
