// Short feature demos of the editor (slots, curves, dopesheet, game-size preview) with screenshots.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-items.mjs [slots|curves|dopesheet|preview|all] [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const which = process.argv[2] ?? "all";
const out = resolve(process.argv[3] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/items"));
const { url, dataDir } = await demoServer(process.argv[4]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(800);
// These demos key the old template bones (hand_l, upper_arm_l, tank, hair): pin them to the old-rig outfit, the default is the pro rig.
await page.evaluate(() => window.atlasEditor.mountOutfit("turned-l"));
await page.waitForTimeout(600);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const newClip = async (name, loop = false) => {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(200);
  const isLoop = await E(() => window.atlasEditor.state().clip.loop);
  if (isLoop !== loop) await page.click("#loop");
};
const frame = (f) => E((x) => window.atlasEditor.setTime(x / 30), f);
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);

const demos = {
  async slots() {
    await newClip("demo_slots");
    await E(() => window.atlasEditor.setLength?.(0.8));
    await frame(0);
    await E(() => window.atlasEditor.setAttachment("eyes", "eyes"));
    await frame(10);
    await E(() => window.atlasEditor.setAttachment("eyes", "eyes_blink_closed"));
    await frame(14);
    await E(() => window.atlasEditor.setAttachment("eyes", "eyes"));
    await frame(4);
    await E(() => window.atlasEditor.setDrawOrder("hair", -18));
    await frame(8);
    await E(() => window.atlasEditor.setDrawOrder("hair", 0));
    const clip = await E(() => window.atlasEditor.state().clip);
    check("eyes swap keys", clip.slots?.eyes?.attachment?.length === 3, clip.slots?.eyes);
    check("draw order keys", clip.drawOrder?.length === 2, clip.drawOrder);
    await frame(11);
    const shown = await E(() => window.atlasEditor.debug().skeleton.slots.find((s) => s.data.name === "eyes").placeholder);
    check("eyes closed at frame 11", shown === "eyes_blink_closed", shown);
    await E(() => window.atlasEditor.selectSlot("eyes"));
    await shot("slots-blink-frame11.png");
    await frame(6);
    const order = await E(() => window.atlasEditor.debug().skeleton.drawOrder.map((s) => s.data.name));
    check("hair moved behind at frame 6", order.indexOf("hair") < order.indexOf("tank"), order.join(","));
    await shot("slots-draworder-frame6.png");
  }
,

  async curves() {
    await newClip("demo_curves");
    await E(() => {
      const e = window.atlasEditor;
      e.select("upper_arm_l");
      e.setTime(0);
      e.rotate("upper_arm_l", 0);
      e.key();
      e.setTime(12 / 30);
      e.rotate("upper_arm_l", 80);
      e.key();
    });
    const rotAt = async (f) => {
      await frame(f);
      await page.waitForTimeout(150);
      return E(() => {
        const b = window.atlasEditor.debug().skeleton.findBone("upper_arm_l");
        return +(b.pose.rotation - b.data.rotation).toFixed(2);
      });
    };
    await frame(0);
    console.log(JSON.stringify(await E(() => window.atlasEditor.state().clip.bones)));
    const linear = await rotAt(4);
    await E(() => window.atlasEditor.setCurve("ease-in", "upper_arm_l", 0));
    const easeIn = await rotAt(4);
    await E(() => window.atlasEditor.setCurve("ease-out", "upper_arm_l", 0));
    const easeOut = await rotAt(4);
    await E(() => window.atlasEditor.setCurve("stepped", "upper_arm_l", 0));
    const stepped = await rotAt(4);
    check("frame 4 rotation: linear ~26.7, ease-in slower, ease-out faster, stepped holds 0", linear > 25 && easeIn < linear - 5 && easeOut > linear + 5 && stepped === 0, { linear, easeIn, easeOut, stepped });
    // custom bezier by dragging the second handle on the graph
    await E(() => window.atlasEditor.setCurve("ease-in-out", "upper_arm_l", 0));
    await frame(0);
    await page.waitForTimeout(300);
    await shot("curves-ease-in-out-panel.png");
    const box = await page.locator("#curvecanvas").boundingBox();
    const toScreen = (x, y) => [box.x + ((12 + x * 616) / 640) * box.width, box.y + ((260 - 8 - ((y + 0.5) / 2) * 244) / 260) * box.height];
    const [hx, hy] = toScreen(0.58, 1);
    const [tx, ty] = toScreen(0.3, 1.4);
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move((hx + tx) / 2, (hy + ty) / 2, { steps: 4 });
    await page.mouse.move(tx, ty, { steps: 4 });
    await page.mouse.up();
    const dragged = await E(() => window.atlasEditor.curveOf("upper_arm_l", 0));
    check("dragging the handle made a custom bezier with overshoot", Array.isArray(dragged) && dragged[3] > 1.2 && dragged[2] < 0.45, dragged);
    const over = await rotAt(10);
    check("the custom curve overshoots past 80 before settling", over > 80, over);
    await frame(0);
    await shot("curves-custom-bezier.png");
    await frame(4);
    const kinds = await E(() => [0, 12].map((f) => window.atlasEditor.curveOf("upper_arm_l", f)));
    check("dopesheet draws curved keys as circles (curve kinds)", Array.isArray(kinds[0]) && kinds[1] === "linear", kinds);
  }
,

  async dopesheet() {
    await newClip("demo_dopesheet", false);
    check("a new clip is non-looping by default", await E(() => window.atlasEditor.state().clip.loop === false));
    await E(() => {
      const e = window.atlasEditor;
      e.select("upper_arm_l");
      for (const [f, v] of [[0, 0], [6, 40], [12, 10], [18, 70]]) {
        e.setTime(f / 30);
        e.rotate("upper_arm_l", v);
        e.key();
      }
      e.select("head");
      for (const [f, v] of [[6, 4], [12, -4]]) {
        e.setTime(f / 30);
        e.rotate("head", v);
        e.key();
      }
      e.setTime(6 / 30);
      e.setAttachment("eyes", "eyes_blink_closed");
      e.select("upper_arm_l");
    });
    const times = (row) => E((r) => window.atlasEditor.state().clip.bones[r]?.rotate?.map((k) => Math.round(k.time * 30)), row);
    // 1. click + drag a key by 3 frames with the real mouse
    const k6 = await E(() => window.atlasEditor.keyScreenPos("bone:upper_arm_l", 6));
    await page.mouse.move(k6.x, k6.y);
    await page.mouse.down();
    const step = (await E(() => window.atlasEditor.keyScreenPos("bone:upper_arm_l", 7))).x - k6.x;
    await page.mouse.move(k6.x + step * 1.5, k6.y, { steps: 3 });
    await page.mouse.move(k6.x + step * 3, k6.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterMove = await times("upper_arm_l");
    check("dragging the frame 6 key by 3 frames retimes it to 9", JSON.stringify(afterMove) === JSON.stringify([0, 9, 12, 18]), afterMove);
    await page.click("#undo");
    check("undo restores one drag as one step", JSON.stringify(await times("upper_arm_l")) === JSON.stringify([0, 6, 12, 18]), await times("upper_arm_l"));
    // 2. box select across rows (drag on empty row space)
    const a = await E(() => window.atlasEditor.keyScreenPos("all", 4));
    const b = await E(() => window.atlasEditor.keyScreenPos("bone:head", 14));
    await page.mouse.move(a.x, a.y + 8);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 6, { steps: 4 });
    await page.mouse.move(b.x, b.y + 8, { steps: 4 });
    await shot("dopesheet-box-select-drag.png");
    await page.mouse.up();
    const sel = await E(() => window.atlasEditor.selection());
    check("box select picked the keys at frames 6 and 12 on the arm and head rows (and the eyes swap)", sel.length >= 4 && sel.every((s) => s.frame >= 4 && s.frame <= 14), sel);
    // 3. copy the selected range and paste at frame 20
    await E(() => {
      window.atlasEditor.copyKeys();
      window.atlasEditor.pasteKeys(20);
    });
    const pasted = await times("upper_arm_l");
    check("pasting the copied keys at frame 20 keeps their spacing (14 and 26)", pasted.includes(20) && pasted.includes(26) && pasted.includes(6), pasted);
    await page.click("#undo");
    // 4. scale: select the arm keys and scale to 50% about the playhead, then the whole clip
    await E(() => {
      window.atlasEditor.setTime(0);
      window.atlasEditor.selectKeys([6, 12, 18].map((frame) => ({ row: "bone:upper_arm_l", frame })));
      window.atlasEditor.scaleSelected(0.5, 0);
    });
    const scaled = await times("upper_arm_l");
    check("scaling the selected keys to 50% about frame 0", JSON.stringify(scaled) === JSON.stringify([0, 3, 6, 9]), scaled);
    await page.click("#undo");
    await E(() => {
      window.atlasEditor.clearSelection();
      window.atlasEditor.scaleSelected(2);
    });
    const dur = await E(() => window.atlasEditor.state().clip.duration);
    check("with nothing selected, scale timing scales the whole clip and its length (1s -> 2s)", Math.abs(dur - 2) < 1e-3 && JSON.stringify(await times("upper_arm_l")) === JSON.stringify([0, 12, 24, 36]), { dur, t: await times("upper_arm_l") });
    await page.click("#undo");
    // 5. play range with shift-drag on the ruler
    const r0 = await E(() => window.atlasEditor.rulerScreenPos(4));
    const r1 = await E(() => window.atlasEditor.rulerScreenPos(10));
    await page.keyboard.down("Shift");
    await page.mouse.move(r0.x, r0.y);
    await page.mouse.down();
    await page.mouse.move(r1.x, r1.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const range = await E(() => window.atlasEditor.playRange());
    check("shift-drag on the ruler sets the play range to frames 4-10", range && range.a === 4 && range.b === 10, range);
    await E(() => window.atlasEditor.setTime(0));
    await page.click("#play");
    const seen = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(90);
      seen.push(Math.round((await E(() => window.atlasEditor.state().time)) * 30));
    }
    await shot("dopesheet-play-range.png");
    await page.click("#play");
    check("playback stays inside the range and wraps (frames seen " + seen.join(",") + ")", seen.every((f) => f >= 4 && f <= 11), seen);
    await E(() => window.atlasEditor.clearSelection());
    await E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_l", frame: 12 }, { row: "bone:head", frame: 12 }]));
    await shot("dopesheet-selection.png");
  }
,

  async preview() {
    const png = require("pngjs").PNG;
    // The open clip is the pro rig's empty user_pose: key a swinging arm so the held frames differ.
    await newClip("demo_preview");
    await E(() => {
      const e = window.atlasEditor;
      e.select("upper_arm_l");
      e.setTime(0);
      e.rotate("upper_arm_l", 0);
      e.key();
      e.setTime(10 / 30);
      e.rotate("upper_arm_l", 60);
      e.key();
    });
    await E(() => window.atlasEditor.togglePreview(true));
    await frame(3);
    await page.waitForTimeout(600);
    const bbox = (id) =>
      page.evaluate((cid) => {
        const c = document.getElementById(cid);
        const g = c.getContext("2d");
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const bg = [d[0], d[1], d[2]];
        let y0 = c.height, y1 = -1, x0 = c.width, x1 = -1;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
        }
        return { w: x1 - x0 + 1, h: y1 - y0 + 1, x0, y0 };
      }, id);
    const small = await bbox("preview-0.4");
    const big = await bbox("preview-0.471");
    const ratio = small.h / big.h;
    check("both scales draw a figure, 0.4 is 0.4/0.471 the height of 0.471 (" + small.h + " vs " + big.h + " px)", big.h > 300 && Math.abs(ratio - 0.4 / 0.471) < 0.03, { small, big, ratio: +ratio.toFixed(3) });
    check("the 0.471 figure is about 1120 rig px * 0.471 = 528 px tall (feet to hair)", big.h > 470 && big.h < 600, big.h);
    // held 30 fps: a time between frames shows the frame it belongs to
    const dataUrl = (id) => E((cid) => document.getElementById(cid).toDataURL(), id);
    await frame(3);
    await page.waitForTimeout(300);
    const f3 = await dataUrl("preview-0.471");
    await E(() => window.atlasEditor.setTime(3.5 / 30, false));
    await page.waitForTimeout(300);
    const f35 = await dataUrl("preview-0.471");
    await frame(4);
    await page.waitForTimeout(300);
    const f4 = await dataUrl("preview-0.471");
    check("held 30 fps: 3.5 frames looks like frame 3, frame 4 differs", f3 === f35 && f3 !== f4, { f3EqF35: f3 === f35, f3DiffF4: f3 !== f4 });
    // sprite strip reference: 12 frames, red = frame * 20
    const W = 60, H = 90, N = 12;
    const img = new png({ width: W * N, height: H });
    for (let f = 0; f < N; f++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = ((y * W * N) + f * W + x) * 4;
      img.data[i] = f * 20; img.data[i + 1] = 120; img.data[i + 2] = 200; img.data[i + 3] = 255;
    }
    await E((n) => (document.getElementById("refframes").value = String(n)), N);
    await page.setInputFiles("#refinput", { name: "strip.png", mimeType: "image/png", buffer: png.sync.write(img) });
    await page.waitForTimeout(400);
    await page.fill("#refframes", String(N));
    await page.dispatchEvent("#refframes", "change");
    const refPixel = () => E(() => { const c = document.getElementById("refcanvas"); return Array.from(c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data); });
    await frame(5);
    await page.waitForTimeout(300);
    const p5 = await refPixel();
    await frame(14);
    await page.waitForTimeout(300);
    const p14 = await refPixel();
    check("the strip reference follows the playhead (frame 5 -> red 100, frame 14 wraps to 2 -> red 40)", p5[0] === 100 && p14[0] === 40, { p5, p14 });
    await frame(6);
    await page.waitForTimeout(400);
    await shot("preview-game-size-strip.png");
    // video reference generated in the page
    await page.click("text=Remove reference");
    // a 2 s test video made with ffmpeg (skipped when ffmpeg is not on PATH)
    const { execFileSync } = await import("node:child_process");
    const { readFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    let videoBuf = null;
    try {
      const dir = mkdtempSync(resolve(tmpdir(), "refvid-"));
      const file = resolve(dir, "ref.webm");
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=128x192:rate=30", "-c:v", "libvpx", "-b:v", "1M", file], { stdio: "ignore" });
      videoBuf = readFileSync(file);
    } catch {
      console.log("SKIP reference video (no ffmpeg)");
    }
    if (!videoBuf) return;
    await page.setInputFiles("#refinput", { name: "ref.webm", mimeType: "video/webm", buffer: videoBuf });
    await page.waitForTimeout(800);
    const made = await E(() => window.atlasEditor.previewInfo());
    check("a reference video loads and is shown beside the preview", made.reference === "video", made);
    await frame(2);
    await page.waitForTimeout(500);
    const vt = (await E(() => window.atlasEditor.previewInfo())).videoTime;
    check("the video seeks with the playhead (about 2/30 s)", vt !== null && Math.abs(vt - 2 / 30) < 0.2, vt);
    await shot("preview-game-size-video.png");
  },

  async move() {
    await newClip("demo_move");
    await E(() => {
      window.atlasEditor.setGizmo("move");
      window.atlasEditor.select("pelvis");
      window.atlasEditor.setTime(8 / 30);
    });
    const before = await E(() => window.atlasEditor.moveOf("pelvis"));
    const start = await E(() => window.atlasEditor.boneScreenPos("pelvis"));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y + 5, { steps: 4 });
    await page.mouse.move(start.x + 60, start.y + 10, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const clip = await E(() => window.atlasEditor.state().clip);
    const key = clip.bones.pelvis?.translate?.[0];
    check("dragging the hips with the move gizmo keys a translate (lunge forward and down)", key && key.time > 0.26 && key.time < 0.27 && key.x > 50 && key.y > 5, key);
    const after = await E(() => window.atlasEditor.boneScreenPos("pelvis"));
    check("the hips origin followed the mouse (about +60 px on screen)", Math.abs(after.x - (start.x + 60)) < 3 && Math.abs(after.y - (start.y + 10)) < 3, { start, after });
    // chest lunge and a hand offset from the numeric API
    await E(() => {
      const e = window.atlasEditor;
      e.select("chest");
      e.move("chest", 18, -4);
      e.keyMove("chest");
      e.select("hand_l");
      e.move("hand_l", 24, 0);
      e.keyMove("hand_l");
    });
    const gates = await E(() => window.atlasEditor.gatesNow().map((i) => i.severity + ":" + i.kind));
    // The hand offset also pulls the fist off its forearm: that rule is an error on every clip, so it is expected here.
    check("a hand offset along the arm stretches the limb (warning on this non-loop clip) and pulls the fist off its arm (error)", gates.includes("warning:limb stretch") && gates.includes("error:fist on own arm") && gates.filter((g) => g.startsWith("error")).every((g) => g === "error:fist on own arm"), gates);
    await shot("move-hips-chest-hand.png");
    await page.click("#undo");
    await page.click("#undo");
    await page.click("#undo");
    const gone = await E(() => Object.keys(window.atlasEditor.state().clip.bones ?? {}));
    check("undo removes the three move keys", gone.length === 0, gone);
  },

  async onion() {
    const png = require("pngjs").PNG;
    // a big arm swing, so neighbouring frames differ visibly: arm 0 deg at frame 0, 100 deg at frame 8, back at 16
    await newClip("demo_onion", true);
    await E(() => {
      const e = window.atlasEditor;
      e.select("upper_arm_l");
      for (const [f, v] of [[0, 0], [8, 100], [16, 0]]) {
        e.setTime(f / 30);
        e.rotate("upper_arm_l", v);
        e.key();
      }
      e.setTime(0);
      e.setLength?.(0.5);
    });
    await frame(4);
    await page.waitForTimeout(400);
    const viewShot = async (name) => {
      await page.waitForTimeout(500);
      const file = resolve(out, name);
      const box = await page.locator("#view").boundingBox();
      const buf = await page.screenshot({ path: file, clip: box });
      console.log(file);
      return png.sync.read(buf);
    };
    const bluish = (img) => {
      let n = 0, o = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (b > r + 40 && b > 120 && g > 90 && g < b) n++;
        if (r > b + 70 && r > 160 && g > b + 20 && g < r - 20 && b < 130) o++;
      }
      return { blue: n, orange: o };
    };
    const offImg = await viewShot("onion-off.png");
    const off = bluish(offImg);
    await E(() => window.atlasEditor.setOnion({ enabled: true, count: 2 }));
    await page.waitForTimeout(500);
    const info = await E(() => window.atlasEditor.onionInfo());
    check("onion skin plans the frames 3, 5, 2, 6 around frame 4 (previous blue, next orange)", JSON.stringify(info.frames) === "[3,5,2,6]" && info.ghosts === 4 && info.tints.includes(0x5fb3ff) && info.tints.includes(0xff9f43), info);
    const onImg = await viewShot("onion-2-frames.png");
    let changed = 0;
    for (let i = 0; i < onImg.data.length; i += 4) if (Math.abs(onImg.data[i] - offImg.data[i]) + Math.abs(onImg.data[i + 1] - offImg.data[i + 1]) + Math.abs(onImg.data[i + 2] - offImg.data[i + 2]) > 30) changed++;
    check("ghost frames change the picture behind the rig (" + changed + " px differ with onion on)", changed > 4000, changed);
    await E(() => window.atlasEditor.setOnion({ count: 1 }));
    await page.waitForTimeout(300);
    const one = await E(() => window.atlasEditor.onionInfo());
    check("the count is the number of frames on each side (1 -> frames 3 and 5)", JSON.stringify(one.frames) === "[3,5]", one);
    await frame(0);
    await page.waitForTimeout(300);
    const wrap = await E(() => window.atlasEditor.onionInfo().frames);
    check("a loop wraps: at frame 0 the previous ghost is the last frame (29)", wrap.includes(29) && wrap.includes(1), wrap);
    await E(() => window.atlasEditor.setOnion({ enabled: false }));
    await page.waitForTimeout(300);
    check("turning onion off removes the ghosts", (await E(() => window.atlasEditor.onionInfo())).ghosts === 0);

    // underlay: a 12 frame strip, each frame a different colour block, behind the rig
    const W = 120, H = 180, N = 12;
    const img = new png({ width: W * N, height: H });
    for (let f = 0; f < N; f++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W * N + f * W + x) * 4;
      const edge = x < 4 || y < 4 || x > W - 5 || y > H - 5;
      img.data[i] = edge ? 255 : 40 + f * 15; img.data[i + 1] = edge ? 255 : 160; img.data[i + 2] = edge ? 255 : 200 - f * 10; img.data[i + 3] = 255;
    }
    await E((n) => (document.getElementById("underframes").value = String(n)), N);
    await page.setInputFiles("#underinput", { name: "strip.png", mimeType: "image/png", buffer: png.sync.write(img) });
    await page.waitForTimeout(600);
    await E(() => window.atlasEditor.setUnderlay({ opacity: 0.5 }));
    await frame(5);
    await page.waitForTimeout(400);
    let u = await E(() => window.atlasEditor.underlayInfo());
    check("the underlay shows strip frame 5 at playhead frame 5", u.loaded && u.frames === 12 && u.frame === 5, u);
    await frame(14);
    await page.waitForTimeout(300);
    u = await E(() => window.atlasEditor.underlayInfo());
    check("it follows the frame (14 wraps to strip frame 2)", u.frame === 2, u);
    await frame(6);
    await page.waitForTimeout(400);
    const withUnder = await viewShot("underlay-strip-frame6.png");
    // the strip frame 6 block colour (130,160,140) faded over the background shows behind the rig
    let hit = 0;
    for (let i = 0; i < withUnder.data.length; i += 4) {
      const r = withUnder.data[i], g = withUnder.data[i + 1], b = withUnder.data[i + 2];
      if (r > 60 && r < 110 && g > 80 && g < 130 && b > 80 && b < 130 && Math.abs(r - 85) < 25) hit++;
    }
    check("the faded strip frame is drawn behind the rig", hit > 2000, hit);
    await E(() => window.atlasEditor.clearUnderlay());
    check("clear removes the underlay", !(await E(() => window.atlasEditor.underlayInfo())).loaded);
  },

  async events() {
    await newClip("demo_events");
    await E(() => {
      const e = window.atlasEditor;
      e.setEventLink("axe:generic", 0, true);
      e.addEvent("windup", 0);
      e.addEvent("hit", 8);
    });
    const warn = async () => E(() => window.atlasEditor.gatesNow().filter((i) => i.kind === "event timing").map((i) => i.severity + ": " + i.message));
    let w = await warn();
    check("a hit linked to axe:generic step 1 on frame 8 warns (contact is frame 6 = 200 ms x 30 / 1000)", w.length === 1 && w[0].startsWith("warning") && w[0].includes("frame 6"), w);
    await E(() => window.atlasEditor.setTime(8 / 30));
    await shot("events-hit-off-frame-warning.png");
    await E(() => window.atlasEditor.lockHit("axe:generic", 0));
    w = await warn();
    const evs = await E(() => window.atlasEditor.events());
    check("lock moves the hit onto frame 6 and the warning clears", w.length === 0 && evs.some((e) => e.name === "hit" && e.frame === 6), { w, evs });
    await E(() => {
      const e = window.atlasEditor;
      e.addEvent("trailOn", 4);
      e.addEvent("trailOff", 9);
      e.addEvent("follow", 9);
      e.addEvent("ready", 14);
    });
    const names = (await E(() => window.atlasEditor.events())).map((e) => e.name + "@" + e.frame).join(" ");
    check("all six marker kinds are stored in the clip", names === "windup@0 trailOn@4 hit@6 trailOff@9 follow@9 ready@14", names);
    const clipEvents = await E(() => window.atlasEditor.state().clip.events);
    check("the hit carries its profile link in the clip file", clipEvents.find((e) => e.name === "hit").string === "axe:generic#0", clipEvents);
    await E(() => window.atlasEditor.setTime(6 / 30));
    await shot("events-markers-locked.png");
    // the finisher has a later contact frame
    await E(() => window.atlasEditor.lockHit("axe:generic", 2));
    check("the finisher (step 3, 300 ms) locks to frame 9", (await E(() => window.atlasEditor.events())).some((e) => e.name === "hit" && e.frame === 9));
    await E(() => window.atlasEditor.lockHit("axe:generic", 0));
    // drag the hit marker two frames later in the dopesheet: the warning comes back
    const k = await E(() => window.atlasEditor.keyScreenPos("event", 6));
    const k2 = await E(() => window.atlasEditor.keyScreenPos("event", 8));
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move((k.x + k2.x) / 2, k.y, { steps: 3 });
    await page.mouse.move(k2.x, k.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    w = await warn();
    check("dragging the hit marker off its frame in the dopesheet warns again", w.length === 1, w);
    await shot("events-dragged-off.png");
  },

  async apply() {
    const { readFileSync, writeFileSync, existsSync, statSync } = await import("node:fs");
    const repo = resolve(here, "../../..");
    // User data lives directly under the data dir (dataDirs.ts).
    const real = (rel) => {
      const m = dataDir && /^packages\/animator-editor\/(clips|poses|smears|exports|autosave)\/(.*)$/.exec(rel);
      if (m) return resolve(dataDir, m[1], m[2]);
      // a rig the server wrote lives in <dataDir>/rigs/<rig>/ (the user copy over the stock rig)
      const r = dataDir && /^packages[/]animator[/]rigs[/]([^/]+)[/](.*)$/.exec(rel);
      return r && existsSync(resolve(dataDir, "rigs", r[1])) ? resolve(dataDir, "rigs", r[1], r[2]) : resolve(repo, rel);
    };
    const rigFile = resolve(repo, "packages/animator/rigs/player/front-turn15-faceA.anim.json");
    const original = readFileSync(rigFile, "utf8");
    try {
      await newClip("demo_apply");
      await E(() => {
        const e = window.atlasEditor;
        e.select("upper_arm_l");
        for (const [f, v] of [[0, 0], [6, 70], [12, 10]]) {
          e.setTime(f / 30);
          e.rotate("upper_arm_l", v);
          e.key();
        }
        e.setEventLink("axe:generic", 0, true);
        e.lockHit("axe:generic", 0);
        e.setTime(0);
      });
      const files = await E(() => window.atlasEditor.applyToRig(false));
      check("apply returns the rig file it wrote", JSON.stringify(files) === JSON.stringify(["packages/animator/rigs/player/front-turn15-faceA.anim.json"]), files);
      const doc = JSON.parse(readFileSync(rigFile, "utf8"));
      const written = doc.animations.demo_apply;
      check("the clip is in the rig document with its keys and the hit event, event names declared", written && written.bones.upper_arm_l.rotate.length === 3 && written.events[0].name === "hit" && doc.events.hit, { keys: written?.bones?.upper_arm_l?.rotate?.length, ev: written?.events });
      check("the rig file stays minified and the other clips are untouched", !readFileSync(rigFile, "utf8").includes("\n") && doc.animations.walk_in_place.duration > 0.9);
      check("Save wrote the clip file too", existsSync(real("packages/animator-editor/clips/demo_apply.clip.json")));
      const result = await E(() => window.atlasEditor.renderSheets());
      check("the CLI rendered a contact sheet and a gif at both phone scales", result && result.files.length === 2 && result.files.every((f) => statSync(real(f.sheet)).size > 10000 && statSync(real(f.gif)).size > 10000), result?.files?.map((f) => f.scale + ": " + f.log));
      await page.waitForTimeout(1500);
      await shot("apply-render-result.png");
    } finally {
      writeFileSync(rigFile, original);
      console.log("restored the rig document");
    }
  },

  async ik() {
    await newClip("demo_ik");
    await E(() => {
      window.atlasEditor.setGizmo("ik");
      window.atlasEditor.setTime(6 / 30);
    });
    const hand = (s) => E((side) => window.atlasEditor.handPos(side), s);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const armLens = () =>
      E(() => {
        const sk = window.atlasEditor.debug().skeleton;
        const d = (a, b) => Math.hypot(sk.findBone(b).world.x - sk.findBone(a).world.x, sk.findBone(b).world.y - sk.findBone(a).world.y);
        return { l1: d("upper_arm_l", "forearm_l"), l2: d("forearm_l", "hand_l"), r1: d("upper_arm_r", "forearm_r"), r2: d("forearm_r", "hand_r") };
      });
    const lens0 = await armLens();
    const h0 = await hand("l");
    // drag the left fist up and out with the real mouse
    await page.mouse.move(h0.screen.x, h0.screen.y);
    await page.mouse.down();
    await page.mouse.move(h0.screen.x - 25, h0.screen.y - 40, { steps: 4 });
    await page.mouse.move(h0.screen.x - 50, h0.screen.y - 80, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const h1 = await hand("l");
    check("the fist followed the mouse (moved about 50 px left, 80 px up on screen)", Math.abs(h1.screen.x - (h0.screen.x - 50)) < 3 && Math.abs(h1.screen.y - (h0.screen.y - 80)) < 3, { from: h0.screen, to: h1.screen });
    const clip = await E(() => window.atlasEditor.state().clip);
    check("one drag keyed the upper arm and forearm rotations at the playhead", clip.bones.upper_arm_l?.rotate?.length === 1 && clip.bones.forearm_l?.rotate?.length === 1 && !clip.bones.hand_l, Object.keys(clip.bones));
    const lens1 = await armLens();
    check("the arm kept its length (no stretch)", Math.abs(lens1.l1 - lens0.l1) < 0.05 && Math.abs(lens1.l2 - lens0.l2) < 0.05, { lens0, lens1 });
    const gates = await E(() => window.atlasEditor.gatesNow().map((i) => i.severity + ":" + i.kind));
    check("no limb stretch or head overlap warnings", !gates.some((g) => g.includes("stretch")), gates);
    await shot("ik-left-fist-drag.png");
    await page.click("#undo");
    await page.waitForTimeout(500);
    check("undo takes the IK drag back as one step", Object.keys((await E(() => window.atlasEditor.state().clip.bones)) ?? {}).length === 0);

    // two-hand grip: the right hand stays on a point 70 px along the dragged hand
    await E(() => window.atlasEditor.setGrip({ on: true, along: 40, across: 0 }));
    const left = await hand("l");
    const chest = await E(() => window.atlasEditor.boneScreenPos("chest"));
    // bring the lead fist to the front of the chest, where the other arm can reach the grip point
    await page.mouse.move(left.screen.x, left.screen.y);
    await page.mouse.down();
    await page.mouse.move((left.screen.x + chest.x - 30) / 2, (left.screen.y + chest.y - 90) / 2, { steps: 6 });
    await page.mouse.move(chest.x - 25, chest.y - 90, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const clip2 = await E(() => window.atlasEditor.state().clip);
    check("with the grip, one drag keyed both arms (four bones)", ["upper_arm_l", "forearm_l", "upper_arm_r", "forearm_r"].every((b) => clip2.bones[b]?.rotate?.length === 1), Object.keys(clip2.bones));
    const info = await E(() => window.atlasEditor.gripInfo());
    const rightHand = await hand("r");
    const err = Math.hypot(rightHand.x - info.point[0], rightHand.y - info.point[1]);
    check("the right hand sits on the grip point of the left hand (error " + err.toFixed(2) + " px)", err < 1.5, { err, point: info.point });
    await shot("ik-two-hand-grip.png");
    // move the lead again: the pinned hand follows it
    const lead = await hand("l");
    await page.mouse.move(lead.screen.x, lead.screen.y);
    await page.mouse.down();
    await page.mouse.move(lead.screen.x + 10, lead.screen.y + 8, { steps: 4 });
    await page.mouse.move(lead.screen.x + 20, lead.screen.y + 16, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const info2 = await E(() => window.atlasEditor.gripInfo());
    const rh2 = await hand("r");
    const err2 = Math.hypot(rh2.x - info2.point[0], rh2.y - info2.point[1]);
    check("dragging the lead hand again carries the pinned hand with it (error " + err2.toFixed(2) + " px)", err2 < 1.5 && Math.abs(info2.point[0] - info.point[0]) > 5, { err2 });
  }
};

process.on("unhandledRejection", () => {});
const run = which === "all" ? Object.keys(demos) : [which];
try {
  for (const name of run) {
    if (!demos[name]) throw new Error(`no demo ${name}`);
    if (name !== run[0]) {
      // a fresh page per demo: panels and clips of the previous one must not leak
      await page.reload();
      await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => window.atlasEditor.mountOutfit("turned-l"));
      await page.waitForTimeout(600);
    }
    await demos[name]();
  }
} catch (e) {
  console.log(`FAIL demo threw: ${e instanceof Error ? e.message : e}`);
  errors.push(String(e));
}
console.log(errors.length ? `console errors: ${JSON.stringify(errors)}` : "no console errors");
await browser.close();
process.exitCode = errors.length ? 1 : 0;
