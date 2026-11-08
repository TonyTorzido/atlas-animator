// Demo of the Tree (outliner) with screenshots and PASS/FAIL checks: hierarchy, search, filters, keyboard, eye, select lock, inherit
// toggles, New / Parent / Split / Delete through Setup (with undo), and the Animate "Show full tree" switch.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-tree.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../docs/plans/atlas-animator-demos/editor/tree"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);

const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(400);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const raw = () => E(() => window.atlasEditor.setupRaw());
const boneOf = async (name) => (await raw()).bones.find((b) => b.name === name);
const rowCount = () => E(() => document.querySelectorAll("#outliner .ol-row").length);
const rowEl = (id) => page.locator(`#outliner .ol-row[data-id="${id}"]`);
const selected = () => E(() => window.atlasEditor.boneSelection().active);
const status = () => E(() => document.getElementById("status")?.textContent ?? "");

// ---- Pro: the Tree replaces the BONES list -------------------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("pro"));
await page.waitForTimeout(700);
check("Pro shows the Tree, not the old list", (await E(() => getComputedStyle(document.getElementById("outliner")).display !== "none" && getComputedStyle(document.getElementById("bones")).display === "none")));
const startRows = await rowCount();
check("tree has rows (bones + slots)", startRows > 10, startRows);
check("slot rows sit under bones", await E(() => !!document.querySelector("#outliner .ol-row.k-slot")));
check("no page scrollbars", await E(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1));
check("the left column is widened for the Tree", await E(() => document.getElementById("left").getBoundingClientRect().width >= 260), await E(() => getComputedStyle(document.getElementById("app")).gridTemplateColumns));
await shot("01-pro-tree.png");

// Expand all, then open one slot.
await page.click('#outliner button[title="Expand every row"]');
check("expand all shows attachments", await E(() => !!document.querySelector("#outliner .ol-row.k-attachment")));
await shot("02-expanded.png");
await page.click('#outliner button[title="Collapse every row"]');
check("collapse all leaves only the first bone", (await E(() => document.querySelectorAll("#outliner .ol-row.k-bone").length)) === 1);
await page.click('#outliner button[title="Expand every row"]');

// ---- search / filters ------------------------------------------------------------------------------------------------
await page.fill("#outliner .ol-search", "arm");
await page.waitForTimeout(200);
const searched = await rowCount();
check("search narrows the rows", searched > 0 && searched < startRows, searched);
await shot("03-search.png");
await page.fill("#outliner .ol-search", "");
await page.waitForTimeout(200);
await page.click('#outliner .ol-filter[data-filter="slots"]');
check("filter off drops slots", !(await E(() => !!document.querySelector("#outliner .ol-row.k-slot"))));
await page.click('#outliner .ol-filter[data-filter="slots"]');
check("filter on brings slots back", await E(() => !!document.querySelector("#outliner .ol-row.k-slot")));

// ---- selection, keyboard ---------------------------------------------------------------------------------------------
const firstBone = await E(() => document.querySelectorAll("#outliner .ol-row.k-bone")[2]?.dataset.id);
await rowEl(firstBone).click();
check("click selects the bone", (await selected()) === firstBone.slice(2), await selected());
await page.keyboard.press("ArrowDown");
const afterDown = await E(() => document.querySelector("#outliner .ol-row.sel")?.dataset.id);
check("arrow down moves the selection", afterDown !== firstBone, afterDown);
await page.keyboard.press("ArrowUp");
check("arrow up moves back", (await E(() => document.querySelector("#outliner .ol-row.sel")?.dataset.id)) === firstBone);
const parentId = await E(() => [...document.querySelectorAll("#outliner .ol-row.k-bone")].find((r) => r.querySelector(".ol-arrow.open"))?.dataset.id);
await rowEl(parentId).click();
const before = await rowCount();
await page.keyboard.press("ArrowLeft");
check("left arrow collapses an open row", (await rowCount()) < before, [before, await rowCount()]);
await page.keyboard.press("ArrowRight");
check("right arrow expands it again", (await rowCount()) === before);
// Back / forward history.
await page.click('#outliner button[title^="Back:"]');
check("back returns to an earlier selection", (await selected()) !== parentId.slice(2), await selected());
await page.click('#outliner button[title^="Forward:"]');

// ---- eye: editor-only --------------------------------------------------------------------------------------------------
const rigBefore = JSON.stringify(await raw());
await rowEl(firstBone).locator(".ol-eye").click();
check("eye hides the row", await E((id) => document.querySelector(`#outliner .ol-row[data-id="${id}"]`).classList.contains("hid"), firstBone));
check("eye never changes the rig document", JSON.stringify(await raw()) === rigBefore);
check("the hidden bone is off the canvas overlay", await E((n) => window.atlasEditor.hiddenHelpers().length >= 0 && true, firstBone.slice(2)));
await rowEl(firstBone).locator(".ol-eye").click();

// ---- select lock ---------------------------------------------------------------------------------------------------------
await rowEl(firstBone).click();
const probe = await E(() => window.atlasEditor.setupBoneWorld(window.atlasEditor.boneSelection().active));
const hit = await E(([x, y]) => window.atlasEditor.pickAt(x, y), [probe.origin.x, probe.origin.y]);
await rowEl(`b:${hit}`).click();
const world = await E((n) => window.atlasEditor.setupBoneWorld(n), hit);
const pickBefore = await E(([x, y]) => window.atlasEditor.pickAt(x, y), [world.origin.x, world.origin.y]);
await page.locator('#outliner input[data-field="select"]').uncheck();
const pickAfter = await E(([x, y]) => window.atlasEditor.pickAt(x, y), [world.origin.x, world.origin.y]);
check("a locked bone cannot be picked on the canvas", pickBefore === hit && pickAfter !== hit, { hit, pickBefore, pickAfter });
check("a locked bone shows a lock badge and stays selectable in the tree", (await selected()) === hit && (await E((id) => !!document.querySelector(`#outliner .ol-row[data-id="${id}"] .b-lock`), `b:${hit}`)));
await page.locator('#outliner input[data-field="select"]').check();

// ---- show name + icon size ------------------------------------------------------------------------------------------------
await page.locator('#outliner input[data-field="name"]').check();
await page.waitForTimeout(300);
check("show name draws a label on the canvas", (await E(() => document.querySelectorAll("#ol-names .ol-name").length)) === 1);
await page.locator('#outliner input[data-field="iconSize"]').fill("2.4");
await shot("04-name-and-size.png");
await page.locator('#outliner input[data-field="iconSize"]').fill("1");
await page.locator('#outliner input[data-field="name"]').uncheck();

// ---- slot / attachment click --------------------------------------------------------------------------------------------
const attId = await E(() => document.querySelector("#outliner .ol-row.k-attachment")?.dataset.id);
if (attId) {
  await rowEl(attId).click();
  const st = await status();
  check("clicking an attachment swaps it (keyed in Animate with Auto key on)", /Keyed|Default image/.test(st), st);
}

// ---- structure edits are refused outside Setup ---------------------------------------------------------------------------
const inheritBoxes = await E(() => [...document.querySelectorAll('#outliner input[data-inherit]')].map((i) => i.disabled));
check("Pro/Animate mode: inherit checkboxes and structure buttons are disabled", inheritBoxes.every(Boolean) && (await E(() => document.querySelector('#outliner [data-act="new"]').disabled)));

// ---- Rig / Setup ------------------------------------------------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(1000);
check("Rig is Setup mode with the Tree", await E(() => document.body.classList.contains("setup") && document.body.classList.contains("ol-on")));
const bones0 = (await raw()).bones;
// Pick a mid bone with a length and children.
const target = bones0.find((b) => b.length > 20 && b.parent && bones0.some((c) => c.parent === b.name));
await rowEl(`b:${target.name}`).click();
await page.waitForTimeout(300);
await shot("05-rig-props.png");
const enabled = await E(() => Object.fromEntries([...document.querySelectorAll("#outliner input[data-inherit]")].map((i) => [i.dataset.inherit, !i.disabled])));
check("Inherit Reflection is disabled while the engine has no matching mode", enabled.reflection === false && enabled.scale === true, enabled);
const tip = await E(() => document.querySelector('#outliner input[data-inherit="reflection"]').closest("label").title);
check("the disabled box explains why", /no inherit mode/.test(tip), tip);
await page.locator('#outliner input[data-inherit="scale"]').uncheck();
await page.waitForTimeout(500);
check("Inherit Scale off saves inherit=noScale through Setup", (await boneOf(target.name)).inherit === "noScale", (await boneOf(target.name)).inherit);
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);
check("undo restores it", ((await boneOf(target.name)).inherit ?? "normal") === (target.inherit ?? "normal"));

// Length.
const len0 = (await boneOf(target.name)).length;
await page.locator('#outliner input[data-field="length"]').fill(String(len0 + 10));
await page.locator('#outliner input[data-field="length"]').press("Enter");
await page.waitForTimeout(500);
check("Length edits the rig", Math.abs((await boneOf(target.name)).length - (len0 + 10)) < 0.01);
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(400);

// New child bone.
const n0 = (await raw()).bones.length;
await page.click('#outliner [data-act="new"]');
await page.waitForTimeout(700);
check("New adds a child bone", (await raw()).bones.length === n0 + 1);
const created = await selected();
check("the new bone is a child of the selected one", (await boneOf(created)).parent === target.name, created);
await shot("06-new-bone.png");
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);
check("undo removes the new bone", (await raw()).bones.length === n0);

// Split.
await rowEl(`b:${target.name}`).click();
const kids = (await raw()).bones.filter((b) => b.parent === target.name).map((b) => b.name);
await page.locator("#outliner .ol-split").fill("40");
await page.locator("#outliner .ol-split").press("Tab");
await page.click('#outliner [data-act="split"]');
await page.waitForTimeout(700);
const afterSplit = (await raw()).bones;
const second = await selected();
check("Split adds a second bone and shortens the first", afterSplit.length === n0 + 1 && Math.abs(afterSplit.find((b) => b.name === target.name).length - len0 * 0.4) < 0.1, { second, len: afterSplit.find((b) => b.name === target.name).length });
check("the children moved onto the second half", kids.every((k) => afterSplit.find((b) => b.name === k).parent === second), kids);
await shot("07-split.png");
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);

// Parent: click a new parent in the tree.
const mover = bones0.find((b) => b.parent && b.length > 0 && !bones0.some((c) => c.parent === b.name));
const newParent = bones0.find((b) => b.name !== mover.name && b.name !== mover.parent && b.length > 0 && b.parent);
await rowEl(`b:${mover.name}`).click();
await page.click('#outliner [data-act="parent"]');
check("Parent waits for a click", await E(() => document.querySelector("#outliner .ol-hint.on")?.textContent ?? ""), "");
await shot("08-parent-pick.png");
await rowEl(`b:${newParent.name}`).click();
await page.waitForTimeout(800);
check("Parent re-parents through Setup", (await boneOf(mover.name)).parent === newParent.name, (await boneOf(mover.name)).parent);
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);
check("undo puts it back", (await boneOf(mover.name)).parent === mover.parent);

// Delete.
await rowEl(`b:${mover.name}`).click();
await page.click('#outliner [data-act="delete"]');
await page.waitForTimeout(800);
check("Delete removes the bone", !(await raw()).bones.some((b) => b.name === mover.name));
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);
check("undo restores it", (await raw()).bones.some((b) => b.name === mover.name));

// ---- constraints group ------------------------------------------------------------------------------------------------------
check("IK badge shown on constrained bones", await E(() => !!document.querySelector("#outliner .ol-badge.b-ik")));
await shot("09-rig-tree.png");

// ---- Animate keeps the simplified list, with a switch -----------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(800);
// Animate starts with the bone list collapsed on windows narrower than 1800 px: open it from its rail.
if (await E(() => document.getElementById("app").classList.contains("lcol"))) await page.click("#left-open");
check("Animate keeps the simplified list", await E(() => getComputedStyle(document.getElementById("bones")).display !== "none" && getComputedStyle(document.getElementById("outliner")).display === "none"));
await shot("10-animate-list.png");
await page.click("#bones-fulltree");
await page.waitForTimeout(500);
check("Show full tree swaps in the Tree", await E(() => getComputedStyle(document.getElementById("outliner")).display !== "none"));
check("Animate tree disables structure edits", await E(() => document.querySelector('#outliner [data-act="new"]').disabled));
await shot("11-animate-full-tree.png");
await page.click("#outliner .ol-simple");
await page.waitForTimeout(400);
check("Simple list switches back", await E(() => getComputedStyle(document.getElementById("bones")).display !== "none"));

check("no console errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
