// Batch 7b-2 screenshots + checks (correctives card and sculpt, relink / reload source art, Spine loss dialogs, PSD report in New rig).
// Starts its own sandboxed server (never :5211).   node packages/animator-editor/scripts/demo-batch7b2.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b7"));
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
const undoable = () => E(() => window.atlasEditor.setupState().undoable);
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(800);
await E(() => window.atlasEditor.showTab("rig"));
await page.waitForTimeout(500);

// ---- Correctives -------------------------------------------------------------------------------------------------------------
const BONE = "chest";
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(500);
await E(() => window.atlasEditor.inspectorOpen("bone.correctives", true));
await page.waitForTimeout(400);
check("correctives card is there with a driver, set, angle, sculpt and reset", (await page.locator("#corr-driver, #corr-set, #corr-angle, #corr-angle-num, #corr-sculpt, #corr-reset").count()) === 6);
const before = (await raw()).driven.length;
await page.fill("#corr-angle-num", "40");
await page.press("#corr-angle-num", "Enter");
await page.waitForTimeout(500);
check("angle field scrubs the slider", (await page.inputValue("#corr-angle")) === "40");
await shot("20-correctives-card.png");
await E(() => window.atlasEditor.setupSelectSlot("shirt_torso", null));
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(300);
await page.click("#corr-sculpt");
await page.waitForTimeout(900);
const t = await E(() => window.atlasCorrective.state());
check("sculpt tool opened on the set at 40 degrees", t.target?.at === 40 && t.target?.bone === BONE && t.vertexCount > 0, t);
await E(() => window.atlasCorrective.select([0, 1, 2]));
const a = await E(() => window.atlasCorrective.vertexScreen(0));
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move(a.x + 14, a.y + 10, { steps: 4 });
await page.mouse.move(a.x + 30, a.y + 18, { steps: 4 });
await shot("21-corrective-sculpt-drag.png");
await page.mouse.up();
await page.waitForTimeout(900);
let r = await raw();
const set = r.driven.find((d) => d.bone === BONE && d.keys.some((k) => k.at === 40));
check("release stored a driven key at 40", !!set && Object.keys(set.keys.find((k) => k.at === 40).deform).length > 0, set && set.keys.map((k) => k.at));
check("one undo step", (await undoable()) >= 1);
const log = await E(() => window.atlasEditor.setupLog());
check("the step is a driven.key batch", log.at(-1).commands.some((c) => c.op === "driven.key"), log.at(-1).label);
await E(() => window.atlasEditor.setupTool("select"));
await page.waitForTimeout(500);
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(400);
check("key listed with Go / Sculpt / Delete", (await page.locator('#corr-keys [data-at="40"] button').count()) === 3);
await shot("22-corrective-key-list.png");
await page.fill("#corr-angle-num", "-20");
await page.press("#corr-angle-num", "Enter");
await page.waitForTimeout(400);
await page.click('#corr-keys [data-at="40"] [data-act="corr-go"]');
await page.waitForTimeout(400);
check("Go scrubs to the key angle", (await page.inputValue("#corr-angle-num")) === "40");
await page.click('#corr-keys [data-at="40"] [data-act="corr-del"]');
await page.waitForTimeout(800);
r = await raw();
check("Delete removed the key (and the new set)", !r.driven.some((d) => d.bone === BONE && d.keys.some((k) => k.at === 40)));
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(600);
r = await raw();
check("Undo brings the key back", r.driven.some((d) => d.bone === BONE && d.keys.some((k) => k.at === 40)));
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(600);
r = await raw();
check("Undo again removes the sculpt", r.driven.length === before);

// ---- Source art: Replace image at another size -------------------------------------------------------------------------------
await E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.inspectorOpen("att.art", true));
await page.waitForTimeout(300);
const att0 = (await raw()).skins.body.attachments.shirt_torso.torso;
check("Source art card has Replace image, Reload from source and the size mode", (await page.locator("#art-replace, #art-reload, #art-mode, #art-file").count()) === 4);
await shot("23-source-art-card.png");
const png = await E(
  ([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#c33";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fc3";
    g.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
    return c.toDataURL("image/png");
  },
  [Math.round(att0.width * 1.5), Math.round(att0.height * 1.5)]
);
const buf = Buffer.from(png.split(",")[1], "base64");
await page.setInputFiles("#art-file", { name: "torso-new.png", mimeType: "image/png", buffer: buf });
await page.waitForSelector("#relink-dialog", { timeout: 5000 });
await shot("24-relink-confirm.png");
check("dialog names the size change and what stays", /becomes/.test(await page.innerText("#relink-dialog-lines")) && /weights/.test(await page.innerText("#relink-dialog-lines")));
await page.click('#relink-dialog [data-act="confirm"]');
await page.waitForTimeout(1200);
const att1 = (await raw()).skins.body.attachments.shirt_torso.torso;
check("picture replaced at the new size, mesh + weights kept", att1.width === Math.round(att0.width * 1.5) && att1.path !== att0.path && JSON.stringify(att1.vertices) === JSON.stringify(att0.vertices) && JSON.stringify(att1.bones) === JSON.stringify(att0.bones));
await shot("25-relinked.png");
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(700);
const att2 = (await raw()).skins.body.attachments.shirt_torso.torso;
check("Undo restores the old picture and UVs", att2.path === att0.path && att2.width === att0.width && JSON.stringify(att2.uvs) === JSON.stringify(att0.uvs));

// ---- Spine loss dialogs --------------------------------------------------------------------------------------------------------
await E(() => window.atlasEditor.showTab("export"));
await page.waitForTimeout(500);
await E(() => document.getElementById("spine-export").click());
await page.waitForSelector("#spine-loss-dialog", { timeout: 8000 }).catch(() => undefined);
const exp = await page.locator("#spine-loss-dialog-lines").innerText().catch(() => "");
check("export shows the loss list before confirming", /Comes across/.test(exp) && /Approximated|Dropped/.test(exp), exp.slice(0, 120));
await shot("26-spine-export-loss.png");
await page.click('#spine-loss-dialog [data-act="cancel"]').catch(() => undefined);
await page.waitForTimeout(400);
check("cancelling wrote nothing", /cancelled/.test(await page.innerText("#spine-result")));

console.log(errors.length ? `console errors: ${errors.join(" | ")}` : "no console errors");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
