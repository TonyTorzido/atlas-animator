// Demo of the three reference features, each with screenshots and checks:
//   1. the reference video / image sequence underlay (refUnderlay.ts): frame-accurate sync, offset + speed, trace mode, handles, per-clip metadata;
//   2. the server-tick hit lock (hitLock.ts): 20 Hz tick marks, the late-hit badge and chip, snapping, the over-long clip warning;
//   3. the pose library with thumbnails (poseLibrary.ts): save, tags, search, apply (double-click, drag), mirrored, partial, selected bones.
// Needs ffmpeg on PATH (it makes the test video and frames). Starts its own sandboxed dev server (scripts/demo-server.mjs; :5211 is refused).
// Screenshots go to docs/plans/atlas-animator-demos/editor/refs/.
//   node packages/animator-editor/scripts/demo-refs.mjs [outDir] [url]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = resolve(args[0] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/refs"));
const { url } = await demoServer(args[1]);
mkdirSync(out, { recursive: true });

// ---- test media: a counter that shows its own frame number, and a box that travels ----
const media = mkdtempSync(resolve(tmpdir(), "atlas-refs-media-"));
const font = "C\\:/Windows/Fonts/arial.ttf";
const filter = `drawtext=fontfile='${font}':text='  ':x='40+n*6':y=300:fontsize=60:box=1:boxcolor=0xf0b84a@0.9:boxborderw=70,drawbox=x=0:y=640:w=480:h=6:color=white@0.8:t=fill,drawtext=fontfile='${font}':text='%{n}':x=24:y=24:fontsize=84:fontcolor=white:box=1:boxcolor=black@0.6`;
const ff = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const src = ["-f", "lavfi", "-i", "color=c=0x2d4466:s=480x720:r=30:d=2.0"];
ff(...src, "-vf", filter, "-c:v", "libvpx", "-b:v", "2M", "-g", "1", "-pix_fmt", "yuv420p", resolve(media, "swing.webm"));
mkdirSync(resolve(media, "frames"));
ff(...src, "-vf", filter, resolve(media, "frames", "f%03d.png"));
const WEBM = resolve(media, "swing.webm");
const FRAMES = resolve(media, "frames");
console.log(`media: ${media} (${readdirSync(FRAMES).length} frames)`);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 900 } }), { workspace: "animate" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor && !!window.atlasRefs && !!window.atlasHitLock && !!window.atlasPoseLib, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.evaluate(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForFunction(() => window.atlasEditor.state().outfit === "pro-turned", null, { timeout: 30_000 });
await page.waitForTimeout(600);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name, clip) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};
const frame = (f) => E((x) => window.atlasEditor.setTime(x / 30), f);
const tab = (id) => E((t) => document.querySelector(`#tabs [data-tab=${t}]`)?.click(), id);
const newClip = async (name) => {
  await E(() => window.atlasEditor.workspace("pro"));
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(250);
  await E(() => window.atlasEditor.workspace("animate"));
  await page.waitForTimeout(200);
};
const refSettled = () => E(() => window.atlasRefs.settled());
const refInfo = () => E(() => window.atlasRefs.info());

// =====================================================================================================
// 1. Reference video underlay
// =====================================================================================================
console.log("--- 1. reference video");
await newClip("refs_demo");
await tab("preview");
// The reference video section starts folded; unfold it for the controls below.
await E(() => document.getElementById("refpanel")?.classList.remove("collapsed"));
await E((p) => window.atlasRefs.load(p, "video"), WEBM);
await refSettled();
let info = await refInfo();
check("the video loads and knows its length", info.loaded && info.kind === "video" && info.count >= 55, info);
await E(() => window.atlasRefs.set({ opacity: 0.55, scale: 0.9 }));
await frame(0);
await refSettled();
await shot("1a-video-frame-0.png");
let exact = true;
for (const f of [0, 7, 15, 22, 29, 3]) {
  await frame(f);
  await refSettled();
  info = await refInfo();
  exact &&= info.frame === f && info.wanted === f;
}
check("scrubbing the timeline lands on the exact source frame (0, 7, 15, 22, 29, 3)", exact, info);
await frame(22);
await refSettled();
await shot("1b-video-frame-22.png");

await E(() => window.atlasRefs.set({ offsetFrames: 10, speed: 0.5 }));
await frame(20);
await refSettled();
info = await refInfo();
check("offset 10 frames + half speed: clip frame 20 shows source frame 5", info.frame === 5, info.frame);
await frame(4);
await refSettled();
check("before the offset the first source frame holds", (await refInfo()).frame === 0);
await E(() => window.atlasRefs.set({ offsetFrames: 0, speed: 1 }));

await E(() => window.atlasRefs.set({ trace: true }));
await frame(15);
await refSettled();
const alpha = await E(async () => (await import("/src/host.ts")).getHost().character.alpha);
check("trace mode: reference at full opacity, rig at 50%", alpha === 0.5 && (await refInfo()).meta.trace === true && (await E(() => window.atlasEditor.underlayInfo())).opacity === 1, alpha);
await shot("1c-trace-mode.png");
await E(() => window.atlasRefs.set({ trace: false }));

await page.click("#refadjust");
await page.waitForTimeout(300);
const boxBefore = await page.locator("#refbox").boundingBox();
check("handles box appears on the canvas", !!boxBefore && boxBefore.width > 40, boxBefore);
await shot("1d-handles.png");
const scaleBefore = (await refInfo()).meta.transform.scale;
const se = await page.locator("#refbox .corner.se").boundingBox();
await page.mouse.move(se.x + 7, se.y + 7);
await page.mouse.down();
await page.mouse.move(se.x + 80, se.y + 80, { steps: 6 });
await page.mouse.up();
const scaleAfter = (await refInfo()).meta.transform.scale;
check("dragging a corner scales the reference", scaleAfter > scaleBefore * 1.05, { scaleBefore, scaleAfter });
const edge = await page.locator("#refbox .edge.w").boundingBox();
console.log("edge owner", await E((b) => { const e = document.elementFromPoint(b.x + 6, b.y + b.height / 2); return e ? e.id + "." + e.className : null; }, edge));
const xBefore = (await refInfo()).meta.transform.x;
await page.mouse.move(edge.x + 6, edge.y + edge.height / 2);
await page.mouse.down();
await page.mouse.move(edge.x - 70, edge.y + edge.height / 2, { steps: 6 });
await page.mouse.up();
const xAfter = (await refInfo()).meta.transform.x;
check("dragging an edge moves it", xAfter < xBefore - 10, { xBefore, xAfter });
await shot("1e-handles-moved.png");
await page.click("#refadjust");

await page.waitForTimeout(700);
const saved = await E(() => fetch("/api/refs").then((r) => r.json()));
check("path and transform are stored per clip in editor metadata", saved.refs_demo?.path === WEBM && saved.refs_demo.transform.scale === scaleAfter, saved.refs_demo);
const rigHasRef = await E(() => JSON.stringify(window.atlasEditor.state().clip).includes("swing.webm"));
check("nothing about the reference leaks into the clip data", !rigHasRef);
await newClip("refs_other");
await page.waitForTimeout(500);
check("another clip has no reference", !(await refInfo()).loaded);
await E(async () => (await import("/src/host.ts")).getHost().switchClip("refs_demo"));
await page.waitForFunction(() => window.atlasRefs.info().loaded, null, { timeout: 15000 });
await refSettled();
info = await refInfo();
check("switching back restores the reference and its transform", info.loaded && info.meta.transform.scale === scaleAfter, info.meta?.transform);

await E((p) => window.atlasRefs.load(p, "sequence"), FRAMES);
await refSettled();
await frame(12);
await refSettled();
info = await refInfo();
check("an image sequence loads and follows the timeline", info.kind === "sequence" && info.count === 60 && info.frame === 12, info);
await shot("1f-image-sequence.png");

// =====================================================================================================
// 2. Server-tick hit lock
// =====================================================================================================
console.log("--- 2. hit lock");
await E(() => window.atlasRefs.clear());
const setup = await E(async () => {
  const { getHost } = await import("/src/host.ts");
  const { GAME_CLIPS } = await import("/src/gameClips.ts");
  const { templateFor } = await import("/src/clipTemplates.ts");
  const entry = GAME_CLIPS.find((c) => c.group === "attack" && c.timing.source === "profile" && c.klass === "ronin" && c.step === 1);
  getHost().newClip(entry.id, templateFor(entry));
  return { id: entry.id, style: entry.timing.styleId };
});
await page.waitForTimeout(500);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
console.log(setup);
let chip = await E(() => window.atlasHitLock.chip());
check("a template attack clip has its hit on the server tick", chip.state === "ok" && chip.text === "Hit on tick ✓", chip);
await frame(3);
await shot("2a-hit-on-tick.png");
await E(async () => {
  const { getHost } = await import("/src/host.ts");
  const { setEvent, deleteEvent } = await import("/src/eventModel.ts");
  const host = getHost();
  const hit = host.clip.events.find((e) => e.name === "hit");
  let c = deleteEvent(host.clip, hit.time, "hit");
  c = setEvent(c, hit.time + 1 / 30, "hit");
  host.commit(c, "Hit moved one frame late (demo)");
});
await page.waitForTimeout(500);
chip = await E(() => window.atlasHitLock.chip());
check("a hit one frame late shows the warning chip", chip.state === "bad" && chip.text === "Hit 1 frame late ▾", chip);
check("and a badge on the timeline", (await E(() => window.atlasHitLock.badges())).length === 1);
await page.click("#hitlock-pill");
await shot("2b-hit-late-badge-and-chip.png");
await page.click("#hitlock-pill");
const badge = (await E(() => window.atlasHitLock.badges()))[0];
await page.mouse.click(badge.x, badge.y);
await page.waitForTimeout(500);
chip = await E(() => window.atlasHitLock.chip());
check("clicking the badge snaps the hit to the contact frame", chip.state === "ok", chip);
await shot("2c-hit-snapped.png");
await E(async () => {
  const { getHost } = await import("/src/host.ts");
  const host = getHost();
  host.commit({ ...structuredClone(host.clip), duration: host.clip.duration + 8 / 30 }, "Clip made too long (demo)");
});
await page.waitForTimeout(500);
chip = await E(() => window.atlasHitLock.chip());
check("a clip longer than windup + recovery is flagged", chip.state === "bad" && /over/.test(chip.text), chip);
await shot("2d-clip-too-long.png");

// =====================================================================================================
// 3. Pose library with thumbnails
// =====================================================================================================
console.log("--- 3. pose library");
await newClip("poselib_demo");
const bones = await E(async () => (await import("/src/host.ts")).getHost().doc.bones.map((b) => b.name));
const spine = ["chest", "spine", "torso"].find((b) => bones.includes(b));
console.log({ spine, arms: bones.filter((b) => /arm|hand/.test(b)).slice(0, 8) });
const poseAt = (f, values) =>
  E(
    ([fr, vals]) => {
      const e = window.atlasEditor;
      e.setTime(fr / 30);
      for (const [bone, v] of Object.entries(vals)) {
        e.select(bone);
        e.rotate(bone, v);
        e.key();
      }
    },
    [f, values]
  );
await tab("library");
const savePose = async (name, tags, frameNo, values) => {
  await poseAt(frameNo, values);
  await page.fill("#posename", name);
  await E((t) => {
    const bar = document.getElementById("posesavetags");
    for (const b of bar.querySelectorAll(".ptag")) if (b.classList.contains("on")) b.click();
    for (const tag of t) [...document.getElementById("posesavetags").querySelectorAll(".ptag")].find((b) => b.textContent === tag).click();
  }, tags);
  await page.click("#savepose");
  await page.waitForTimeout(500);
};
await savePose("guard_high", ["guard"], 2, { upper_arm_near: -50, forearm_near: -70, [spine]: 4 });
await savePose("windup_back", ["wind-up"], 5, { upper_arm_near: -125, forearm_near: -60, [spine]: -12 });
await savePose("contact_strike", ["contact"], 9, { upper_arm_near: 10, forearm_near: -8, [spine]: 12 });
await savePose("follow_low", ["follow-through"], 14, { upper_arm_near: 40, forearm_near: -5, [spine]: 8 });
await savePose("idle_rest", ["idle"], 18, { upper_arm_near: 6, forearm_near: -12, [spine]: 0 });
await E(() => window.atlasPoseLib.settled());
await page.waitForTimeout(500);
const cards = await E(() => [...document.querySelectorAll("#posegrid .pcard")].map((c) => c.dataset.pose));
check("saved poses show as cards (plus the built-ins)", ["guard_high", "windup_back", "contact_strike", "follow_low", "idle_rest"].every((n) => cards.includes(n)), cards.length);
const thumbs = await E(() => [...document.querySelectorAll("#posegrid .pcard img")].map((i) => i.classList.contains("ready") && i.src.startsWith("data:image/png")));
check("every card has a rendered thumbnail", thumbs.length > 0 && thumbs.every(Boolean), thumbs.filter(Boolean).length + "/" + thumbs.length);
const before = await E(() => window.atlasPoseLib.thumbs());
await tab("pose");
await tab("library");
await page.waitForTimeout(300);
const afterThumbs = await E(() => window.atlasPoseLib.thumbs());
check("thumbnails are cached (switching tabs renders none again)", afterThumbs.rendered === before.rendered, { before, afterThumbs });
await shot("3a-pose-grid.png");

await page.fill("#poseq", "strike");
await page.waitForTimeout(250);
check("search narrows the grid", (await E(() => document.querySelectorAll("#posegrid .pcard").length)) === 1);
await page.fill("#poseq", "");
await E(() => [...document.querySelectorAll("#posetags .ptag")].find((b) => b.textContent === "guard").click());
await page.waitForTimeout(250);
const guardCards = await E(() => [...document.querySelectorAll("#posegrid .pcard")].map((c) => c.dataset.pose));
check("the guard tag filters the grid", guardCards.includes("guard_high") && !guardCards.includes("windup_back"), guardCards);
await shot("3b-tag-filter-guard.png");
await E(() => [...document.querySelectorAll("#posetags .ptag")].find((b) => b.textContent === "all").click());
await page.waitForTimeout(250);

// Apply by double-click on a fresh clip.
await newClip("poselib_apply");
await tab("library");
await frame(6);
const rotOf = (bone) => E((b) => (window.atlasEditor.state().clip.bones?.[b]?.rotate ?? []).map((k) => ({ f: Math.round((k.time ?? 0) * 30), v: Math.round(k.value ?? k.angle ?? 0) })), bone);
await page.locator('#posegrid .pcard[data-pose="windup_back"]').dblclick();
await page.waitForTimeout(400);
let arm = await rotOf("upper_arm_near");
console.log("upper_arm_near", JSON.stringify(arm));
check("double-click applies the pose, keyed (auto key on)", arm.some((k) => k.f === 6 && Math.abs(k.v + 125) <= 2), arm);
await shot("3c-applied-double-click.png");

// Drag onto the canvas at another frame.
await frame(10);
await page.locator('#posegrid .pcard[data-pose="follow_low"]').dragTo(page.locator("#view"), { targetPosition: { x: 400, y: 300 } });
await page.waitForTimeout(400);
arm = await rotOf("upper_arm_near");
check("dragging a pose onto the canvas applies it", arm.some((k) => k.f === 10 && k.v === 40), arm);

// Mirrored.
await frame(14);
await page.locator('#posegrid .pcard[data-pose="windup_back"]').click();
await page.click("#posemirror");
await page.waitForTimeout(400);
const far = await rotOf("upper_arm_far");
console.log("upper_arm_far", JSON.stringify(far));
check("Apply mirrored puts the pose on the other arm", far.some((k) => k.f === 14), far);
await shot("3d-applied-mirrored.png");

// Blend 50% from a known pose.
await frame(16);
await poseAt(16, { upper_arm_near: 0 });
await E(() => {
  const r = document.getElementById("poseblend");
  r.value = "50";
  r.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator('#posegrid .pcard[data-pose="guard_high"]').click();
await page.click("#poseapply");
await page.waitForTimeout(400);
const near = await rotOf("upper_arm_near");
console.log("upper_arm_near", JSON.stringify(near));
const k16 = near.find((x) => x.f === 16);
check("blend 50% applies the pose halfway (current 0, pose -50)", !!k16 && k16.v <= -20 && k16.v >= -30, k16);
await shot("3e-blend-50.png");
await E(() => {
  const r = document.getElementById("poseblend");
  r.value = "100";
  r.dispatchEvent(new Event("input", { bubbles: true }));
});

// Selected bones only.
await frame(18);
await E(() => window.atlasEditor.select("forearm_near"));
await page.locator('#posegrid .pcard[data-pose="follow_low"]').click();
await page.click("#poseselected");
await page.waitForTimeout(400);
const k18 = await E(() => {
  const e = window.atlasEditor.state().clip.bones ?? {};
  const has18 = (b) => (e[b]?.rotate ?? []).some((x) => Math.round((x.time ?? 0) * 30) === 18);
  return { forearm: has18("forearm_near"), upper: has18("upper_arm_near") };
});
check("To selected bones keys only the selected bone", k18.forearm && !k18.upper, k18);

// Auto key off: an unkeyed edit.
await frame(20);
await page.click("#autokey");
await page.locator('#posegrid .pcard[data-pose="contact_strike"]').dblclick();
await page.waitForTimeout(400);
const st = await E(() => window.atlasEditor.state());
const keyed20 = (st.clip.bones?.upper_arm_near?.rotate ?? []).some((x) => Math.round((x.time ?? 0) * 30) === 20);
check("with auto key off the pose stays an unkeyed edit", !keyed20 && Math.abs(st.pending.upper_arm_near ?? 0) > 1, { pending: st.pending.upper_arm_near });
await page.click("#autokey");

// Layout: no forced scrollbars outside the grid, no sideways overflow.
const overflow = await E(() => {
  const bad = [];
  for (const e of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(e);
    if (e.id === "posegrid") continue;
    if ((cs.overflowY === "scroll" || cs.overflowX === "scroll") && e.offsetParent) bad.push(e.id || e.className);
  }
  const pane = document.getElementById("pane-library");
  return { bad, paneX: pane.scrollWidth > pane.clientWidth + 1 };
});
check("no forced scrollbars and no sideways overflow in the Library tab", overflow.bad.length === 0 && !overflow.paneX, overflow);
await shot("3f-final-library.png");

check("no page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(failures ? `${failures} check(s) FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);
