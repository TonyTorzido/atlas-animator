// Demo of Phone preview: the editor's "Phone preview" button, the QR popover, and a second, mobile-emulated page that opens the
// phone URL, renders the character, follows an editor edit within 2 s, and is refused without the token. Sandboxed (own Vite server,
// own data dir; the LAN server binds a free port). Screenshots go to the out dir.
//   node packages/animator-editor/scripts/demo-phonelive.mjs [outDir]
// The QR picture is also decoded with OpenCV when python + cv2 are installed (an independent check of the encoder).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/phonelive"));
mkdirSync(out, { recursive: true });
const { url } = await demoServer(undefined);

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const page = revealTabs(await browser.newPage({ viewport: { width: 1500, height: 1000 } }));
page.on("pageerror", (e) => errors.push(`editor: ${e}`));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(800);
const E = (fn, arg) => page.evaluate(fn, arg);

// A clip with a visible swing.
await page.click("#newclip-open");
await page.fill("#newclip-name", "phone_chop");
await page.click("#newclip-make");
await page.waitForTimeout(200);
const poseKeys = (spec) =>
  E((spec) => {
    const e = window.atlasEditor;
    for (const [f, vals] of spec) {
      e.setTime(f / 30);
      for (const [bone, v] of Object.entries(vals)) {
        e.select(bone);
        e.rotate(bone, v);
        e.key();
      }
    }
    e.setTime(0);
  }, spec);
await poseKeys([
  [0, { upper_arm_near: 0, forearm_near: 0, chest: 0 }],
  [8, { upper_arm_near: -70, forearm_near: -30, chest: 8 }],
  [14, { upper_arm_near: 60, forearm_near: 10, chest: -10 }],
  [28, { upper_arm_near: 0, forearm_near: 0, chest: 0 }]
]);

// 1. The button starts the LAN server and shows the QR popover.
check("the Phone preview button is in the header", await page.locator("#phonebtn").isVisible());
const statusBefore = await (await fetch(new URL("api/phone/status", url))).json();
check("off by default (no LAN server before the button)", statusBefore.running === false, statusBefore);
await page.click("#phonebtn");
await page.waitForSelector("#phonepop .qr svg", { timeout: 15_000 });
const phoneUrl = (await page.locator("#phonepop .url").innerText()).split("\n")[0].trim();
check("the popover shows a /phone/<token>/ URL", /^http:\/\/[\d.]+:\d+\/phone\/[0-9a-f]{32}\/$/.test(phoneUrl), phoneUrl);
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(out, "01-editor-popover.png") });
const qrFile = resolve(out, "qr.png");
await page.locator("#phonepop .qr").screenshot({ path: qrFile });
// OpenCV's detector is picky about module size, so it tries a few scales and both of its detectors (every code in a 300-code sweep decoded).
const py = [
  "import cv2,sys",
  "img=cv2.imread(sys.argv[1],0)",
  "for f in (3,4,6,8):",
  "  im=cv2.resize(img,None,fx=f,fy=f,interpolation=cv2.INTER_NEAREST)",
  "  for d in (cv2.QRCodeDetector(),cv2.QRCodeDetectorAruco()):",
  "    t=d.detectAndDecode(im)[0]",
  "    if t:",
  "      print(t);sys.exit(0)",
  "print('')"
].join(String.fromCharCode(10));
const decoded = spawnSync("python", ["-c", py, qrFile], { encoding: "utf8" });
if (decoded.status === 0) check("OpenCV decodes the QR picture to the URL", decoded.stdout.trim() === phoneUrl, { decoded: decoded.stdout.trim() });
else console.log("SKIP OpenCV QR decode (python/cv2 unavailable)");

// 2. The phone: a second page, mobile emulation, real game size.
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const phone = await phoneCtx.newPage();
phone.on("pageerror", (e) => errors.push(`phone: ${e}`));
phone.on("console", (m) => m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(`phone console: ${m.text()}`));
await phone.goto(phoneUrl);
await phone.waitForFunction(() => window.atlasPhone?.info().hasCharacter, null, { timeout: 60_000 });
await phone.waitForTimeout(1200);
let info = await phone.evaluate(() => window.atlasPhone.info());
check("the phone renders the character at the project scale 0.4", info.hasCharacter && Math.abs(Math.abs(info.scaleX) - 0.4) < 1e-6 && info.missing === 0, { scaleX: info.scaleX, missing: info.missing });
check("the character has a real on-screen size (CSS px)", info.bounds.maxX - info.bounds.minX > 40 && info.bounds.maxY - info.bounds.minY > 250 && info.bounds.maxY - info.bounds.minY < 520, info.bounds);
check("the phone shows the editor's clip", info.clipName === "phone_chop", info.clipName);
await phone.screenshot({ path: resolve(out, "02-phone-initial.png") });

// 3. An editor edit reaches the phone within 2 s.
const sig0 = info.clipSig;
const t0 = Date.now();
await poseKeys([[20, { upper_arm_near: 95, forearm_near: 40, chest: -20 }]]);
let seen = -1;
while (Date.now() - t0 < 6000) {
  if ((await phone.evaluate(() => window.atlasPhone.info().clipSig)) !== sig0) {
    seen = Date.now() - t0;
    break;
  }
  await sleep(40);
}
check("an editor edit shows up on the phone within 2 s", seen >= 0 && seen < 2000, { ms: seen });
await page.screenshot({ path: resolve(out, "03-editor-after-edit.png") });
await phone.waitForTimeout(400);
await phone.screenshot({ path: resolve(out, "04-phone-after-edit.png") });

// 4. Facing toggle, scale toggle, tap to pause.
await phone.click("#face");
info = await phone.evaluate(() => window.atlasPhone.info());
check("the facing toggle mirrors the character", info.scaleX < 0 && info.facing === "right", { scaleX: info.scaleX });
await phone.screenshot({ path: resolve(out, "05-phone-facing-right.png") });
await phone.click("#scale");
info = await phone.evaluate(() => window.atlasPhone.info());
check("the scale toggle switches to 0.471", Math.abs(Math.abs(info.scaleX) - 0.471) < 1e-6, info.scaleX);
await phone.click("#scale");
await phone.tap("canvas", { position: { x: 195, y: 700 } });
const p1 = await phone.evaluate(() => window.atlasPhone.info());
await phone.waitForTimeout(500);
const p2 = await phone.evaluate(() => window.atlasPhone.info());
check("tap pauses the loop (pose stops changing)", p1.paused === true && p1.poseSig === p2.poseSig, { p1: p1.poseSig, p2: p2.poseSig });
await phone.screenshot({ path: resolve(out, "06-phone-paused.png") });
await phone.tap("canvas", { position: { x: 195, y: 700 } });
await phone.waitForTimeout(500);
const p3 = await phone.evaluate(() => window.atlasPhone.info());
check("tap again plays on", p3.paused === false && p3.poseSig !== p2.poseSig, { p2: p2.poseSig, p3: p3.poseSig });

// 5. Status in the editor popover shows the phone.
await page.waitForFunction(() => /Phone connected/.test(document.querySelector("#phonepop")?.textContent ?? ""), null, { timeout: 8000 }).then(
  () => check("the popover reports the connected phone", true),
  () => check("the popover reports the connected phone", false)
);
await page.screenshot({ path: resolve(out, "07-editor-connected.png") });

// 6. Requests without the token are rejected, and the LAN side cannot reach the editor API or write.
const origin = new URL(phoneUrl).origin;
const token = /phone\/([0-9a-f]{32})/.exec(phoneUrl)[1];
const status = async (path, init) => (await fetch(origin + path, init)).status;
check("page without a token: 403", (await status("/phone/")) === 403);
check("page with a wrong token: 403", (await status(`/phone/${"0".repeat(32)}/`)) === 403);
check("state without a token: 403", (await status(`/phone/${"0".repeat(32)}/state`)) === 403);
check("rig without a token: 403", (await status(`/phone/${"0".repeat(32)}/rig`)) === 403);
check("atlas without a token: 403", (await status(`/phone/${"0".repeat(32)}/repo/packages/animator/rigs/x.atlas.json`)) === 403);
check("script modules without the cookie: 403", (await status("/src/phonePage.ts")) === 403);
check("the editor API is not reachable from the LAN side", (await status("/api/clips", { headers: { cookie: `atlasphone=${token}` } })) === 404);
check("the phone cannot write (POST state): refused", [404, 405].includes(await status(`/phone/${token}/state`, { method: "POST", body: "{}" })));
check("the editor push route is not reachable from the LAN side", (await status("/api/phone/state", { method: "POST", body: "{}" })) === 404);
check("with the token the state is served", (await status(`/phone/${token}/state`)) === 200);

// 7. Stop turns the LAN server off.
await page.click("#phonestop");
await sleep(300);
let reachable = true;
try {
  await fetch(`${origin}/phone/${token}/state`, { signal: AbortSignal.timeout(3000) });
} catch {
  reachable = false;
}
check("Stop closes the LAN server", !reachable);
check("no page errors", errors.length === 0, errors.slice(0, 5));

await browser.close();
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
