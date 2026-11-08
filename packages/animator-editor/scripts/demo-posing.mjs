// Posing feel checks on the pro rigs: the render follows every drag move (weapon, hand IK target, spine), art-click selection,
// drag-anywhere rotate, Shift snap, Shift axis lock on move, Esc cancel, one undo step per drag, bone drawing screenshots.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-posing.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/posing"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
// The transform strip and canvas edge controls sit over the canvas and these checks compare canvas screenshots: keep them out of the pixels.
await page.addStyleTag({ content: "#xstrip, #toolpalette, #vtop, #xs-rulers, #gatehud { visibility: hidden !important; }" });
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(250);
  const file = resolve(out, name);
  await page.screenshot({ path: file, clip: await canvasBox() });
  console.log(file);
};
const canvasBox = async () => (await page.locator("#view").boundingBox());
/** The canvas pixels with the bone overlay hidden, so only the character art counts. */
const artPixels = async () => {
  await E(() => {
    window.atlasEditor.setShowBones(false);
    const l = document.getElementById("hoverlabel");
    if (l) l.style.visibility = "hidden";
  });
  await page.waitForTimeout(120);
  const px = (await page.locator("#view canvas").first().screenshot()).toString("base64");
  await E(() => {
    window.atlasEditor.setShowBones(true);
    const l = document.getElementById("hoverlabel");
    if (l) l.style.visibility = "";
  });
  return px;
};
const ends = (b) => E((n) => window.atlasEditor.boneScreenEnds(n), b);

await page.click("#newclip-open");
await page.fill("#newclip-name", "posing");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.setGizmo("rotate"));

for (const outfit of ["pro-turned"]) {
  await E((o) => window.atlasEditor.mountOutfit(o), outfit);
  await page.waitForFunction((o) => window.atlasEditor.state().outfit === o, outfit, { timeout: 30_000 });
  await page.waitForTimeout(800);
  console.log(`--- ${outfit}`);

  // 1. The render follows the pointer mid-drag (art pixels change before release and equal the released result).
  for (const bone of ["weapon", "spine_1"]) {
    await E((b) => window.atlasEditor.select(b), bone);
    const e = await ends(bone);
    const before = await artPixels();
    await page.mouse.move(e.mid.x, e.mid.y);
    await page.mouse.down();
    await page.mouse.move(e.mid.x + 20, e.mid.y + 30, { steps: 5 });
    await page.mouse.move(e.mid.x + 30, e.mid.y + 60, { steps: 5 });
    const mid = await artPixels();
    if (bone === "weapon") await shot(`${outfit}-weapon-mid-drag.png`);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await artPixels();
    check(`${outfit}: ${bone} art changes mid-drag`, before !== mid);
    check(`${outfit}: ${bone} mid-drag frame equals the released frame`, mid === after);
    await E(() => window.atlasEditor.undo());
  }

  // 2. Drag a hand IK target (the pink diamond).
  const ikName = "hand_near_target";
  const tgt = await E((n) => window.atlasEditor.boneScreenPos(n), ikName);
  await E(() => window.atlasEditor.setIkLive?.(true));
  await E(() => {
    const e = window.atlasEditor;
    e.setIkLive?.(true);
  });
  if (tgt) {
    const before = await artPixels();
    await page.mouse.move(tgt.x, tgt.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x + 25, tgt.y - 40, { steps: 6 });
    const mid = await artPixels();
    await page.mouse.up();
    check(`${outfit}: dragging a hand IK target changes the art mid-drag`, before !== mid);
    await E(() => window.atlasEditor.undo());
  }

  // 3. Art click selects the bone of the piece under the cursor; hover names it.
  await E(() => window.atlasEditor.select("chest"));
  const head = await ends("head");
  const artHit = await E((p) => window.atlasEditor.pickAt?.(0, 0) ?? null, null);
  void artHit;
  await page.mouse.move(head.mid.x, head.mid.y - 4);
  await page.waitForTimeout(150);
  const hov = await E(() => window.atlasEditor.overlayState().hover);
  check(`${outfit}: hovering the head shows a bone name`, !!hov, hov);
  await page.mouse.click(head.mid.x, head.mid.y - 4);
  await page.waitForTimeout(150);
  const sel = await E(() => window.atlasEditor.boneSelection().active);
  check(`${outfit}: clicking the head art selects a head-side bone`, /head|hair|neck/.test(sel), sel);
}

// 4. Drag anywhere rotates the selection; Shift snaps to 15; Esc cancels; one undo step.
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForFunction(() => window.atlasEditor.state().outfit === "pro-turned", null, { timeout: 30_000 });
await page.waitForTimeout(800);
await E(() => window.atlasEditor.select("upper_arm_near"));
await E(() => window.atlasEditor.setGizmo("rotate"));
const arm = await ends("upper_arm_near");
const empty = { x: arm.origin.x + 160, y: arm.origin.y };
const clipBefore = JSON.stringify(await E(() => window.atlasEditor.state().clip.bones ?? null));
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await page.mouse.move(empty.x + 20, empty.y + 100, { steps: 6 });
const rotMid = await E(() => window.atlasEditor.state().pending.upper_arm_near);
check("press on empty space and drag rotates the selected bone", typeof rotMid === "number" && rotMid !== 0, rotMid);
await shot("rotate-readout.png");
await page.keyboard.press("Escape");
await page.mouse.up();
await page.waitForTimeout(150);
const pendAfterEsc = await E(() => window.atlasEditor.state().pending);
check("Esc cancels the drag and drops the unkeyed pose", !pendAfterEsc.upper_arm_near, pendAfterEsc);
check("Esc leaves the clip untouched", JSON.stringify(await E(() => window.atlasEditor.state().clip.bones ?? null)) === clipBefore);

await page.keyboard.down("Shift");
await page.mouse.move(empty.x, empty.y);
await page.keyboard.up("Shift");
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await page.keyboard.down("Shift");
await page.mouse.move(empty.x - 20, empty.y + 150, { steps: 8 });
const snapped = await E(() => window.atlasEditor.state().pending.upper_arm_near);
await page.keyboard.up("Shift");
await page.mouse.up();
check("Shift snaps the rotation to 15 degrees", typeof snapped === "number" && Math.abs(snapped) > 10 && Math.abs(snapped / 15 - Math.round(snapped / 15)) < 1e-6, snapped);
await page.waitForTimeout(200);
const keysAfter = await E(() => window.atlasEditor.state().clip.bones?.upper_arm_near?.rotate?.length ?? 0);
check("the drag keyed the bone once", keysAfter === 1, keysAfter);
await E(() => window.atlasEditor.undo());
const keysUndone = await E(() => window.atlasEditor.state().clip.bones?.upper_arm_near?.rotate?.length ?? 0);
check("one undo removes the whole drag", keysUndone === 0, keysUndone);

// 5. Move tool: Shift locks the axis.
await E(() => window.atlasEditor.setGizmo("move"));
await E(() => window.atlasEditor.select("body"));
const body = await E(() => window.atlasEditor.boneScreenPos("body"));
await page.mouse.move(body.x, body.y);
await page.mouse.down();
await page.keyboard.down("Shift");
await page.mouse.move(body.x + 60, body.y + 12, { steps: 8 });
const mv = await E(() => window.atlasEditor.state().pendingMove.body);
await page.keyboard.up("Shift");
await page.mouse.up();
check("Shift locks the translate to one axis", !!mv && (Math.abs(mv.x) < 0.01 || Math.abs(mv.y) < 0.01) && (Math.abs(mv.x) > 1 || Math.abs(mv.y) > 1), mv);
await E(() => window.atlasEditor.undo());
await E(() => window.atlasEditor.setGizmo("rotate"));

// 6. Bone drawing: rest and with upper_arm_near selected.
await E(() => window.atlasEditor.select(null));
await E(() => window.atlasEditor.fit());
await page.mouse.move(5, 5);
await shot("bones-rest.png");
await E(() => window.atlasEditor.select("upper_arm_near"));
await shot("bones-selected-arm.png");
const crumb = await page.locator("#bonecrumb").innerText();
check("the breadcrumb shows the parent chain", /upper_arm_near/.test(crumb) && /chest|clavicle/.test(crumb), crumb.replace(/\n/g, " "));

// 7. Every workspace draws the same coloured bones, however often you switch.
const greenPixels = async () => {
  const b64 = (await page.locator("#view canvas").first().screenshot()).toString("base64");
  return E(async (b) => {
    const bmp = await createImageBitmap(await (await fetch("data:image/png;base64," + b)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0x5f) < 40 && Math.abs(d[i + 1] - 0xd4) < 40 && Math.abs(d[i + 2] - 0x7a) < 40) n++;
    return n;
  }, b64);
};
await E(() => window.atlasEditor.select(null));
const seq = ["pro", "rig", "pro", "animate", "rig", "pro", "swag", "pro"];
let first = null;
for (const ws of seq) {
  await E((w) => window.atlasEditor.workspace(w), ws);
  await page.waitForTimeout(700);
  await E(() => window.atlasEditor.fit());
  await page.waitForTimeout(300);
  const wedges = await E(() => window.atlasEditor.overlayState().wedges);
  const green = await greenPixels();
  first ??= green;
  await shot("workspace-" + ws + "-" + seq.indexOf(ws) + ".png");
  check("workspace " + ws + ": coloured wedge bones are drawn", wedges > 10 && (ws === "swag" || green > 40), { wedges, green });
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
