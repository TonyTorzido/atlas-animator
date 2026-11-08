// Batch 4 probe + screenshots (Rig lists, tree interactions, images dock). Starts its own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch4.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b4"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  const Stub = function (u, p) {
    if (String(p ?? "").includes("vite")) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
    return new Real(u, p);
  };
  Stub.prototype = Real.prototype;
  Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Stub;
});
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, name) });
};
const raw = () => E(() => window.atlasEditor.setupRaw());
const edits = () => E(() => window.atlasEditor.setupState().undoable);
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(800);
await E(() => window.atlasEditor.showTab("rig"));
await page.waitForTimeout(500);

// 1. rows have eye + lock columns
const lockCount = await E(() => document.querySelectorAll("#outliner .ol-row.k-bone .ol-lock").length);
check("lock column on bone rows", lockCount > 5, lockCount);
await E(() => window.atlasEditor.select("chest"));
await page.waitForTimeout(400);
await shot("01-tree-lock-column.png");

// 2. bone context menu
await page.locator('#outliner .ol-row[data-id="b:chest"]').click({ button: "right" });
await page.waitForTimeout(300);
const items = await E(() => [...document.querySelectorAll(".ctxmenu [role=menuitem], .ctxmenu button")].map((b) => b.textContent.trim()));
check("bone menu items", ["Rename", "Delete", "Select children", "New child bone", "New slot", "Add IK"].every((w) => items.some((i) => i.startsWith(w))), items);
await shot("02-bone-context-menu.png");
await page.keyboard.press("Escape");

// 3. slot menu + attachment menu
const slotRow = page.locator("#outliner .ol-row.k-slot").first();
await slotRow.click({ button: "right" });
await page.waitForTimeout(300);
const sitems = await E(() => [...document.querySelectorAll(".ctxmenu button")].map((b) => b.textContent.trim()));
check("slot menu items", sitems.some((i) => i.startsWith("Rename")) && sitems.some((i) => i.startsWith("Attach image")), sitems);
await page.keyboard.press("Escape");

// 4. Images dock
await page.click("#idk-tab-images");
await page.waitForTimeout(2500);
const thumbs = await E(() => [...document.querySelectorAll("#idk-thumbs .idk-th img")].filter((i) => i.naturalWidth > 0).length);
check("images dock thumbnails with naturalWidth > 0", thumbs >= 100, thumbs);
await shot("03-images-dock.png");
await page.fill("#idk-search", "head");
await page.waitForTimeout(1500);
const filtered = await E(() => document.querySelectorAll("#idk-thumbs .idk-th").length);
check("search filters", filtered > 0 && filtered < thumbs, filtered);
await shot("04-images-dock-search.png");
await page.fill("#idk-search", "");
await page.waitForTimeout(600);

// 5. drag a thumbnail onto a slot row
const slotName = await E(() => window.atlasEditor.setupRaw().slots.find((s) => s.name.startsWith("skin_hand"))?.name ?? window.atlasEditor.setupRaw().slots[3].name);
const before = await raw();
const att0 = Object.keys(before.skins[Object.keys(before.skins)[0]].attachments[slotName] ?? {}).length;
await E(() => document.querySelector("#outliner .ol-row.k-slot")?.scrollIntoView());
const target = page.locator(`#outliner .ol-row[data-id="s:${slotName}"]`);
const n0 = await edits();
if (await target.count()) {
  await page.locator("#idk-thumbs .idk-th").nth(3).dragTo(target);
  await page.waitForTimeout(800);
  const after = await raw();
  const att1 = Object.keys(after.skins[Object.keys(after.skins)[0]].attachments[slotName] ?? {}).length;
  check("thumbnail dropped on a slot row attaches", att1 === att0 + 1 && (await edits()) === n0 + 1, { att0, att1 });
} else check("slot row visible for the drop", false, slotName);
await shot("05-attached.png");

// 6. multi-bone rotate: shift-select two bones in the tree, rotate drag
await page.click("#idk-fold");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.setupTool("rotate"));
const pair = ["chest", "upper_arm_near"];
await E((p) => window.atlasEditor.selectBones(p, "replace", p[0]), pair);
await page.waitForTimeout(400);
const sel = await E(() => window.atlasEditor.boneSelection?.() ?? window.atlasEditor.state().selection);
const rot0 = Object.fromEntries((await raw()).bones.filter((b) => pair.includes(b.name)).map((b) => [b.name, b.rotation ?? 0]));
const ends = await E((b) => window.atlasEditor.boneScreenEnds(b), pair[0]);
const nA = await edits();
const at = (a) => [ends.origin.x + 260 * Math.cos(a), ends.origin.y + 260 * Math.sin(a)];
await page.mouse.move(...at(Math.PI));
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(...at(Math.PI + (0.9 * i) / 10));
await page.mouse.up();
await page.waitForTimeout(800);
const rot1 = Object.fromEntries((await raw()).bones.filter((b) => pair.includes(b.name)).map((b) => [b.name, b.rotation ?? 0]));
check("rotate changes both selected bones", pair.every((n) => Math.abs(rot1[n] - rot0[n]) > 0.5), { pair, sel, rot0, rot1 });
check("one undo step", (await edits()) === nA + 1, { nA, now: await edits() });
await shot("06-multi-rotate.png");
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);
const rot2 = Object.fromEntries((await raw()).bones.filter((b) => pair.includes(b.name)).map((b) => [b.name, b.rotation ?? 0]));
check("one Ctrl+Z reverts both", pair.every((n) => Math.abs(rot2[n] - rot0[n]) < 0.01), { rot2 });

// 7. delete confirm
await page.locator(`#outliner .ol-row[data-id="b:${pair[0]}"]`).click();
const nBones = (await raw()).bones.length;
await page.locator("#outliner .ol-btn[data-act=delete]").click();
await page.waitForTimeout(400);
const dlg = await E(() => document.querySelector("#delete-bones-dialog")?.textContent ?? "");
check("delete opens a confirm", /Delete/.test(dlg), dlg.slice(0, 120));
await shot("07-delete-confirm.png");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
check("Enter deletes", (await raw()).bones.length === nBones - 1);
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);
check("Ctrl+Z restores", (await raw()).bones.length === nBones);

// 8. lock hides from picking
await E(() => window.atlasEditor.setupTool("select"));
console.log(errors.length ? `ERRORS ${JSON.stringify(errors.slice(0, 5))}` : "no page errors");
await browser.close();
process.exit(failed ? 1 : 0);
