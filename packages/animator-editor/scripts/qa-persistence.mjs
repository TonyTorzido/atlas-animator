// Atlas Animator persistence QA: the save path cannot crash the server, cannot silently lose a clip, and can roll back.
//
//   node scripts/qa-persistence.mjs [--headed]
//
// Starts its own sandboxed server (scripts/demo-server.mjs: ATLAS_EDITOR_DATA_DIR in a temp folder, a free port, never :5211) and
// checks, with Playwright driving the real editor:
//   1. a write error (the saved clip file made read-only) answers an error, shows a "Save failed" toast, and the server stays up;
//   2. an uncaught promise rejection shows an error toast with "Copy details";
//   3. two tabs on one clip: the second save gets the "changed in another tab/window" dialog; "Save mine as a copy" and
//      "Overwrite with mine" both do what they say;
//   4. every overwrite leaves a snapshot; the clip menu's "Versions..." lists them and Restore puts one back (snapshotting first);
//   5. the leave-page guard fires while a clip is dirty and stays quiet when everything is saved.
// Prints PASS / FAIL per check and exits non-zero on any FAIL.
import { createRequire } from "node:module";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

/** The file wrapper's version field is not part of the in-memory clip. */
const withoutClipVersion = (clip) => { if (clip && typeof clip === "object") { const { clipVersion: _v, ...rest } = clip; return rest; } return clip; };
const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const { url, dataDir } = await demoServer();
if (!dataDir) throw new Error("qa-persistence needs a sandboxed server");
const clipsDir = resolve(dataDir, "clips");
const historyOf = (file) => resolve(dataDir, "history", "clips", file);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail !== undefined ? `  -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed++;
};
const api = async (path, init) => {
  const r = await fetch(new URL(path, url), init);
  return { status: r.status, body: await r.text() };
};

const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

async function tab() {
  const page = await context.newPage();
  const E = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${url}?ws=pro`);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);
  // Close the first-run guide / restore bar if they show.
  await E(() => window.atlasEditor.hideGuide?.());
  const t = {
    page,
    E,
    newClip: async (name) => {
      await page.click("#newclip-open");
      await page.fill("#newclip-name", name);
      await page.click("#newclip-make");
      await page.waitForFunction((n) => window.atlasEditor.state().clipName === n, name);
    },
    rot: (bone, v) =>
      E(([b, x]) => {
        const e = window.atlasEditor;
        e.setTime(0);
        e.select(b);
        e.rotate(b, x);
        e.key();
      }, [bone, v]),
    save: () => E(() => document.getElementById("save").click()),
    open: async (name) => {
      await E(async (n) => {
        await window.atlasEditor.refreshSaved();
        const sel = document.getElementById("clip");
        sel.value = `saved:${n}.clip.json`;
        sel.dispatchEvent(new Event("change"));
      }, name);
      await page.waitForFunction((n) => window.atlasEditor.state().clipName === n, name);
    },
    dirty: () => E(() => window.atlasEditor.hasUnsavedWork()),
    toast: (re) => page.waitForFunction((s) => [...document.querySelectorAll(".pu-toast.bad")].some((t) => new RegExp(s).test(t.textContent ?? "")), re.source, { timeout: 15_000 }).then(() => true, () => false)
  };
  return t;
}
const savedText = (name) => (existsSync(resolve(clipsDir, `${name}.clip.json`)) ? readFileSync(resolve(clipsDir, `${name}.clip.json`), "utf8") : null);
const waitFor = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const a = await tab();

// ---- 1. A write error keeps the server up and says so -----------------------------------------------------------
await a.newClip("qa_ro");
await a.rot("chest", 5);
await a.save();
check("first save of qa_ro writes the file", await waitFor(() => savedText("qa_ro") !== null));
const roFile = resolve(clipsDir, "qa_ro.clip.json");
chmodSync(roFile, 0o444);
let roWorks = false;
try {
  // POSIX rename may replace a read-only file; Windows refuses (EPERM). Only then is this a write error.
  roWorks = process.platform === "win32";
  await a.rot("chest", 12);
  await a.save();
  if (roWorks) {
    check("read-only clip: 'Save failed' error toast", await a.toast(/Save failed.*NOT saved/));
    check("read-only clip: the clip stays dirty", await a.dirty());
  } else console.log("SKIP read-only write error (POSIX allows the rename); the unit tests inject the fs error instead");
  const up = await api("api/clips");
  check("server still up after the failed write (GET /api/clips 200)", up.status === 200, up);
} finally {
  chmodSync(roFile, 0o644);
}
// A folder in the way fails on every OS: the old crash repro (EISDIR).
const bad = await api("api/clips/qa_dir.clip.json", { method: "POST", body: "{}" });
check("bad clip body answers 400 JSON", bad.status === 400 && /error/.test(bad.body), bad);
const { mkdirSync } = await import("node:fs");
mkdirSync(resolve(clipsDir, "qa_dir.clip.json"), { recursive: true });
const eisdir = await api("api/clips/qa_dir.clip.json", { method: "POST", body: JSON.stringify({ duration: 1 }) });
check("folder in the way answers a JSON error, not a crash", eisdir.status >= 500 && /folder is in the way/.test(eisdir.body), eisdir);
check("server still up after EISDIR", (await api("api/clips")).status === 200);
const big = await api("api/board", { method: "POST", body: "x".repeat(5 * 1024 * 1024) });
check("oversized body answers 413", big.status === 413, big.status);
await a.save(); // the file is writable again: the dirty clip saves
check("after the error, saving again works", await waitFor(async () => !(await a.dirty())));

// ---- 2. Global error toast ----------------------------------------------------------------------------------------
await a.E(() => {
  void Promise.reject(new Error("qa unhandled boom"));
});
check("unhandled rejection shows an error toast", await a.toast(/qa unhandled boom/));
check("error toast has Copy details", await a.E(() => [...document.querySelectorAll(".pu-toast.bad")].some((t) => !!t.querySelector('[data-act="copy"]'))));
await a.E(() => document.querySelectorAll(".pu-toast").forEach((t) => t.remove()));

// ---- 3. Two tabs on one clip --------------------------------------------------------------------------------------
await a.newClip("qa_conf");
await a.rot("chest", 3);
await a.save();
await waitFor(() => savedText("qa_conf") !== null);
const b = await tab();
await b.open("qa_conf");
await a.rot("chest", 20);
await a.save();
await waitFor(async () => !(await a.dirty()));
const theirs = savedText("qa_conf");
await b.rot("upper_arm_near", 33);
await b.save();
const dialogShown = await b.page.waitForSelector("#pu-conflict", { timeout: 15_000 }).then(() => true, () => false);
check("second tab's save opens the conflict dialog", dialogShown);
check("dialog says 'This clip changed in another tab/window'", dialogShown && /This clip changed in another tab\/window/.test(await b.page.textContent("#pu-conflict")));
check("dialog offers Reload theirs / Overwrite with mine / Save mine as a copy", dialogShown && (await b.E(() => ["reload", "overwrite", "copy"].every((a) => !!document.querySelector(`#pu-conflict [data-act="${a}"]`)))));
check("nothing was overwritten while the dialog is open", savedText("qa_conf") === theirs);
if (dialogShown) await b.page.click('#pu-conflict [data-act="copy"]');
check("'Save mine as a copy' writes qa_conf_copy", await waitFor(() => savedText("qa_conf_copy") !== null));
check("the original keeps the other tab's version", savedText("qa_conf") === theirs);
// Overwrite: A saves again, B edits qa_conf (reloaded from disk after the copy) and saves over a newer file.
await a.rot("chest", -10);
await a.save();
await waitFor(async () => !(await a.dirty()));
await b.open("qa_conf");
await a.rot("chest", -14);
await a.save();
await waitFor(async () => !(await a.dirty()));
await b.rot("upper_arm_near", -21);
const mine = await b.E(() => JSON.stringify(window.atlasEditor.state().clip));
await b.save();
const second = await b.page.waitForSelector("#pu-conflict", { timeout: 15_000 }).then(() => true, () => false);
check("a stale save is refused again", second);
if (second) await b.page.click('#pu-conflict [data-act="overwrite"]');
check("'Overwrite with mine' writes this tab's clip", await waitFor(async () => !(await b.dirty()) && JSON.stringify(withoutClipVersion(JSON.parse(savedText("qa_conf") ?? "null"))) === JSON.stringify(JSON.parse(mine))), { mine: mine.slice(0, 120), disk: (savedText("qa_conf") ?? "").slice(0, 120) });

// ---- 4. Snapshots and Versions... ---------------------------------------------------------------------------------
const listed = JSON.parse((await api("api/history?kind=clip&file=qa_conf.clip.json")).body).versions ?? [];
const onDisk = existsSync(historyOf("qa_conf.clip.json")) ? readdirSync(historyOf("qa_conf.clip.json")) : [];
check("overwrites left snapshots in clips/.history", listed.length >= 2 && onDisk.length === listed.length, { listed: listed.length, onDisk: onDisk.length });
const before = savedText("qa_conf");
const oldest = listed[listed.length - 1];
const oldestText = readFileSync(resolve(historyOf("qa_conf.clip.json"), oldest.id), "utf8");
// The Clip board menu item.
await a.E(() => window.atlasEditor.refreshSaved());
if (await a.E(() => document.getElementById("clipboard")?.hidden !== false)) await a.page.click("#clips-open");
await a.page.waitForSelector("#clipboard:not([hidden])", { timeout: 15_000 });
await a.page.waitForTimeout(500);
let viaMenu = false;
try {
  await a.page.hover(`#clipboard .cb-row:has([data-clip="qa_conf"])`, { timeout: 5000 });
  await a.page.click(`#clipboard [data-more="qa_conf"]`, { timeout: 5000 });
  await a.page.click('#clipboard .cb-menu-item[data-act="versions"]', { timeout: 5000 });
  viaMenu = true;
} catch {
  await a.E(() => window.atlasEditor.clipVersions("qa_conf"));
}
check("clip menu has Versions...", viaMenu);
await a.page.waitForSelector("#pu-versions .pu-item[data-id]", { timeout: 15_000 });
const rows = await a.E(() => document.querySelectorAll("#pu-versions .pu-item[data-id]").length);
check("Versions dialog lists the snapshots", rows === listed.length, { rows, listed: listed.length });
await a.page.click(`#pu-versions .pu-item[data-id="${oldest.id}"] [data-act="restore"]`);
await a.page.click('#pu-confirm [data-act="confirm"]');
check("Restore puts the old version back", await waitFor(() => savedText("qa_conf") === oldestText));
const after = JSON.parse((await api("api/history?kind=clip&file=qa_conf.clip.json")).body).versions;
check("the restore snapshotted the replaced file first", after.some((v) => readFileSync(resolve(historyOf("qa_conf.clip.json"), v.id), "utf8") === before));
check("a restored clip is not dirty and has the restored base (save works without a conflict)", await (async () => {
  await a.open("qa_conf");
  await a.rot("chest", 2);
  await a.save();
  return waitFor(async () => !(await a.dirty()));
})());
check("Rig workspace has a Versions... button", await a.E(() => !!document.getElementById("rig-versions")));
// Rig writes snapshot too: re-save a rig's own skins through /api/skins, then list and restore.
const rigDoc = "packages/animator/rigs/kit-tanktop-front0/kit-tanktop-front0.anim.json"; // small; the sandbox has its own copy
{
  const doc = JSON.parse((await api(`repo/${rigDoc}`)).body);
  const w = await api("api/skins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rigDoc, skins: doc.skins ?? {}, setup: {} }) });
  const rv = JSON.parse((await api(`api/history?kind=rig&file=${encodeURIComponent(rigDoc)}`)).body).versions ?? [];
  check("a rig write (Skins) leaves a rig snapshot", w.status === 200 && rv.length >= 1, { w, rv: rv.length });
  const rr = rv.length ? await api("api/history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "rig", file: rigDoc, id: rv[0].id }) }) : { status: 0, body: "" };
  check("rig restore answers the new rig hash", rr.status === 200 && /"hash"/.test(rr.body), rr);
}
const rigHist = await api(`api/history?kind=rig&file=${encodeURIComponent("packages/animator/rigs/../../../x.anim.json")}`);
check("rig history refuses paths outside the rigs folder", rigHist.status === 400, rigHist);

// ---- 4b. Batch 0 data safety ---------------------------
await a.E(() => document.querySelectorAll(".pu-layer").forEach((l) => l.remove()));
await a.E(() => window.atlasEditor.workspace("pro"));
await a.page.waitForTimeout(300);
// The workspace switch can open the clip board (it hides New clip): Esc closes it.
for (let i = 0; i < 3 && (await a.E(() => document.body.classList.contains("cb-open"))); i++) {
  await a.page.keyboard.press("Escape");
  await a.page.waitForTimeout(150);
}
await a.newClip("qa_b0");
await a.rot("chest", 4);
await a.save();
await waitFor(async () => !(await a.dirty()));
// AN-03: an edit made while a save is in flight stays dirty (the save is held at the network layer until the edit lands).
{
  let release;
  const held = new Promise((r) => (release = r));
  await a.page.route("**/api/clips/qa_b0.clip.json", async (route) => {
    await held;
    await route.continue();
  });
  const saving = a.E(() => window.atlasEditor.saveOutcome());
  await a.page.waitForTimeout(300);
  await a.rot("head", 7);
  release();
  const out = await saving;
  await a.page.unroute("**/api/clips/qa_b0.clip.json");
  check("AN-03: the in-flight save answers ok for the revision it wrote", out.ok === true, out);
  check("AN-03: the edit made during the save is still dirty", await a.dirty());
  check("AN-03: the file holds the older revision (no head key)", !JSON.parse(savedText("qa_b0") ?? "{}").bones?.head, savedText("qa_b0")?.slice(0, 200));
  await a.save();
  check("AN-03: the next save writes the later edit and clears dirty", await waitFor(async () => !(await a.dirty()) && !!JSON.parse(savedText("qa_b0") ?? "{}").bones?.head));
}
// AN-04: a failed save answers not-ok, keeps the clip dirty and Mark done does not proceed on it.
{
  await a.rot("chest", 11);
  await a.page.route("**/api/clips/qa_b0.clip.json", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "qa injected write failure" }) }));
  const out = await a.E(() => window.atlasEditor.saveOutcome());
  await a.page.unroute("**/api/clips/qa_b0.clip.json");
  check("AN-04: a failed write answers ok:false with the server's error", out.ok === false && /qa injected/.test(out.error ?? ""), out);
  check("AN-04: the clip stays dirty after a failed save", await a.dirty());
  await a.E(() => document.querySelectorAll(".pu-toast").forEach((t) => t.remove()));
  await a.save();
  await waitFor(async () => !(await a.dirty()));
}
// AN-01: K keys scale (and shear) with Auto key off, not just rotate / move.
{
  await a.E(() => {
    const e = window.atlasEditor;
    e.setAutoKey(false);
    e.setTime(0);
    e.select("chest");
    e.scale("chest", 1.25);
    e.shear("chest", 6, 0);
    e.key();
  });
  const st = await a.E(() => window.atlasEditor.state());
  check("AN-01: K keyed chest scale", !!st.clip.bones?.chest?.scale?.length, st.clip.bones?.chest);
  check("AN-01: K keyed chest shear", !!st.clip.bones?.chest?.shear?.length, st.clip.bones?.chest);
  check("AN-01: nothing left unkeyed after K", !Object.keys(st.pendingScale).length && !Object.keys(st.pendingShear).length, st);
}
// AN-02: scrub / play / clip switch park an unkeyed pose per frame and bring it back; it counts as unsaved and is autosaved.
{
  await a.save();
  await waitFor(async () => !(await a.dirty()));
  await a.E(() => {
    const e = window.atlasEditor;
    e.setTime(0.2);
    e.select("head");
    e.rotate("head", 21);
    e.setTime(0.5);
  });
  const parked = await a.E(() => ({ st: window.atlasEditor.state(), drafts: window.atlasEditor.drafts() }));
  check("AN-02: scrubbing away parks the unkeyed head (not dropped)", !("head" in parked.st.pending) && parked.drafts.some((d) => d.clip === "qa_b0" && d.bones.includes("head")), parked.drafts);
  check("AN-02: a parked pose counts as unsaved work (leave-page guard)", await a.dirty());
  await a.E(() => window.atlasEditor.setTime(0.2));
  check("AN-02: back on its frame the unkeyed head returns", await a.E(() => Math.abs((window.atlasEditor.state().pending.head ?? 0) - 21) < 0.01));
  await a.E(() => document.getElementById("play").click());
  await a.page.waitForTimeout(300);
  await a.E(() => document.getElementById("play").click());
  check("AN-02: Play parks it instead of dropping it", await a.E(() => window.atlasEditor.drafts().some((d) => d.bones.includes("head")) || "head" in window.atlasEditor.state().pending));
  await a.E(() => window.atlasEditor.setTime(0.2));
  await a.newClip("qa_b0_other");
  await a.save();
  await a.open("qa_b0");
  await a.E(() => window.atlasEditor.setTime(0.2));
  check("AN-02: a clip switch and back keeps the draft", await a.E(() => "head" in window.atlasEditor.state().pending));
  await a.E(() => window.atlasEditor.autosaveNow("qa"));
  const versions = await waitFor(() => {
    const dir = resolve(dataDir, "autosave", "qa_b0");
    return existsSync(dir) && readdirSync(dir).some((f) => /"drafts"/.test(readFileSync(resolve(dir, f), "utf8")));
  });
  check("AN-02: the autosave carries the unkeyed pose (drafts)", versions);
  check("AN-02: Discard (strip) is visible for an unkeyed edit", await a.E(() => { const b = document.getElementById("xs-discard"); return !!b && !!b.title; }));
  await a.E(() => window.atlasEditor.discardUnkeyed());
  check("AN-02: Discard unkeyed is the explicit drop", await a.E(() => !("head" in window.atlasEditor.state().pending)));
  await a.E(() => window.atlasEditor.setAutoKey(true));
}
// RI-01 / RI-02 / PR-03: preserving the session writes every unsaved context, the rig edits under a setup session.
{
  await a.rot("chest", 13);
  await a.E(() => window.atlasEditor.createSkin("qa_b0_skin"));
  const kept = await a.E(() => window.atlasEditor.preserveSession("qa"));
  const outfit = await a.E(() => window.atlasEditor.state().outfit);
  check("RI-02: preserveSession writes every unsaved clip and the rig edits", kept.ok && kept.kept.includes("qa_b0") && kept.kept.includes("Setup / skin edits"), kept);
  check("RI-01: the rig edits land under the setup session (no clip needed)", existsSync(resolve(dataDir, "autosave", `_setup.${outfit}`)), outfit);
  // RI-05: the skin edit is a named undo step.
  await a.E(() => window.atlasEditor.undoStep());
  check("RI-05: Undo removes the created skin", await waitFor(() => a.E(() => !window.atlasEditor.skins().names.includes("qa_b0_skin"))));
  await a.E(() => window.atlasEditor.redoStep());
  check("RI-05: Redo brings it back", await waitFor(() => a.E(() => window.atlasEditor.skins().names.includes("qa_b0_skin"))));
  // RI-04: the skins save is a compare-and-swap on the rig hash.
  const doc = await a.E(() => window.atlasEditor.rigDocument());
  const stale = await api("api/skins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: doc, skins: {}, setup: {}, base: "0000000000000000" }) });
  check("RI-04: a skins save on a stale base answers 409 and writes nothing", stale.status === 409 && /changed on disk/.test(stale.body), stale);
  await a.save();
  check("RI-04: the tab's own skins save (current base) succeeds and clears skins dirty", await waitFor(async () => !(await a.E(() => window.atlasEditor.skinsDirty())) && !(await a.dirty())));
  // SH-02: the Spine export is bound to the rig revision the tab read.
  const ex = await api("api/rig/export-spine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: doc, base: "0000000000000000" }) });
  check("SH-02: an export against a stale rig revision answers 409", ex.status === 409, ex.status);
}
// PR-01: the mix preview shows a banner with a way back, and editing the clip closes it.
{
  await a.E(() => window.atlasEditor.tracksOpen(true));
  await a.page.waitForTimeout(250);
  check("PR-01: mix preview shows the banner with Back to the clip", await a.E(() => { const b = document.getElementById("mixbanner"); const x = document.getElementById("mixbanner-exit"); return !!b && !b.hidden && !!x && !!x.title; }));
  await a.rot("chest", 3);
  await a.page.waitForTimeout(250);
  check("PR-01: editing the clip closes the mix preview and hides the banner", await a.E(() => !window.atlasEditor.mixActive() && document.getElementById("mixbanner")?.hidden === true));
  await a.save();
  await waitFor(async () => !(await a.dirty()));
}

// ---- 4b. Clips belong to a rig: switching rigs keeps each rig's clips, and autosave + reload brings both back ---------------------
{
  const c = await tab();
  const names = () => c.E(() => window.atlasEditor.clipSession().map((x) => x.name));
  const keyed = (clipName) => c.E((n) => (window.atlasEditor.state().clipName === n ? Object.keys(window.atlasEditor.state().clip.bones).includes("chest") : false), clipName);
  const start = await c.E(() => window.atlasEditor.state().outfit);
  check("RS-01: a fresh editor is on Player v2", start === "player-v2", start);
  await c.newClip("qa_rs_v2");
  await c.rot("chest", 11);
  await c.E(() => window.atlasEditor.mountOutfit("pro-turned"));
  await c.page.waitForTimeout(1500);
  const kitNames = await names();
  check("RS-02: Side (pro) shows its own clips, none of Player v2's", !kitNames.includes("qa_rs_v2") && !kitNames.includes("t_walk_contact"), kitNames);
  await c.newClip("qa_rs_kit");
  await c.rot("chest", 7);
  await c.E(() => window.atlasEditor.mountOutfit("player-v2"));
  await c.page.waitForTimeout(1500);
  const v2Names = await names();
  check("RS-03: switching back, Player v2's clips (and its unsaved clip) are intact", v2Names.includes("qa_rs_v2") && v2Names.includes("t_walk_contact") && !v2Names.includes("qa_rs_kit"), v2Names);
  check("RS-03: the unsaved clip is still dirty", await c.E(() => window.atlasEditor.clipSession().find((x) => x.name === "qa_rs_v2")?.dirty === true));
  // Switching autosaved each rig's unsaved clip under that rig.
  const body = (n) => (existsSync(resolve(dataDir, "autosave", n)) ? readdirSync(resolve(dataDir, "autosave", n)).map((f) => readFileSync(resolve(dataDir, "autosave", n, f), "utf8")).join(" ") : "");
  check("RS-04: the rig switch autosaved both clips under their own rigs", /"outfit":\s*"player-v2"/.test(body("qa_rs_v2")) && /"outfit":\s*"pro-turned"/.test(body("qa_rs_kit")));
  await c.page.reload({ timeout: 15_000 }).catch(() => {});
  await c.page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 90_000 });
  await c.page.waitForTimeout(1500);
  const latest = async (n) => {
    const all = JSON.parse((await api("api/autosave")).body).clips[n] ?? [];
    return all.map((v) => v.id).sort().at(-1);
  };
  const restore = async (n) => c.E(async ([name, id]) => window.atlasEditor.restoreVersion(name, id, true), [n, await latest(n)]);
  await restore("qa_rs_v2");
  await restore("qa_rs_kit");
  await c.page.waitForTimeout(1500);
  check("RS-05: after the reload the kit clip came back on Side (pro)", (await c.E(() => window.atlasEditor.state().outfit)) === "pro-turned" && (await names()).includes("qa_rs_kit") && !(await names()).includes("qa_rs_v2"), await names());
  await c.E(() => window.atlasEditor.mountOutfit("player-v2"));
  await c.page.waitForTimeout(1500);
  check("RS-05: and Player v2 still has its own restored clip, not the kit's", (await names()).includes("qa_rs_v2") && !(await names()).includes("qa_rs_kit"), await names());
  await c.E(() => window.atlasEditor.switchClip("qa_rs_v2"));
  check("RS-05: the restored v2 clip keeps its key", await keyed("qa_rs_v2"));
  await c.page.close();
}

// ---- 5. Leave-page guard --------------------------------------------------------------------------------------------
await a.E(() => document.querySelectorAll(".pu-layer").forEach((l) => l.remove()));
const dialogs = [];
a.page.on("dialog", (d) => {
  dialogs.push(d.type());
  void d.dismiss();
});
await a.E(() => (window.__atlasForceUnloadGuard = true));
check("nothing unsaved after the last save", !(await a.dirty()));
await a.page.click("#clipinfo").catch(() => a.page.mouse.click(5, 5)); // user activation (browsers only prompt after an interaction)
await a.page.reload({ timeout: 15_000 }).catch(() => {});
check("clean page reloads with no leave-page prompt", !dialogs.includes("beforeunload"), dialogs);
await a.page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 90_000 });
await a.page.waitForTimeout(1000);
await a.E(() => (window.__atlasForceUnloadGuard = true));
await a.newClip("qa_unload");
await a.rot("chest", 9);
check("a new keyed clip counts as unsaved", await a.dirty());
await a.page.reload({ timeout: 5000 }).catch(() => {});
check("dirty page: the browser's leave-page prompt fires", dialogs.includes("beforeunload"), dialogs);
const synthetic = await a.E(() => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
check("dirty page: beforeunload handler cancels the unload", synthetic);

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall persistence checks passed");
process.exit(failed ? 1 : 0);
