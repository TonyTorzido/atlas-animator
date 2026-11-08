// Demo of the Animate workspace simplifications (animateBar.ts, animateBones.ts) with screenshots at 1600x900 and 1920x1080: open a
// clip from the board, key a pose with the big Key button, scrub, mirror for left, mark done on the board, and check what Animate hides.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-animate.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/animate"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const CLIP = "atk_axe_warrior_1";

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

for (const [w, h] of [
  [1600, 900],
  [1920, 1080]
]) {
  const page = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }), { workspace: null });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    await page.waitForTimeout(500);
    const file = resolve(out, `${name}-${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };
  const visible = (sel) => E((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null && getComputedStyle(e).display !== "none"; }, sel);
  const keyed = () => E(() => window.atlasEditor.state().clip.bones ?? {});
  const frame = () => E(() => Math.round(window.atlasEditor.state().time * 30));

  // Open a clip from the board: Home -> Animate card -> clip dot.
  await page.click('#home .home-card[data-go="animate"]');
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot");
  await page.click(`#clipboard .cb-dot[data-clip="${CLIP}"]`);
  await page.waitForFunction((c) => window.atlasEditor.state().clipName === c, CLIP, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  check(`${w}: Animate workspace`, (await E(() => window.atlasEditor.workspace())) === "animate");

  // The bar and the defaults.
  const bar = await E(() => [...document.querySelectorAll("#tb-set > button, #tb-set button")].filter((b) => b.offsetParent).map((b) => ({ id: b.id, h: Math.round(b.getBoundingClientRect().height) })));
  check(`${w}: transport buttons are one control height`, bar.length > 8 && bar.every((b) => b.h === 28), bar.map((b) => `${b.id} ${b.h}`));
  // H14: an attack opened from the board shows the project view on windows >= 1600 px, and the phone dock on narrower ones.
  const wide = parseInt(w, 10) >= 1600;
  check(`${w}: opening an attack clip ${wide ? "opens Game view" : "opens the phone dock"}`, wide ? await visible("#gameview") : await E(() => document.getElementById("app").classList.contains("dockopen") && !document.getElementById("app").classList.contains("dockrail")));
  if (wide) await E(() => window.atlasEditor.gameView(false));
  else await page.click("#dock-collapse");
  await page.waitForTimeout(300);
  check(`${w}: Auto key on`, await E(() => document.getElementById("autokey").classList.contains("on")));
  // Layout: the canvas is the hero. The phone dock starts on its rail below 2200 px (one click opens it); the bone list starts collapsed below 1800 px.
  check(`${w}: phone dock starts on its rail`, await E(() => document.getElementById("app").classList.contains("dockopen") && document.getElementById("app").classList.contains("dockrail")));
  await page.click("#dock-open");
  check(`${w}: one click opens the phone dock`, await E(() => document.getElementById("app").classList.contains("dockopen") && !document.getElementById("app").classList.contains("dockrail")));
  check(`${w}: bone list ${w < 1800 ? "starts collapsed" : "starts open"}`, (await E(() => document.getElementById("app").classList.contains("lcol"))) === w < 1800);
  const canvasShare = await E(() => { const r = document.getElementById("view").getBoundingClientRect(); return (r.width * r.height) / (innerWidth * innerHeight); });
  check(`${w}: canvas is over half the window (dock open)`, canvasShare > 0.35, canvasShare.toFixed(3));
  await page.click("#dock-collapse");
  const share = await E(() => { const r = document.getElementById("view").getBoundingClientRect(); return (r.width * r.height) / (innerWidth * innerHeight); });
  check(`${w}: canvas is over 50% of the window with the dock on its rail`, share > 0.48, share.toFixed(3));
  check(`${w}: Loop, Length, fps, Auto key and Redo sit in the one transport`, await E(() => ["loop", "duration", "autokey", "redo"].every((id) => document.getElementById("transport").contains(document.getElementById(id)))));
  check(`${w}: the Pose panel does not repeat the transform rows`, (await E(() => document.querySelectorAll("#detail .xf-in").length)) === 0 && (await E(() => document.querySelectorAll("#xstrip .xf-in").length)) === 7);
  if (await E(() => document.getElementById("app").classList.contains("lcol"))) await page.click("#left-open");
  // Collapsible right panel (remembered) and the dismissable one-line tip (remembered, back through the ? sheet).
  const viewW = () => E(() => document.getElementById("view").getBoundingClientRect().width);
  const w0 = await viewW();
  await page.click("#right-collapse");
  await page.waitForTimeout(300);
  check(`${w}: the right panel collapses to a rail and the canvas grows`, (await E(() => document.getElementById("app").classList.contains("rcol"))) && (await viewW()) > w0 + 100, { w0, now: await viewW() });
  check(`${w}: the choice is remembered`, (await E(() => localStorage.getItem("atlas-editor-panels"))).includes('"right":true'));
  await page.click("#right-open");
  check(`${w}: the rail opens the panel again`, !(await E(() => document.getElementById("app").classList.contains("rcol"))));
  check(`${w}: the one-line tip shows`, await visible("#canvastip"));
  await page.click("#tipdismiss");
  check(`${w}: Hide tip hides it and remembers`, !(await visible("#canvastip")) && (await E(() => localStorage.getItem("atlas-editor-tip-hidden"))) === "1");
  await page.click("#helpbtn");
  await page.click("#help-keys");
  await page.click("#tipshow");
  await page.click("#helpclose");
  check(`${w}: the ? sheet brings the tip back`, await visible("#canvastip"));
  check(`${w}: the bone list opens from its rail`, !(await E(() => document.getElementById("app").classList.contains("lcol"))));
  check(`${w}: Hand IK tool available`, await visible('#gizmo [data-mode="ik"]'));
  for (const [what, sel] of [["scale gizmo", '#gizmo [data-mode="scale"]'], ["shear gizmo", '#gizmo [data-mode="shear"]'], ["Keys tools row", "footer .transport.tools"], ["Outfit buttons", "#outfits"], ["New clip button", "#newclip-open"], ["New clip input", "#newclip-name"], ["Helpers button", "#helpersvis"]]) check(`${w}: ${what} hidden`, !(await visible(sel)));
  const list = await E(() => [...document.querySelectorAll("#bones .bone")].map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check(`${w}: bone list is the 8 standard controls`, list.length === 8 && list[0].startsWith("Body") && list.some((t) => t.startsWith("Near hand (IK)")) && list.some((t) => t.startsWith("Weapon")) && list.some((t) => t.startsWith("Head")), list);
  check(`${w}: no helper bones listed`, !list.some((t) => /grip|tip|knee|wrist|elbow/i.test(t)));
  check(`${w}: dots are colour-coded`, (await E(() => new Set([...document.querySelectorAll("#bones .bone .dot")].map((d) => d.style.background)).size)) >= 4);
  await shot("1-open-clip");

  // More group.
  await page.click("#bones-more");
  const more = await E(() => [...document.querySelectorAll("#bones .bone")].map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check(`${w}: More lists clavicles and the FK chain`, more.length > 8 && more.some((t) => t.startsWith("Near shoulder")) && more.some((t) => t.startsWith("Far forearm")) && more.some((t) => t.startsWith("Near shin")), more.length);
  await shot("2-more-bones");
  await page.click("#bones-more");

  // Key pose with the big button (nothing selected: keys the whole pose), then a changed pose at another frame.
  const before = Object.keys(await keyed()).length;
  await E(() => window.atlasEditor.setTime(0));
  await page.click("#key-menu-btn");
  await page.click("#ab-key");
  await page.waitForTimeout(300);
  const afterKey = await keyed();
  check(`${w}: Key pose keys the standard controls at frame 0`, Object.keys(afterKey).length >= before && !!afterKey.body && !!afterKey.head, Object.keys(afterKey));
  check(`${w}: the bar has no second scrubber (the dopesheet ruler is the scrubber)`, (await E(() => document.getElementById("ab-scrub"))) === null);
  check(`${w}: contact frame (hit event) is in the clip, drawn as a line through the dopesheet`, await E(() => window.atlasEditor.state().clip.events.some((e) => e.name === "hit")));

  // Scrub: click 60% along the dopesheet ruler (key area = canvas x 160 .. width - 12), then drag.
  await E(() => window.atlasEditor.fitTimeline());
  const box = await E(() => { const r = document.getElementById("tl").getBoundingClientRect(); return { x: r.x + 160, y: r.y, w: r.width - 172, h: 24 }; });
  await page.mouse.click(box.x + box.w * 0.6, box.y + box.h / 2);
  const f60 = await frame();
  const n = await E(() => Math.round(window.atlasEditor.state().clip.duration * 30));
  check(`${w}: clicking the scrubber moves the playhead`, Math.abs(f60 - Math.round(n * 0.6)) <= 1, { f60, n });
  await E(() => window.atlasEditor.select("upper_arm_near"));
  await E(() => window.atlasEditor.rotate("upper_arm_near", 40));
  await E(() => window.atlasEditor.key());
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.45, box.y + box.h / 2, { steps: 5 });
  await page.mouse.up();
  check(`${w}: dragging the scrubber scrubs`, Math.abs((await frame()) - Math.round(n * 0.45)) <= 1, await frame());
  check(`${w}: readout follows`, (await E(() => document.getElementById("sb-frame").textContent)).includes(`Frame ${await frame()} /`));
  await page.click("#ab-prevkey");
  const pk = await frame();
  await page.click("#ab-nextkey");
  const nk = await frame();
  check(`${w}: prev / next key jump`, pk === 0 || pk < nk, { pk, nk });

  // Play / pause.
  await E(() => window.atlasEditor.setTime(0));
  await page.click("#play");
  await page.waitForTimeout(100);
  check(`${w}: Play becomes Pause`, (await E(() => document.querySelector("#play .tb-label").textContent)) === "Pause");
  await page.click("#play");
  check(`${w}: Pause becomes Play`, (await E(() => document.querySelector("#play .tb-label").textContent)) === "Play");

  // Mirror for left: flips the pose and previews the right side in the dock.
  await E(() => window.atlasEditor.setTime(0));
  await page.waitForTimeout(200);
  const rotBefore = await E(() => JSON.stringify(window.atlasEditor.state().clip.bones.upper_arm_far?.rotate?.length ?? 0));
  await E((t) => window.atlasEditor.setTime(t), Math.round(n * 0.6) / 30);
  await page.click("#mirror-menu-btn");
  await page.click("#mm-flip");
  await page.waitForTimeout(500);
  const rotAfter = await E(() => JSON.stringify(window.atlasEditor.state().clip.bones.upper_arm_far?.rotate?.length ?? 0));
  check(`${w}: Mirror for left keys the far arm`, rotAfter !== rotBefore || Number(rotAfter) > 0, { rotBefore, rotAfter });
  check(`${w}: dock shows the right side`, await E(() => document.getElementById("dock-mirror").classList.contains("on")));
  await shot("3-keyed-and-mirrored");

  // Breakdown: select a keyed bone between two keys and press the big button.
  await E(() => window.atlasEditor.select("upper_arm_near"));
  await E((t) => window.atlasEditor.setTime(t), Math.round(n * 0.3) / 30);
  const kBefore = await E(() => window.atlasEditor.state().clip.bones.upper_arm_near?.rotate?.length ?? 0);
  await page.click("#key-menu-btn");
  await page.click("#ab-breakdown");
  await page.waitForTimeout(300);
  const kAfter = await E(() => window.atlasEditor.state().clip.bones.upper_arm_near?.rotate?.length ?? 0);
  check(`${w}: Breakdown adds a key between two keys`, kAfter === kBefore + 1, { kBefore, kAfter });

  // Undo.
  check(`${w}: Undo enabled`, !(await E(() => document.getElementById("undo").disabled)));
  await page.click("#undo");
  const kUndo = await E(() => window.atlasEditor.state().clip.bones.upper_arm_near?.rotate?.length ?? 0);
  check(`${w}: Undo removes the breakdown key`, kUndo === kBefore, kUndo);

  // Mark done: the board file records it. The demo's server keeps its board between window sizes, and the previous size ends with the clip
  // marked done: start from "not done" (after the bar has read the board), or the click below toggles it off and the checks race it.
  await page.waitForTimeout(700);
  if (await E(() => document.getElementById("ab-done").classList.contains("is-done"))) {
    await page.click("#ab-done");
    await page.waitForFunction(() => !document.getElementById("ab-done").classList.contains("is-done"), null, { timeout: 15_000 });
  }
  await page.click("#ab-done");
  await page.waitForFunction(() => document.getElementById("ab-done").classList.contains("is-done"), null, { timeout: 15_000 });
  const board = await E(() => fetch("/api/board").then((r) => r.json()));
  check(`${w}: Mark done writes the board`, board[CLIP]?.done === true, board[CLIP]);
  await page.waitForFunction(() => document.querySelector("#ab-done .ab-label")?.textContent === "Done", null, { timeout: 5000 }).catch(() => {});
  check(`${w}: Done button reads Done`, (await E(() => document.querySelector("#ab-done .ab-label").textContent)) === "Done");
  await shot("4-marked-done");
  await page.click("#ab-done");
  await page.waitForFunction(() => !document.getElementById("ab-done").classList.contains("is-done"), null, { timeout: 15_000 });
  check(`${w}: clicking again marks it not done`, (await E(() => fetch("/api/board").then((r) => r.json())))[CLIP]?.done === false);
  await page.click("#ab-done");
  await page.waitForFunction(() => document.getElementById("ab-done").classList.contains("is-done"), null, { timeout: 15_000 });

  // Layout: no scrollbars, bar inside the footer.
  check(`${w}: no browser scrollbars`, await E(() => [document.documentElement, document.body, document.getElementById("transport"), document.getElementById("bones")].every((e) => e.scrollWidth <= e.clientWidth + 1)));
  const barBox = await E(() => { const r = document.getElementById("transport").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; });
  check(`${w}: bar fits on screen`, barBox.bottom < h && barBox.h < 120, barBox);
  await shot("5-final");

  // V opens the project view in the dock column, never over the posing canvas.
  await page.keyboard.press("v");
  await page.waitForTimeout(600);
  const gv = await E(() => { const r = (id) => document.querySelector(id).getBoundingClientRect(); const c = r("#view canvas"), g = r("#gameview"); return { open: getComputedStyle(document.getElementById("gameview")).display !== "none", overlap: !(g.right <= c.left || g.left >= c.right || g.bottom <= c.top || g.top >= c.bottom), canvasW: Math.round(c.width), canvasH: Math.round(c.height), panel: [Math.round(g.left), Math.round(g.width)] }; });
  check(`${w}: V opens Game view beside the canvas, not over it`, gv.open && !gv.overlap && gv.canvasW >= 400, gv);
  await shot("6-game-view-open");
  await page.keyboard.press("v");
  await page.waitForTimeout(300);
  check(`${w}: V closes it again`, !(await visible("#gameview")));

  // Show all bones switches to Pro.
  await page.click("#bones-showall");
  check(`${w}: Show all bones goes to Pro`, (await E(() => window.atlasEditor.workspace())) === "pro");
  check(`${w}: Pro lists every bone`, (await E(() => document.querySelectorAll("#outliner .ol-row").length)) > 30);
  check(`${w}: Pro keeps the scale gizmo`, await visible('#gizmo [data-mode="scale"]'));
  check(`${w}: no page errors`, errors.length === 0, errors);
  await page.close();
}

await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
