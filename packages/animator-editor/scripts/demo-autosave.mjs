// Demo of autosave with crash recovery, the History panel and read-only built-in poses, with screenshots and checks.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-autosave.mjs [outDir] [url]
// It never saves a clip or a rig file: the only files it writes are autosave versions of its own clips (git-ignored folder).
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/autosave"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const BUILTIN = "zz_demo_builtin";
const poseDir = dataDir ? resolve(dataDir, "poses") : resolve(here, "../poses");
const BUILTIN_FILE = resolve(poseDir, `${BUILTIN}.pose.json`);
mkdirSync(poseDir, { recursive: true });
process.on("exit", () => rmSync(BUILTIN_FILE, { force: true }));
const autosaveDir = dataDir ? resolve(dataDir, "autosave") : resolve(here, "../autosave");
for (const name of ["autosave_demo", "autosave_prune"]) rmSync(resolve(autosaveDir, name), { recursive: true, force: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }), { keepRestoreBar: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const boot = async () => {
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
};
const newClip = async (name) => {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(200);
};
const rot = (bone, v, frame = 0) =>
  E(([b, x, f]) => {
    const e = window.atlasEditor;
    e.setTime(f / 30);
    e.select(b);
    e.rotate(b, x);
    e.key();
  }, [bone, v, frame]);
const clipOf = () => E(() => JSON.stringify(window.atlasEditor.state().clip));
/** Polls a page expression (async allowed) until it is truthy. */
const until = async (fn, arg, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${fn}`);
};
const versions = () => E(() => window.atlasEditor.autosaveVersions());

await boot();
await E(() => localStorage.removeItem("atlasEditor.autosaveDismissed"));
check("opens on the turned rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned");

// ---------------------------------------------------------------------------------------------
// 1. Built-in (read-only) poses: none ship; a temporary one is written here to prove the support, then removed
// ---------------------------------------------------------------------------------------------
check("no built-in poses ship with the editor", (await E(() => window.atlasEditor.poses().filter((p) => p.builtin).length)) === 0);
await page.evaluate(() => document.querySelector("#posepanel").scrollIntoView());
await shot("1-pose-library-no-builtins.png");
writeFileSync(BUILTIN_FILE, `${JSON.stringify({ format: "atlas-pose@1", name: BUILTIN, builtin: true, note: "Temporary built-in pose written by the demo", bones: { chest: { rotate: 6, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } } }, attachments: {}, drawOrder: [] }, null, 2)}
`);
await page.reload();
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await E(() => window.atlasEditor.showTab("library")); // the card does not exist yet, so the tab cannot be revealed from the selector
await page.waitForSelector('#posepanel .pcard[data-builtin="1"]');
await page.click('#posepanel .pcard[data-builtin="1"]'); // the action bar (with Delete for user poses) shows for the selected card
const cards = await E(() => [...document.querySelectorAll("#posepanel .pcard")].map((c) => ({ name: c.dataset.pose, builtin: c.dataset.builtin === "1", del: !!document.querySelector("#posedelete") })));
check("a built-in pose shows with the badge and no Delete", cards.length === 1 && cards[0].builtin && !cards[0].del, cards);
const del = await E((n) => fetch(`/api/poses/${n}`, { method: "DELETE" }).then((r) => r.status), BUILTIN);
const over = await E((n) => fetch(`/api/poses/${n}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pose: { format: "atlas-pose@1", name: n, bones: {}, attachments: {}, drawOrder: [] } }) }).then((r) => r.status), BUILTIN);
check("the server refuses to delete or overwrite a built-in", del === 403 && over === 403, { del, over });

await newClip("autosave_pose");
const r = await E((n) => window.atlasEditor.applyPose(n, { frame: 8 }), BUILTIN);
check("applying the built-in pose keys its bones", r && r.bones >= 1 && r.skipped.length === 0, r);
unlinkSync(BUILTIN_FILE);
await E(() => window.atlasEditor.setTime(8 / 30));
await page.waitForTimeout(400);
await shot("2-applied-pose.png");

// ---------------------------------------------------------------------------------------------
// 2. Autosave: interval, switch, non-blocking, keep 30
// ---------------------------------------------------------------------------------------------
await newClip("autosave_demo");
await E(() => window.atlasEditor.setAutosaveInterval(500));
await rot("chest", 6);
await until(async () => (await window.atlasEditor.autosaveVersions()).length >= 1);
check("the interval timer autosaved the unsaved clip", (await versions()).length === 1, (await versions()).map((v) => v.flags));
await E(() => window.atlasEditor.setAutosaveInterval(60_000));
const v1 = clipOf();
const clipAtV1 = await v1;
await rot("upper_arm_near", 40);
await E(() => window.atlasEditor.switchClip("autosave_pose")); // a clip switch autosaves the clip it leaves
await until(async () => (await window.atlasEditor.autosaveVersions("autosave_demo")).length >= 2);
check("switching clips autosaved the outgoing clip", (await E(() => window.atlasEditor.autosaveVersions("autosave_demo"))).length === 2);
await E(() => window.atlasEditor.switchClip("autosave_demo"));

// Saving never blocks: a burst of edits and autosaves, watching the frame gaps on the page.
const gap = await E(async () => {
  const e = window.atlasEditor;
  let worst = 0;
  let last = performance.now();
  let run = true;
  const loop = () => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    if (run) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const pending = [];
  for (let i = 0; i < 12; i++) {
    e.setTime((i % 10) / 30);
    e.select("chest");
    e.rotate("chest", i);
    e.key();
    pending.push(e.autosaveNow("manual"));
    await new Promise((r) => setTimeout(r, 30));
  }
  const started = performance.now();
  await Promise.all(pending);
  run = false;
  return { worst: Math.round(worst), drain: Math.round(performance.now() - started) };
});
check("autosaving does not stall the page (worst frame gap under 250 ms)", gap.worst < 250, gap);

// Keep the newest 30 per clip.
await E(async () => {
  for (let i = 0; i < 34; i++) {
    await fetch("/api/autosave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "atlas-autosave@1", clip: "autosave_prune", outfit: "pro-turned", reason: "manual", savedAt: "", clipData: { duration: 1 + i / 100, loop: false, bones: {} } }) });
  }
});
check("only the newest 30 versions of a clip stay", (await E(() => window.atlasEditor.autosaveVersions("autosave_prune"))).length === 30);
check("the folder holds that clip's 30 files and no temp files", readdirSync(resolve(autosaveDir, "autosave_prune")).length === 30);

// ---------------------------------------------------------------------------------------------
// 3. History panel: browse, preview, restore
// ---------------------------------------------------------------------------------------------
await E(() => window.atlasEditor.autosaveNow("manual"));
await E(() => window.atlasEditor.historyRefresh());
const list = await versions();
const oldest = list.at(-1);
const workingBefore = await clipOf();
await page.evaluate(() => document.querySelector("#historypanel").scrollIntoView());
await shot("3-history-panel.png");
check("the History panel lists the clip's versions with timestamps", (await E(() => document.querySelectorAll("#historypanel .version").length)) === list.length && list.length >= 3, list.length);
await page.click(`#historypanel .version[data-version="${oldest.id}"] button:text-is("Preview")`);
await page.waitForFunction(() => !!window.atlasEditor.previewing());
const previewed = await clipOf();
check("preview shows the old version, not the working clip", previewed === clipAtV1 && previewed !== workingBefore);
await shot("4-history-preview.png");
await rot("chest", 30);
check("editing is paused while previewing", (await clipOf()) === previewed);
await page.click("#exitpreview");
check("exit preview returns to the working clip", (await clipOf()) === workingBefore);
await page.click(`#historypanel .version[data-version="${oldest.id}"] button:text-is("Restore")`);
await until((c) => JSON.stringify(window.atlasEditor.state().clip) === c, clipAtV1);
check("restore makes the old version the working clip", (await clipOf()) === clipAtV1);
await E(() => document.getElementById("undo").click());
check("restore is one undo step", (await clipOf()) === workingBefore);
check("the state before the restore was autosaved first", (await versions()).length > list.length - 1);

// ---------------------------------------------------------------------------------------------
// 4. Crash recovery: unsaved clip + skin + setup edits, a reload without saving, the Restore bar
// ---------------------------------------------------------------------------------------------
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await rot("upper_arm_far", -25, 4);
await E(() => window.atlasEditor.createSkin("autosave-skin"));
await page.waitForTimeout(800);
await E(() => window.atlasEditor.setupAddBone({ parent: "root", from: [0, 0], to: [40, 0], name: "autosave_bone" }));
await page.waitForTimeout(800);
const unsavedClip = await clipOf();
await E(() => window.atlasEditor.autosaveNow("manual"));
const top = (await versions())[0];
check("the newest version carries the clip, the skin edits and the Setup edits", top.flags === "csu", top);
await shot("5-before-crash.png");

await page.reload(); // the "crash": nothing was saved
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForSelector("#restorebar:not([hidden])", { timeout: 20_000 });
check("after the restart the Restore bar offers the autosave", (await E(() => document.getElementById("restoretext").textContent)).includes("autosave_demo"));
check("the clip is not there yet", !(await E(() => window.atlasEditor.state().clipName === "autosave_demo")));
await shot("6-restore-offer.png");
await page.click("#restorebtn");
await until(() => document.getElementById("restorebar").hidden, null, 30_000); // hidden once every offered clip is restored
await until(() => window.atlasEditor.skins().names.includes("autosave-skin"));
await until(() => window.atlasEditor.setupRaw()?.bones.some((b) => b.name === "autosave_bone"));
await E(() => window.atlasEditor.switchClip("autosave_demo"));
check("Restore brought back the clip exactly", (await clipOf()) === unsavedClip);
check("Restore brought back the skin and the Setup bone", true);
check("the offer is remembered as handled", await E(() => !!localStorage.getItem("atlasEditor.autosaveDismissed")));
await shot("7-restored.png");

// The restored work is still unsaved, so it is autosaved again and offered again after the next restart; Dismiss ends it.
await E(() => window.atlasEditor.autosaveNow("manual"));
await page.reload();
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForSelector("#restorebar:not([hidden])", { timeout: 20_000 });
check("work that is still unsaved is offered again at the next start", true);
await page.click("#restoredismiss");
await page.reload();
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(2500);
check("a dismissed offer does not come back", await E(() => document.getElementById("restorebar").hidden));

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
