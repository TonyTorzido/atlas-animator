// Demo of Setup mode (standard rig building) on the "Straight front (pro)" rig, with screenshots:
// switch to Setup, drag out a new bone, attach an image (an imported PNG), place it, tweak an IK bend, then show
// that the clip still poses the same in Animate mode. Nothing is saved to disk (no Save click).
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/setup-demo.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/setup"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor?.setMode, null, { timeout: 60_000 });
await page.waitForTimeout(800);
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(600);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const settle = async () => {
  await page.waitForFunction(() => !window.atlasEditor.setupState().busy, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
};
const dragView = async (from, to) => {
  const a = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), from);
  const b = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await settle();
};

await E(() => window.atlasEditor.fit());
const clipBefore = await E(() => JSON.stringify(window.atlasEditor.state().clip));
const poseBefore = await E(() => {
  const sk = window.atlasEditor.debug().skeleton;
  window.atlasEditor.setTime(0);
  return sk.getBone("hand_near").world.x;
});

// 1. Switch to Setup mode, select a bone.
await page.click('#modeseg button[data-mode="setup"]');
await settle();
await E(() => window.atlasEditor.select("head"));
await page.mouse.move(700, 500);
await page.mouse.wheel(0, 260); // zoom out a little so the new parts have room
await page.waitForTimeout(300);
check("Setup mode is on", (await E(() => window.atlasEditor.mode())) === "setup");
await shot("setup-1-mode.png");

// 2. Create a bone by click-drag from the selected parent (the head): an antenna going up and to the right.
await page.click('#toolpalette [data-tool="bone"]');
const head = await E(() => window.atlasEditor.setupBoneWorld("head"));
const bonesBefore = await E(() => window.atlasEditor.setupRaw().bones.length);
await dragView([head.tip.x + 40, head.tip.y + 30], [head.tip.x + 110, head.tip.y - 110]);
const afterAdd = await E(() => {
  const raw = window.atlasEditor.setupRaw();
  return { count: raw.bones.length, last: raw.bones.find((b) => b.name === "bone"), selected: window.atlasEditor.state().selected };
});
check("a bone was added under the selected head", afterAdd.count === bonesBefore + 1 && afterAdd.last?.parent === "head", afterAdd.last);
await E(() => window.atlasEditor.setupRename("bone", "antenna"));
await settle();
check("rename keeps the selection on the bone", (await E(() => window.atlasEditor.state().selected)) === "antenna");
await shot("setup-2-add-bone.png");

// 3. Attach an image: a generated badge PNG, imported as a new slot on the antenna, made the default.
const png = await E(() => {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const g = c.getContext("2d");
  g.translate(48, 48);
  g.fillStyle = "#f0b84a";
  g.strokeStyle = "#5a3b00";
  g.lineWidth = 5;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 20 : 44;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.stroke();
  return c.toDataURL("image/png");
});
const attached = await E((dataUrl) => window.atlasEditor.setupAttachPng(dataUrl, { slot: null, bone: "antenna", name: "badge" }), png);
await settle();
check("the imported image is attached to a new slot with a region attachment", attached === true && (await E(() => {
  const raw = window.atlasEditor.setupRaw();
  const slot = raw.slots.find((s) => s.name === "badge");
  return slot?.bone === "antenna" && slot.attachment === "badge" && raw.skins.body.attachments.badge.badge.type === "region" && raw.atlas.pages.some((p) => p.includes("imp-badge"));
})));
await page.click('#toolpalette [data-tool="attachment"]');
await settle();
// Move the image to the antenna tip, then drag the corner handle to scale it and the top handle to rotate it.
const tip = await E(() => window.atlasEditor.setupBoneWorld("antenna"));
let h = await E(() => window.atlasEditor.setupImageHandles());
await dragView([h.centre.x, h.centre.y], [tip.tip.x, tip.tip.y]);
h = await E(() => window.atlasEditor.setupImageHandles());
await dragView([h.scale.x, h.scale.y], [h.scale.x - 30, h.scale.y + 30]);
h = await E(() => window.atlasEditor.setupImageHandles());
await dragView([h.rotate.x, h.rotate.y], [h.rotate.x + 60, h.rotate.y + 20]);
const placed = await E(() => window.atlasEditor.setupRaw().skins.body.attachments.badge.badge);
check("the image was moved, scaled and rotated relative to its bone", placed.x !== undefined && placed.x !== 0 && placed.scaleX !== undefined && placed.scaleX !== 1 && placed.rotation !== undefined && placed.rotation !== 0, placed);
await shot("setup-3-attach-image.png");

// 3b. Re-parent by dragging the bone onto another in the tree (it keeps its place in the world), then edit its
// setup transform with and without "keep images", and delete a child bone.
const antBefore = await E(() => window.atlasEditor.setupBoneWorld("hair_2"));
// The bone tree is the outliner now (#bones is hidden under it): one .ol-row per bone, the name in .ol-label.
await E(() => document.querySelector("#outliner .ol-ic[title='Expand every row']")?.click());
const olRow = (name) => page.locator("#outliner .ol-row", { has: page.locator(".ol-label", { hasText: new RegExp(`^${name}$`) }) }).first();
const antRow = olRow("hair_2");
await antRow.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const rowTarget = olRow("chest");
// The tree re-parents with the Parent button: select the bone, press Parent, click its new parent row.
await antRow.click();
await page.click("#outliner .ol-btn[data-act='parent'], #outliner button:has-text('Parent')");
await rowTarget.click();
await settle();
const antAfter = await E(() => window.atlasEditor.setupBoneWorld("hair_2"));
check("picking a new parent in the tree (Parent button, then the row) re-parents it and keeps its world position", (await E(() => window.atlasEditor.setupRaw().bones.find((b) => b.name === "hair_2").parent)) === "chest" && Math.hypot(antBefore.origin.x - antAfter.origin.x, antBefore.origin.y - antAfter.origin.y) < 0.1, { antBefore, antAfter });
await E(() => window.atlasEditor.setupReparent("hair_2", "hair_1"));
await settle();
const badgeBefore = await E(() => window.atlasEditor.setupImageHandles().centre);
await E(() => window.atlasEditor.setupTransform("antenna", { rotation: 40 }, true));
await settle();
const badgeKept = await E(() => window.atlasEditor.setupImageHandles().centre);
await E(() => window.atlasEditor.setupTransform("antenna", { rotation: 10 }, false));
await settle();
const badgeFollowed = await E(() => window.atlasEditor.setupImageHandles().centre);
check("keep images leaves the image in place; without it the image follows the bone", Math.hypot(badgeBefore.x - badgeKept.x, badgeBefore.y - badgeKept.y) < 0.5 && Math.hypot(badgeKept.x - badgeFollowed.x, badgeKept.y - badgeFollowed.y) > 5, { badgeBefore, badgeKept, badgeFollowed });
const tip2 = await E(() => window.atlasEditor.setupBoneWorld("antenna"));
await E((t) => window.atlasEditor.setupAddBone({ parent: "antenna", from: [t.tip.x, t.tip.y], to: [t.tip.x + 40, t.tip.y - 40], name: "spur" }), tip2);
await settle();
await E(() => window.atlasEditor.select("spur"));
await page.click("#setup-delete");
await settle();
check("delete bone removes it", !(await E(() => window.atlasEditor.setupRaw().bones.some((b) => b.name === "spur"))));

// 4. Tweak an IK bend: let the near arm's IK drive the elbow (mix 1), then flip its bend from the constraints panel.
await page.click('#toolpalette [data-tool="select"]');
await E(() => window.atlasEditor.select("forearm_near"));
await page.fill('#setuppanel input.ikmix[data-ik="hand_ik_near"]', "1");
await page.press('#setuppanel input.ikmix[data-ik="hand_ik_near"]', "Enter");
await settle();
// Lift the IK target (a setup transform edit of its bone) so the arm has a bend to flip.
await E(async () => {
  const t = window.atlasEditor.setupRaw().bones.find((b) => b.name === "hand_near_target");
  await window.atlasEditor.setupTransform("hand_near_target", { y: (t.y ?? 0) - 110, x: (t.x ?? 0) + 40 }, false);
});
await settle();
const showBend = () => page.evaluate(() => document.querySelector('#setuppanel button.bend[data-ik="hand_ik_near"]').scrollIntoView({ block: "center" }));
await showBend();
const elbow = () => E(() => {
  const b = window.atlasEditor.debug().skeleton.getBone("forearm_near");
  return [Math.round(b.world.x * 10) / 10, Math.round(b.world.y * 10) / 10];
});
const elbowBefore = await elbow();
await shot("setup-4a-ik-before.png");
const bendBefore = await E(() => window.atlasEditor.setupRaw().ik.find((c) => c.name === "hand_ik_near").bendPositive ?? true);
await page.click('#setuppanel button.bend[data-ik="hand_ik_near"]');
await settle();
const bendAfter = await E(() => window.atlasEditor.setupRaw().ik.find((c) => c.name === "hand_ik_near").bendPositive ?? true);
const elbowAfter = await elbow();
check("the IK bend flipped through the command log and the elbow moved", bendBefore !== bendAfter && JSON.stringify(elbowBefore) !== JSON.stringify(elbowAfter), { bendBefore, bendAfter, elbowBefore, elbowAfter });
await showBend();
await shot("setup-4b-ik-after.png");

// 5. Undo everything, redo it, then back to Animate: the clip still poses the same.
const edits = await E(() => window.atlasEditor.setupState().edits);
check("every edit is on the undo stack", edits.length >= 12, edits);
const rawEdited = await E(() => JSON.stringify(window.atlasEditor.setupRaw()));
for (let i = 0; i < edits.length; i++) {
  await E(() => window.atlasEditor.setupUndo());
  await settle();
}
const rawUndone = await E(() => window.atlasEditor.setupRaw());
check("undoing all edits restores the bone list", rawUndone.bones.length === bonesBefore && !rawUndone.slots.some((s) => s.name === "badge"));
check("undoing all edits restores the pose", Math.abs((await E(() => window.atlasEditor.debug().skeleton.getBone("hand_near").world.x)) - poseBefore) < 1e-6);
for (let i = 0; i < edits.length; i++) {
  await E(() => window.atlasEditor.setupRedo());
  await settle();
}
check("redo restores the edited rig exactly", (await E(() => JSON.stringify(window.atlasEditor.setupRaw()))) === rawEdited);
const poseEdited = await E(() => window.atlasEditor.debug().skeleton.getBone("hand_near").world.x);
await page.click('#modeseg button[data-mode="animate"]');
await settle();
const clipAfter = await E(() => JSON.stringify(window.atlasEditor.state().clip));
const poseAfter = await E(() => {
  window.atlasEditor.setTime(0);
  return window.atlasEditor.debug().skeleton.getBone("hand_near").world.x;
});
check("the clip is unchanged and still poses the edited rig (the IK edits moved the hand)", clipBefore === clipAfter && Math.abs(poseEdited - poseAfter) < 1e-6 && Math.abs(poseAfter - poseBefore) > 1, { poseBefore, poseEdited, poseAfter });
await shot("setup-5-animate-after.png");

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
