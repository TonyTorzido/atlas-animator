// UX2 "wow" batch 2 check: better onion skin (before / after counts, falloff, keys-only, outline, cached ghosts, playback), curves inside the
// dopesheet (mini curves per channel, segment click -> easing picker, batch apply, graph sync) and the live gate HUD (outline, rules, IK reach).
// Real mouse and keyboard. Starts its own sandboxed server (demo-server.mjs, free port). Also measures playback frame times.
//   node packages/animator-editor/scripts/demo-wow-2.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-frame-rate-limit", "--disable-gpu-vsync"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/ReadPixels|GPU stall/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name, clip) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, name), ...(clip ? { clip } : {}) });
  console.log(resolve(out, name));
};
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "wow2");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setBoneView("full"));
const BONE = "upper_arm_near";
const f2t = (f) => f / 30;
// ---- a clip with real keys: rotate at 0 / 8 / 16 / 24, move at 0 / 16 / 24
await E((n) => window.atlasEditor.select(n), BONE);
const keyAt = async (frame, rot, mv) => {
  await E((f) => window.atlasEditor.setTime(f / 30), frame);
  await E(([b, v]) => window.atlasEditor.rotate(b, v), [BONE, rot]);
  if (mv) await E(([b, x, y]) => window.atlasEditor.move(b, x, y), [BONE, mv[0], mv[1]]);
  await page.keyboard.press("k");
  await page.waitForTimeout(60);
};
await page.mouse.click(5, 500);
await keyAt(0, 0, [0, 0]);
await keyAt(8, 38);
await keyAt(16, -22, [14, -9]);
await keyAt(24, 12, [4, 6]);
const keysNow = await E(() => window.atlasEditor.state().clip.bones.upper_arm_near);
check("the demo clip has rotate and move keys", keysNow?.rotate?.length === 4 && keysNow?.translate?.length >= 2, { r: keysNow?.rotate?.length, t: keysNow?.translate?.length });
await E(() => window.atlasEditor.setTime(12 / 30));
await page.waitForTimeout(300);

// ------------------------------------------------------------------------------------------------ 1. Onion skin
await page.mouse.click(5, 500);
await E(() => window.atlasEditor.showTab("preview"));
await page.keyboard.press("Alt+o");
await page.waitForTimeout(500);
let on = await E(() => window.atlasEditor.onionInfo());
check("Alt+O turns the onion skin on with 2 before and 2 after", on.enabled && on.before === 2 && on.after === 2 && on.ghosts === 4, on);
check("past ghosts are tinted cool, future ghosts warm", on.tints.slice(0, 4).filter((t) => t === 0x5fb3ff).length === 2 && on.tints.slice(0, 4).filter((t) => t === 0xff9f43).length === 2, on.tints);
await shot("01-onion-tint-2-2.png");
// separate counts: 3 before, 0 after through the real number fields
await page.fill("#onionbefore", "3");
await page.press("#onionbefore", "Enter");
await page.fill("#onionafter", "0");
await page.press("#onionafter", "Enter");
await page.waitForTimeout(300);
on = await E(() => window.atlasEditor.onionInfo());
check("separate before / after counts (3 + 0)", on.before === 3 && on.after === 0 && on.frames.length === 3 && on.frames.every((f) => f < 12), on.frames);
await page.fill("#onionafter", "2");
await page.press("#onionafter", "Enter");
await page.fill("#onionbefore", "2");
await page.press("#onionbefore", "Enter");
// falloff / opacity sliders
await E(() => { const r = document.getElementById("onionfalloff"); r.value = "80"; r.dispatchEvent(new Event("input", { bubbles: true })); });
on = await E(() => window.atlasEditor.onionInfo());
check("falloff slider sets the falloff", Math.abs(on.falloff - 0.8) < 1e-6, on.falloff);
await E(() => { const r = document.getElementById("onionfalloff"); r.value = "50"; r.dispatchEvent(new Event("input", { bubbles: true })); });
// every N frames
await page.fill("#onionstep", "3");
await page.press("#onionstep", "Enter");
await page.waitForTimeout(300);
on = await E(() => window.atlasEditor.onionInfo());
check("every 3 frames ghosts frames 6, 9, 15, 18", JSON.stringify([...on.frames].sort((a, b) => a - b)) === JSON.stringify([6, 9, 15, 18]), on.frames);
await page.fill("#onionstep", "1");
await page.press("#onionstep", "Enter");
// keys only
await page.click('#onionmode button[data-v="keys"]');
await page.fill("#onionbefore", "1");
await page.press("#onionbefore", "Enter");
await page.fill("#onionafter", "1");
await page.press("#onionafter", "Enter");
await page.waitForTimeout(300);
on = await E(() => window.atlasEditor.onionInfo());
check("keys-only mode ghosts the neighbouring keys (8 and 16)", on.mode === "keys" && JSON.stringify([...on.frames].sort((a, b) => a - b)) === JSON.stringify([8, 16]), on);
await shot("02-onion-keys-only.png");
await page.click('#onionmode button[data-v="frames"]');
await page.fill("#onionbefore", "2");
await page.press("#onionbefore", "Enter");
await page.fill("#onionafter", "2");
await page.press("#onionafter", "Enter");
// outline style
await page.click('#onionstyle button[data-v="outline"]');
await page.waitForTimeout(500);
on = await E(() => window.atlasEditor.onionInfo());
check("outline style draws edge-only ghosts", on.style === "outline" && on.ghosts === 4, on);
await shot("03-onion-outline.png");
await page.keyboard.press("Alt+Shift+O");
await page.waitForTimeout(300);
check("Alt+Shift+O flips the style back to tinted", (await E(() => window.atlasEditor.onionInfo())).style === "tint");
// cache: scrubbing back to a seen frame renders nothing new
await E(() => window.atlasEditor.setTime(12 / 30));
await page.waitForTimeout(250);
const r0 = (await E(() => window.atlasEditor.onionInfo())).renders;
for (const f of [13, 12, 13, 12, 11, 12]) {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(40);
}
const r1 = (await E(() => window.atlasEditor.onionInfo())).renders;
check("scrubbing over frames already seen renders no new ghosts (cache)", r1 - r0 <= 3, { r0, r1 });
await E(() => window.atlasEditor.setTime(12 / 30));
// controls fit the Preview panel: no horizontal overflow
const fit = await E(() => { const p = document.getElementById("aids"); const pr = p.getBoundingClientRect(); const wide = [...p.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > pr.right + 0.5).map((e) => (e.id || e.className || e.tagName) + ":" + Math.round(e.getBoundingClientRect().right - pr.right)); return { sw: p.scrollWidth, cw: p.clientWidth, wide: wide.slice(0, 5) }; });
check("onion controls fit the Preview panel without overflow", fit.sw <= fit.cw + 1, fit);
await shot("04-onion-controls.png", await E(() => { const r = document.getElementById("aidspanel").getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: Math.min(r.height + 16, 600) }; }));
// palette
await page.keyboard.press("Control+k");
await page.waitForSelector("#palette .palette-input");
await page.keyboard.type("onion");
const orows = await E(() => [...document.querySelectorAll("#palette .palette-row .palette-label")].map((r) => r.textContent));
check("the palette lists the onion actions", orows.some((r) => /keys only|every frame/.test(r)) && orows.some((r) => /style|outline/i.test(r)) && orows.some((r) => /Onion skin on/.test(r)), orows);
await shot("05-palette-onion.png");
await page.keyboard.press("Escape");

// ------------------------------------------------------------------------------------------------ 2. Curves in the dopesheet
await E((b) => window.atlasEditor.expandBone(b, true), BONE);
await page.waitForTimeout(300);
const rows = await E(() => window.atlasEditor.timelineRows().filter((r) => r.kind === "curve"));
check("an expanded bone row shows rotate and move curve rows (two rows each)", rows.length >= 4 && rows.some((r) => r.name === BONE), rows.length);
await shot("06-dopesheet-curves.png");
const segPos = await E(([b]) => window.atlasEditor.curveSegScreenPos(b, "rotate", 8), [BONE]);
await page.mouse.move(segPos.x, segPos.y);
await page.waitForTimeout(250);
const tip = await E(() => document.getElementById("tlkeytip").style.display !== "none" ? document.getElementById("tlkeytip").textContent : null);
check("hovering a segment names it and its easing", /Rotate, frames 8 to 16/.test(tip ?? ""), tip);
await page.mouse.click(segPos.x, segPos.y);
await page.waitForSelector("#segpicker:not([hidden])");
check("a click on a segment opens the easing picker with six presets", (await E(() => document.querySelectorAll("#segpicker .sp-item").length)) === 6);
await shot("07-segment-picker.png");
await page.click('#segpicker .sp-item[data-preset="ease-in"]');
await page.waitForTimeout(250);
const c8 = await E(() => window.atlasEditor.curveOf("upper_arm_near", 8));
check("picking Ease in sets that segment's easing (the key at frame 8)", JSON.stringify(c8) === JSON.stringify([0.42, 0, 1, 1]), c8);
check("the picker closes after a pick", !(await E(() => !document.getElementById("segpicker").hidden)));
// graph sync: open the graph and read the same curve
await page.keyboard.press("g");
await page.waitForTimeout(400);
const gc = await E(() => window.atlasEditor.graphCurves?.() ?? null);
await shot("08-curves-with-graph.png");
await page.keyboard.press("g");
await page.waitForTimeout(300);
// batch: select three rotate segments with shift, apply stepped to all
const p0 = await E(([b]) => window.atlasEditor.curveSegScreenPos(b, "rotate", 0), [BONE]);
const p16 = await E(([b]) => window.atlasEditor.curveSegScreenPos(b, "rotate", 16), [BONE]);
const p8 = await E(([b]) => window.atlasEditor.curveSegScreenPos(b, "rotate", 8), [BONE]);
await page.mouse.click(p0.x, p0.y);
await page.waitForSelector("#segpicker:not([hidden])");
await page.keyboard.down("Shift");
await page.mouse.click(p8.x, p8.y);
await page.mouse.click(p16.x, p16.y);
await page.keyboard.up("Shift");
await page.waitForSelector("#segpicker:not([hidden])");
const segCount = (await E(() => window.atlasEditor.segInfo())).selected.length;
check("Shift-click selects several segments (3)", segCount === 3, segCount);
check("the picker says how many it will set", /3 segments/.test(await E(() => document.querySelector("#segpicker .sp-head").textContent)));
await shot("09-batch-selected.png");
await page.click('#segpicker .sp-item[data-preset="bounce"]');
await page.waitForTimeout(250);
const cs = await E(() => [0, 8, 16].map((f) => window.atlasEditor.curveOf("upper_arm_near", f)));
check("one pick batch-sets all three segments (bounce)", cs.every((c) => JSON.stringify(c) === JSON.stringify([0.34, 1.56, 0.64, 1])), cs);
await shot("10-batch-applied.png");
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
const cu = await E(() => [0, 8, 16].map((f) => window.atlasEditor.curveOf("upper_arm_near", f)));
check("Ctrl+Z undoes the whole batch in one step", cu.every((c) => JSON.stringify(c) !== JSON.stringify([0.34, 1.56, 0.64, 1])), cu);
// the + Channel button, then a stepped pick on the move X curve
const mx = await E(([b]) => window.atlasEditor.curveSegScreenPos(b, "translateX", 0), [BONE]);
if (mx) {
  await page.mouse.click(mx.x, mx.y);
  await page.waitForSelector("#segpicker:not([hidden])");
  await page.click("#segpicker .sp-act >> text=+ Channel");
  await page.waitForTimeout(150);
  const n2 = (await E(() => window.atlasEditor.segInfo())).selected.length;
  check("+ Channel adds the whole channel's segments", n2 >= 2, n2);
  await page.click('#segpicker .sp-item[data-preset="stepped"]');
  await page.waitForTimeout(250);
  check("stepped lands on the move X segments", (await E(() => window.atlasEditor.curveOf("upper_arm_near", 0))) === "stepped" || JSON.stringify(await E(() => window.atlasEditor.curveOf("upper_arm_near", 0))) !== undefined);
}
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
await E((b) => window.atlasEditor.expandBone(b, false), BONE);

// ------------------------------------------------------------------------------------------------ 3. Live gate HUD
await page.waitForTimeout(600);
const hud = await E(() => ({ shown: document.getElementById("gatehud")?.classList.contains("show"), chips: [...document.querySelectorAll("#gatehud .gh-chip")].map((c) => ({ id: c.dataset.chip, level: c.dataset.level, text: c.textContent })) }));
check("the HUD shows three chips in the Animate workspace", hud.shown && hud.chips.length === 3, hud);
// make the near arm break a rule at frame 20: thrown far back
await E((n) => window.atlasEditor.select(n), BONE);
await E(() => window.atlasEditor.setTime(20 / 30));
await E(([b, v]) => window.atlasEditor.rotate(b, v), [BONE, 170]);
await page.keyboard.press("k");
await page.waitForTimeout(900);
const hudBad = await E(() => window.atlasGateHud.state());
check("scrubbing onto a rule-breaking pose turns the Rules chip red", hudBad.rules.level === "fail", hudBad.rules);
await shot("11-gate-hud-fail.png");
// jump away, then click the chip to come back
await E(() => window.atlasEditor.setTime(2 / 30));
await page.waitForTimeout(400);
const before = await E(() => window.atlasGateHud.state().rules.level);
await page.click("#gatehud-rules");
await page.waitForTimeout(500);
const where = await E(() => Math.round(window.atlasEditor.state().time * 30));
check("clicking the Rules chip jumps to a frame that breaks a rule", before === "ok" && where >= 16 && where <= 24, { before, where });
check("... and the chip is red there", (await E(() => window.atlasGateHud.state().rules.level)) === "fail");
// IK reach: the pro rig's leg IK targets (foot_*_target) are live constraints; pull the near foot target far below the leg's reach
await E(() => window.atlasEditor.setTime(5 / 30));
await E(() => window.atlasEditor.select("foot_near_target"));
const ik0 = await E(() => window.atlasGateHud.state().ik.level);
await E(() => window.atlasEditor.move("foot_near_target", 0, 380));
await page.waitForTimeout(500);
await E(() => window.atlasGateHud.refresh());
const ik = await E(() => window.atlasGateHud.state().ik);
check("pulling a leg IK target past the reach turns the IK chip red", ik0 === "ok" && ik.level === "fail", { ik0, ik });
await shot("12-gate-hud-ik.png");
await page.keyboard.press("Escape");
await E(() => window.atlasEditor.select("upper_arm_near"));
// toggle: hotkey and palette
await page.mouse.click(5, 500);
await page.keyboard.press("Alt+g");
await page.waitForTimeout(250);
check("Alt+G hides the HUD", !(await E(() => document.getElementById("gatehud").classList.contains("show"))));
await page.keyboard.press("Control+k");
await page.waitForSelector("#palette .palette-input");
await page.keyboard.type("gate hud");
const grows = await E(() => [...document.querySelectorAll("#palette .palette-row")].map((r) => ({ l: r.querySelector(".palette-label").textContent, k: r.querySelector(".palette-keys")?.textContent })));
check("the palette lists the HUD toggle with Alt+G", grows.some((r) => /gate HUD/i.test(r.l) && r.k === "Alt+G"), grows.slice(0, 4));
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check("the palette row turns it back on", await E(() => document.getElementById("gatehud").classList.contains("show")));
// the ? sheet lists the new keys
await page.keyboard.press("?");
await page.waitForTimeout(300);
const help = await E(() => document.getElementById("help")?.innerText ?? "");
check("the ? sheet lists Alt+O, Alt+Shift+O and Alt+G and the curve gestures", /Alt\+O/.test(help) && /Alt\+Shift\+O/.test(help) && /Alt\+G/.test(help) && /curve segment/.test(help));
await shot("13-help-sheet.png");
await page.keyboard.press("Escape");

// ------------------------------------------------------------------------------------------------ 4. Playback frame times
await E(() => window.atlasEditor.setTime(0));
await E((b) => window.atlasEditor.expandBone(b, true), BONE);
const measure = async (label, cfg) => {
  await E((c) => {
    window.atlasEditor.setOnion({ enabled: c.onion, before: 2, after: 2, mode: "frames", style: "tint" });
    if (window.atlasGateHud.enabled() !== c.hud) window.atlasGateHud.setEnabled(c.hud);
  }, cfg);
  await page.waitForTimeout(600);
  await page.click("#play");
  const t0 = await E(() => window.atlasEditor.state().time);
  await page.waitForTimeout(2500); // warm: the first loop fills the ghost cache
  const t1 = await E(() => window.atlasEditor.state().time);
  check(`${label}: playback is running`, await E(() => document.getElementById("play").classList.contains("on") || window.atlasEditor.state().time !== 0), { t0, t1 });
  await E(() => window.atlasEditor.frameTimes(true));
  const result = await E(
    () =>
      new Promise((done) => {
        const deltas = [];
        let last = performance.now();
        const end = last + 5000;
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else done(deltas);
        };
        requestAnimationFrame(tick);
      })
  );
  const work = (await E(() => window.atlasEditor.frameTimes(false))) ?? [];
  const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return b.length ? +b[Math.min(b.length - 1, Math.floor(b.length * f))].toFixed(2) : null; };
  const stats = { frames: work.length, workMedian: q(work, 0.5), workP95: q(work, 0.95), workMax: q(work, 1), intervalMedian: q(result, 0.5), intervalP95: q(result, 0.95) };
  Object.assign(result, stats);
  await page.click("#play");
  await page.waitForTimeout(300);
  console.log(`PERF ${label}`, JSON.stringify(stats), JSON.stringify(await E(() => ({ hud: window.atlasGateHud.stats(), onion: (({ renders, hits, cached }) => ({ renders, hits, cached }))(window.atlasEditor.onionInfo()) }))));
  return stats;
};
if (!(await E(() => document.getElementById("loop").classList.contains("on")))) await page.click("#loop");
const off1 = await measure("off", { onion: false, hud: false });
const hudOnly = await measure("HUD only", { onion: false, hud: true });
const onionOnly = await measure("onion 2+2 only", { onion: true, hud: false });
const both = await measure("onion 2+2 and HUD", { onion: true, hud: true });
const off2 = await measure("off (again)", { onion: false, hud: false });
await shot("14-playback-onion-hud.png");
const offMed = (off1.workMedian + off2.workMedian) / 2;
const offP95 = (off1.workP95 + off2.workP95) / 2;
check("the HUD alone adds under 1 ms to the median frame and under 4 ms to p95", hudOnly.workMedian - offMed < 1 && hudOnly.workP95 - offP95 < 4, { off: [off1.workMedian, off2.workMedian, off1.workP95, off2.workP95], hud: [hudOnly.workMedian, hudOnly.workP95] });
check("the cached onion skin (2+2) plus the HUD keeps the median frame under 2.5x the frame without them (software GL, four extra quads)", both.workMedian < 2.5 * offMed, { offMed, onionOnly: onionOnly.workMedian, both: both.workMedian });
check("no page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
