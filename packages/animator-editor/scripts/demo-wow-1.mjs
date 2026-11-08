// UX2 "wow" batch 1 check: command palette (Ctrl+K), smart pose assist (readout, Shift / Ctrl snaps, typed numbers, limits flash),
// pose A / B compare (pin, ghost, swap). Real mouse and keyboard. Starts its own sandboxed server (demo-server.mjs, free port).
//   node packages/animator-editor/scripts/demo-wow-1.mjs [outDir]
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
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
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
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(out, name) });
  console.log(resolve(out, name));
};
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "wow");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setBoneView("full"));
const BONE = "upper_arm_near";
const rot = async (name = BONE) => (await E((n) => window.atlasEditor.boneRot(n), name));
const ends = (name = BONE) => E((n) => window.atlasEditor.boneScreenEnds(n), name);
const info = () => E(() => window.atlasEditor.assistInfo());
const readout = () => E(() => { const l = document.getElementById("hoverlabel"); return l && l.style.display !== "none" ? l.innerText : null; });
const rotSlug = (e, deg) => {
  const dx = e.tip.x - e.origin.x, dy = e.tip.y - e.origin.y, r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx) + (deg * Math.PI) / 180;
  return { x: e.origin.x + Math.cos(a) * r, y: e.origin.y + Math.sin(a) * r };
};
// Pans the bone to the middle of the canvas so every press lands on it.
const centre = async (name) => {
  const e = await ends(name);
  const r = await E(() => { const b = document.querySelector("#view canvas").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(r.x + (r.x - e.mid.x), r.y + (r.y - e.mid.y), { steps: 6 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(150);
};
await E((n) => window.atlasEditor.select(n), BONE);
await E(() => window.atlasEditor.setGizmo("rotate"));
await centre(BONE);

// ------------------------------------------------------------------------------------------------ 1. Command palette
await page.mouse.click(5, 500); // body focus
await page.keyboard.press("t");
check("T switches to the move tool", (await E(() => document.querySelector('#gizmo button.on')?.dataset.mode)) === "move");
await page.keyboard.press("Control+k");
await page.waitForSelector("#palette .palette-input");
check("Ctrl+K opens the palette with focus in the search box", await E(() => document.activeElement?.classList.contains("palette-input")));
const rowsEmpty = await E(() => [...document.querySelectorAll("#palette .palette-row")].length);
check("empty query lists the actions", rowsEmpty > 20, rowsEmpty);
await shot("01-palette-open.png");
await page.keyboard.type("rotate");
const top = await E(() => ({ label: document.querySelector("#palette .palette-row.active .palette-label")?.textContent, keys: document.querySelector("#palette .palette-row.active .palette-keys")?.textContent }));
check("typing 'rotate' puts the Rotate tool first, with its shortcut shown", top.label === "Rotate tool" && top.keys === "R", top);
await shot("02-palette-search.png");
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
check("Enter runs it (rotate tool on) and closes the palette", (await E(() => document.querySelector('#gizmo button.on')?.dataset.mode)) === "rotate" && !(await E(() => !!document.getElementById("palette"))));
check("focus is restored out of the palette", await E(() => !document.activeElement?.classList.contains("palette-input")));
// Meta+K too, arrows, Esc.
await page.keyboard.press("Meta+k");
await page.waitForSelector("#palette");
check("Cmd+K opens it too", true);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
const act = await E(() => [...document.querySelectorAll("#palette .palette-row")].findIndex((r) => r.classList.contains("active")));
check("Arrow keys move the highlight", act === 2, act);
const recentFirst = await E(() => document.querySelector("#palette .palette-cap")?.textContent);
check("recently used actions are listed first under Recent", recentFirst === "Recent", recentFirst);
await page.keyboard.press("Escape");
check("Esc closes", !(await E(() => !!document.getElementById("palette"))));
// Workspace, clip, bone, skin, toggle, export rows.
const find = async (q) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette .palette-input");
  await page.keyboard.type(q);
  return E(() => [...document.querySelectorAll("#palette .palette-row")].map((r) => r.querySelector(".palette-label").textContent));
};
let rows = await find("go to rig");
check("workspace rows", rows[0] === "Go to Rig", rows.slice(0, 3));
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check("running a workspace row switches to it", (await E(() => window.atlasEditor.workspace())) === "rig");
rows = await find("open clip wow");
check("clip rows", rows[0] === "Open clip wow", rows.slice(0, 3));
await page.keyboard.press("Escape");
rows = await find("select bone head");
check("bone rows", rows[0] === "Select bone head", rows.slice(0, 3));
await page.keyboard.press("Enter");
check("running a bone row selects it", (await E(() => window.atlasEditor.boneSelection().active)) === "head");
rows = await find("wear skin");
check("skin rows", rows.length > 0 && rows.every((r) => /skin/i.test(r)), rows.slice(0, 3));
await page.keyboard.press("Escape");
rows = await find("phone size");
check("toggle rows (phone size)", rows.some((r) => /Phone size/.test(r)), rows.slice(0, 3));
await page.keyboard.press("Escape");
rows = await find("export");
check("export rows", rows.some((r) => /Export the clip/.test(r)), rows.slice(0, 3));
await page.keyboard.press("Escape");
rows = await find("pose a");
check("new hotkeys appear automatically (pin / swap pose A)", rows.some((r) => /Pin the current pose/.test(r)) && rows.some((r) => /Swap A and B/.test(r)), rows.slice(0, 4));
await shot("03-palette-pose-a.png");
await page.keyboard.press("Escape");
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
await page.mouse.click(5, 500);
await E((n) => window.atlasEditor.select(n), BONE);
await E(() => window.atlasEditor.setGizmo("rotate"));
await centre(BONE);

// ------------------------------------------------------------------------------------------------ 2. Smart pose assist
// First a key at frame 0 at exactly 40 degrees (typed), to be the "previous key" later.
await E(() => window.atlasEditor.setTime(0));
let e = await ends();
await page.mouse.move(e.tip.x, e.tip.y);
await page.mouse.down();
await page.mouse.move(rotSlug(e, 20).x, rotSlug(e, 20).y, { steps: 8 });
const r1 = await readout();
check("dragging shows a readout with the angle and its change", !!r1 && /°/.test(r1) && /[+−]\d/.test(r1), r1);
await shot("04-readout-drag.png");
await page.keyboard.press("4");
await page.keyboard.press("0");
let a = await info();
const rType = await readout();
check("typing digits mid-drag shows the typed number", a.typed === "40" && /40/.test(rType ?? ""), { a, rType });
check("the typed angle is applied live", Math.abs((await rot()) - 40) < 0.01, await rot());
await shot("05-typed-number.png");
await page.keyboard.press("Enter");
check("Enter commits the exact value and ends the drag", (await info()).dragging === null && Math.abs((await rot()) - 40) < 0.01, await info());
await page.keyboard.press("k");
await page.waitForTimeout(150);

// Shift snaps to 15 degrees with tick guides.
await E(() => window.atlasEditor.setTime(10 / 30));
await E((n) => window.atlasEditor.select(n), BONE);
e = await ends();
await page.mouse.move(e.tip.x, e.tip.y);
await page.mouse.down();
await page.mouse.move(rotSlug(e, 12).x, rotSlug(e, 12).y, { steps: 6 });
await page.keyboard.down("Shift");
await page.mouse.move(rotSlug(e, 21).x, rotSlug(e, 21).y, { steps: 4 });
const sv = await rot();
a = await info();
check("Shift snaps the rotation to a multiple of 15", a.snap === "step" && Math.abs(sv / 15 - Math.round(sv / 15)) < 1e-6, { sv, a });
await shot("06-shift-snap-guides.png");
await page.keyboard.up("Shift");
// Ctrl snaps to the previous key (40) when near it.
await page.mouse.move(rotSlug(e, 6).x, rotSlug(e, 6).y, { steps: 6 });
const start = await rot();
await page.keyboard.down("Control");
const near = start; // stay where the pointer is; Ctrl re-evaluates on the next move
await page.mouse.move(rotSlug(e, 6.5).x, rotSlug(e, 6.5).y, { steps: 3 });
a = await info();
const cv = await rot();
check("Ctrl shows the previous-key / mirror guides", a.guides >= 1, a);
await shot("07-ctrl-guides.png");
await page.keyboard.up("Control");
await page.keyboard.press("Escape");
check("Esc cancels the drag", (await info()).dragging === null);

// Ctrl-snap to the previous key proper: pointer within the magnet of 40.
await E((n) => window.atlasEditor.select(n), BONE);
e = await ends();
const s0 = await rot();
await page.mouse.move(e.tip.x, e.tip.y);
await page.mouse.down();
await page.mouse.move(rotSlug(e, 44 - s0).x, rotSlug(e, 44 - s0).y, { steps: 6 });
await page.keyboard.down("Control");
await page.mouse.move(rotSlug(e, 45 - s0).x, rotSlug(e, 45 - s0).y, { steps: 3 });
a = await info();
check("Ctrl pulls onto the previous key's angle (40)", (a.snap === "key" || a.snap === "mirror") && (a.snap !== "key" || Math.abs((await rot()) - 40) < 0.01), { a, rot: await rot() });
await page.keyboard.up("Control");
await page.mouse.up();

// Limits flash.
await E((n) => window.atlasEditor.select(n), BONE);
e = await ends();
await page.mouse.move(e.tip.x, e.tip.y);
await page.mouse.down();
await page.mouse.move(rotSlug(e, 10).x, rotSlug(e, 10).y, { steps: 5 });
for (const k of ["1", "7", "9"]) await page.keyboard.press(k);
const flash = await E(() => { const f = document.getElementById("limitflash"); return f.style.display !== "none" ? f.textContent : null; });
await page.keyboard.press("Escape");
// A bone with declared limits: typing a value past them raises the limits flash.
const limited = await E(() => window.atlasEditor.boneLimits());
const lb = limited.find((b) => b.max < 170 && ["head", "chest", "spine", "lower_arm_near", "forearm_near", "neck"].includes(b.name)) ?? limited[0];
if (lb) {
  await E((n) => window.atlasEditor.select(n), lb.name);
  await centre(lb.name);
  const le = await ends(lb.name);
  await page.mouse.move(le.tip.x, le.tip.y);
  await page.mouse.down();
  await page.mouse.move(rotSlug(le, 8).x, rotSlug(le, 8).y, { steps: 5 });
  for (const k of String(Math.round(lb.max + 40)).split("")) await page.keyboard.press(k);
  const f2 = await E(() => { const f = document.getElementById("limitflash"); return f.style.display !== "none" ? f.textContent : null; });
  check("typing a value past " + lb.name + "'s limit raises the limits flash", !!f2, { lb, f2 });
  await shot("06b-limits-flash.png");
  await page.keyboard.press("Escape");
} else console.log("no bone with limits found");

// Move: x / y readout and typed values.
await page.mouse.click(5, 500);
await E(() => window.atlasEditor.setGizmo("move"));
await E(() => window.atlasEditor.select("hand_near"));
await centre("hand_near");
e = await ends("hand_near");
await page.mouse.move(e.origin.x, e.origin.y);
await page.mouse.down();
await page.mouse.move(e.origin.x + 18, e.origin.y + 10, { steps: 6 });
const mr = await readout();
check("moving shows x / y in the readout", /x .*y /.test(mr ?? ""), mr);
await page.keyboard.press("5");
await page.keyboard.press("Tab");
await page.keyboard.press("-");
await page.keyboard.press("3");
a = await info();
check("move: type X, Tab, type Y", a.moveTyped?.x === "5" && a.moveTyped?.y === "-3", a.moveTyped);
await shot("08-move-typed.png");
await page.keyboard.press("Enter");
check("move: Enter ends the drag", (await info()).dragging === null);
await page.keyboard.press("Escape");
await E(() => window.atlasEditor.undo());

// ------------------------------------------------------------------------------------------------ 3. Pose A / B compare
await E(() => window.atlasEditor.setGizmo("rotate"));
await E((n) => window.atlasEditor.select(n), BONE);
await E(() => window.atlasEditor.setTime(0));
await page.waitForTimeout(300);
const rA = await rot();
await page.mouse.click(5, 500);
await E((n) => window.atlasEditor.select(n), BONE);
await page.keyboard.press("q");
let ab = await E(() => window.atlasEditor.abInfo());
check("Q pins the current pose as A", ab.pinned?.clipName === "wow" && ab.pinned.frame === 0 && ab.ghost, ab);
// Move to another frame and change the pose.
await E(() => window.atlasEditor.setTime(20 / 30));
e = await ends();
await page.mouse.move(e.tip.x, e.tip.y);
await page.mouse.down();
await page.mouse.move(rotSlug(e, 50).x, rotSlug(e, 50).y, { steps: 8 });
await page.mouse.up();
await page.keyboard.press("k");
const rB = await rot();
await page.waitForTimeout(400);
ab = await E(() => window.atlasEditor.abInfo());
check("the A ghost shows over the live pose B on another frame", ab.layer?.visible === true && ab.ghost, ab);
await shot("09-pose-a-ghost.png");
await page.keyboard.press("e");
await page.waitForTimeout(250);
ab = await E(() => window.atlasEditor.abInfo());
check("E hides the ghost", !ab.ghost && ab.layer?.visible === false, ab);
await page.keyboard.press("e");
await page.keyboard.press("\\");
await page.waitForTimeout(200);
const rView = await rot();
ab = await E(() => window.atlasEditor.abInfo());
check("\\ swaps in pose A (the bone shows A's angle, not B's)", ab.view && Math.abs(rView - rA) < 0.5 && Math.abs(rView - rB) > 5, { rA, rB, rView, ab });
await shot("10-pose-a-swapped.png");
await page.keyboard.press("\\");
await page.waitForTimeout(200);
check("\\ again returns to the live pose B", !(await E(() => window.atlasEditor.abInfo().view)) && Math.abs((await rot()) - rB) < 0.5, await rot());
// Across clips.
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "wow2");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
await page.mouse.click(5, 500);
ab = await E(() => window.atlasEditor.abInfo());
check("A survives a clip switch (pinned from clip wow)", ab.pinned?.clipName === "wow" && ab.ghost, ab);
await page.keyboard.press("\\");
await page.waitForTimeout(200);
const rCross = await rot();
check("swap works across clips (shows A from clip wow)", (await E(() => window.atlasEditor.abInfo().view)) && Math.abs(rCross - rA) < 0.5, { rCross, rA });
await shot("11-pose-a-other-clip.png");
await page.keyboard.press("\\");
await page.keyboard.press("Q".toLowerCase());
await page.keyboard.press("Shift+Q");
ab = await E(() => window.atlasEditor.abInfo());
check("Shift+Q clears A", ab.pinned === null && !ab.ghost, ab);

// ? sheet lists the new shortcuts.
await page.keyboard.press("?");
await page.waitForTimeout(300);
const help = await E(() => document.getElementById("helpbody")?.innerText ?? "");
check("the ? sheet lists Ctrl+K, Q, E, \\ and the assist gestures", /Ctrl\+K/.test(help) && /Pin the current pose as A/.test(help) && /Swap A and B/.test(help) && /Type a number while dragging/.test(help) && /previous key/.test(help), help.length);
await shot("12-help-sheet.png");
await page.keyboard.press("Escape");

console.log("page errors:", errors.length ? errors : "none");
check("zero page errors", errors.length === 0, errors);
await browser.close();
process.exit(failures ? 1 : 0);
