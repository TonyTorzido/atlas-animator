// Interaction demos of the editor polish pass (hotkeys, selection, canvas, compensate, rotation snap, layout, ready stance).
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-polish.mjs [hotkeys|selection|canvas|compensate|rotation|layout|stance|all] [outDir] [url]
// Drives the editor with real mouse and keyboard events (not the atlasEditor shortcuts) on "Straight front (pro)".
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
const out = resolve(process.argv[3] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/polish"));
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
const E = (fn, arg) => page.evaluate(fn, arg);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(400);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const state = () => E(() => window.atlasEditor.state());
const screenOf = (bone) => E((b) => window.atlasEditor.boneScreenPos(b), bone);
const newClip = async (name, loop = false) => {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(200);
  const isLoop = await E(() => window.atlasEditor.state().clip.loop);
  if (isLoop !== loop) await page.click("#loop");
};


const ends = (bone) => E((b) => window.atlasEditor.boneScreenEnds(b), bone);
const sel = () => E(() => window.atlasEditor.boneSelection());
const keysOf = () => E(() => Object.keys(window.atlasEditor.state().clip.bones ?? {}));
const rotOf = (bone) => E((b) => { const sk = window.atlasEditor.debug().skeleton.findBone(b); return sk.pose.rotation - sk.data.rotation; }, bone);

const dragMove = async (name, dx, dy, at = "mid") => {
  await page.keyboard.press("t");
  const p = (await ends(name))[at];
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};
const dragRot = async (name, deg) => {
  await page.keyboard.press("r");
  const { origin: o, mid: m } = await ends(name);
  const a0 = Math.atan2(m.y - o.y, m.x - o.x);
  const r = Math.hypot(m.x - o.x, m.y - o.y);
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const a = a0 + (i / 8) * (deg * Math.PI) / 180;
    await page.mouse.move(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
};

const demos = {
  async selection() {
    await newClip("polish_selection");
    await E(() => window.atlasEditor.select(null));
    const upper = await ends("upper_arm_near");
    await page.mouse.click(upper.mid.x, upper.mid.y);
    let s = await sel();
    check("click selects the bone", s.active === "upper_arm_near" && s.names.length === 1, JSON.stringify(s));
    const far = await ends("upper_arm_far");
    await page.keyboard.down("Shift");
    await page.mouse.click(far.mid.x, far.mid.y);
    await page.keyboard.up("Shift");
    s = await sel();
    check("Shift click adds a bone", s.names.length === 2 && s.active === "upper_arm_far", JSON.stringify(s));
    await page.keyboard.down("Control");
    await page.mouse.click(far.mid.x, far.mid.y);
    await page.keyboard.up("Control");
    s = await sel();
    check("Ctrl click toggles it off", s.names.length === 1 && s.active === "upper_arm_near", JSON.stringify(s));
    // re-add and rotate both with one drag
    await page.keyboard.down("Shift");
    await page.mouse.click(far.mid.x, far.mid.y);
    await page.keyboard.up("Shift");
    await shot("selection-multi.png");
    const before = [await rotOf("upper_arm_near"), await rotOf("upper_arm_far")];
    const o = (await ends("upper_arm_far")).origin;
    const m = (await ends("upper_arm_far")).mid;
    const a0 = Math.atan2(m.y - o.y, m.x - o.x);
    const r = Math.hypot(m.x - o.x, m.y - o.y);
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      const a = a0 + (i / 8) * (40 * Math.PI) / 180;
      await page.mouse.move(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = [await rotOf("upper_arm_near"), await rotOf("upper_arm_far")];
    const d = after.map((v, i) => v - before[i]);
    check("rotating the multi-selection turns both bones by the same angle", Math.abs(d[0] - d[1]) < 0.5 && Math.abs(d[0]) > 20, `deltas ${d.map((v) => v.toFixed(1))}`);
    const keyed = await keysOf();
    check("both bones got keys from the one drag", keyed.includes("upper_arm_near") && keyed.includes("upper_arm_far"), keyed.join(","));
    await shot("selection-rotated.png");
    // box select the head and neck from empty space
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const head = await ends("head");
    const neck = await ends("neck");
    const x0 = head.mid.x - 150;
    const y0 = Math.min(head.tip.y, head.origin.y) - 30;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 150, y0 + 100, { steps: 5 });
    await page.mouse.move(neck.origin.x + 150, neck.origin.y + 20, { steps: 5 });
    await shot("selection-box.png");
    await page.mouse.up();
    s = await sel();
    check("box select takes the bones inside", s.names.includes("head") && s.names.includes("neck"), JSON.stringify(s));
    await page.mouse.click(x0, y0 - 10);
    s = await sel();
    check("a click on empty space clears the selection", s.names.length === 0, JSON.stringify(s));
    const hidden = await E(() => window.atlasEditor.hiddenHelpers());
    check("IK targets with mix 0 are hidden helpers", hidden.includes("hand_near_target") && !hidden.includes("foot_near_target"), hidden.join(","));
    const picked = await E(() => {
      const b = window.atlasEditor.debug().skeleton.findBone("hand_near_target");
      return window.atlasEditor.pickAt(b.world.x, b.world.y);
    });
    check("a hidden helper is never picked", picked !== "hand_near_target", String(picked));
  },
  async canvas() {
    await newClip("polish_canvas");
    await E(() => window.atlasEditor.fit());
    await page.waitForTimeout(100);
    const viewOf = () => E(() => window.atlasEditor.view());
    const settle = async () => {
      for (let i = 0; i < 60; i++) {
        if (!(await viewOf()).goal) return;
        await page.waitForTimeout(50);
      }
    };
    const head = await ends("head");
    const z0 = (await viewOf()).zoom;
    await page.mouse.move(head.mid.x, head.mid.y);
    await page.mouse.wheel(0, -400);
    const seen = [];
    for (let i = 0; i < 40; i++) {
      seen.push((await viewOf()).zoom);
      if (!(await viewOf()).goal) break;
      await page.waitForTimeout(16);
    }
    await settle();
    const z1 = (await viewOf()).zoom;
    const between = seen.filter((z) => z > z0 * 1.02 && z < z1 * 0.98);
    check("wheel zooms in smoothly (intermediate frames)", z1 > z0 * 1.5 && between.length >= 2, `${z0.toFixed(3)} -> ${z1.toFixed(3)}, ${between.length} in-between samples`);
    const head2 = await ends("head");
    check("the point under the cursor stays put", Math.hypot(head2.mid.x - head.mid.x, head2.mid.y - head.mid.y) < 2, `moved ${Math.hypot(head2.mid.x - head.mid.x, head2.mid.y - head.mid.y).toFixed(2)} px`);
    await page.mouse.wheel(0, 400);
    await settle();
    const z2 = (await viewOf()).zoom;
    check("wheel back out returns near the start", Math.abs(z2 - z0) / z0 < 0.02, `${z2.toFixed(3)}`);
    // pan: middle drag, then Space + drag
    const v0 = await viewOf();
    await page.mouse.move(300, 500);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(380, 540, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    const v1 = await viewOf();
    check("middle drag pans", Math.abs(v1.x - v0.x - 80) < 1 && Math.abs(v1.y - v0.y - 40) < 1, `${v1.x - v0.x}, ${v1.y - v0.y}`);
    await page.keyboard.down(" ");
    await page.mouse.move(300, 500);
    await page.mouse.down();
    await page.mouse.move(250, 470, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up(" ");
    const v2 = await viewOf();
    check("Space + drag pans", Math.abs(v2.x - v1.x + 50) < 1 && Math.abs(v2.y - v1.y + 30) < 1, `${v2.x - v1.x}, ${v2.y - v1.y}`);
    check("a Space drag does not toggle playback", !(await E(() => document.getElementById("play").classList.contains("on"))));
    await E(() => window.atlasEditor.fit());
    await E(() => window.atlasEditor.select("hand_near"));
    await page.keyboard.press("f");
    await settle();
    const v3 = await viewOf();
    const hand = await ends("hand_near");
    const box = await E(() => { const r = document.getElementById("view").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    check("F frames the selected bone (zoomed in, centred)", v3.zoom > z0 * 1.5 && Math.hypot((hand.origin.x + hand.tip.x) / 2 - box.x, (hand.origin.y + hand.tip.y) / 2 - box.y) < 60, `zoom ${v3.zoom.toFixed(2)}`);
    await shot("canvas-framed-hand.png");
    await page.keyboard.press("Shift+F");
    await settle();
    check("Shift+F fits the whole character again", Math.abs((await viewOf()).zoom - z0) / z0 < 0.02);
  },
  async compensate() {
    await newClip("polish_compensate");
    await E(() => window.atlasEditor.fit());
    await page.waitForTimeout(100);
    const worldOf = (b) => E((n) => { const k = window.atlasEditor.debug().skeleton.findBone(n); return { x: k.world.x, y: k.world.y, a: (Math.atan2(k.world.c, k.world.a) * 180) / Math.PI }; }, b);
    const dragArm = async (deg) => {
      await E(() => window.atlasEditor.select("upper_arm_near"));
      const { origin: o, mid: m } = await ends("upper_arm_near");
      const a0 = Math.atan2(m.y - o.y, m.x - o.x);
      const r = Math.hypot(m.x - o.x, m.y - o.y);
      await page.mouse.move(m.x, m.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        const a = a0 + (i / 8) * (deg * Math.PI) / 180;
        await page.mouse.move(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
      }
      await page.mouse.up();
      await page.waitForTimeout(250);
    };
    const start = await worldOf("forearm_near");
    await dragArm(40);
    const off = await worldOf("forearm_near");
    check("without Compensate the forearm swings with its parent", Math.hypot(off.x - start.x, off.y - start.y) > 20 || Math.abs(off.a - start.a) > 20, `moved ${Math.hypot(off.x - start.x, off.y - start.y).toFixed(1)} px`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    await page.keyboard.press("c");
    check("C turns Compensate on", (await state()).compensate === true && (await E(() => document.getElementById("compensate").classList.contains("on"))));
    await dragArm(40);
    const on = await worldOf("forearm_near");
    check("with Compensate the forearm stays where it was", Math.hypot(on.x - start.x, on.y - start.y) < 0.6 && Math.abs(on.a - start.a) < 0.6, `moved ${Math.hypot(on.x - start.x, on.y - start.y).toFixed(2)} px, ${(on.a - start.a).toFixed(2)} deg`);
    const keyed = await keysOf();
    check("the forearm got its compensating key", keyed.includes("upper_arm_near") && keyed.includes("forearm_near"), keyed.join(","));
    await shot("compensate-on.png");
    await page.keyboard.press("c");
  },
  async rotation() {
    await newClip("polish_rotation");
    await E(() => window.atlasEditor.fit());
    await E(() => window.atlasEditor.select("upper_arm_near"));
    await page.waitForTimeout(100);
    // Shift snaps a drag to 15 degrees
    const { origin: o, mid: m } = await ends("upper_arm_near");
    const a0 = Math.atan2(m.y - o.y, m.x - o.x);
    const r = Math.hypot(m.x - o.x, m.y - o.y);
    const base = await rotOf("upper_arm_near");
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      const a = a0 + (i / 6) * (37 * Math.PI) / 180;
      await page.mouse.move(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
    }
    await page.keyboard.down("Shift");
    const a = a0 + (37 * Math.PI) / 180;
    await page.mouse.move(o.x + Math.cos(a) * r + 1, o.y + Math.sin(a) * r);
    await shot("rotation-snap-drag.png");
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(150);
    const snapped = (await rotOf("upper_arm_near")) - base;
    check("Shift snaps the rotate drag to 15 degrees", Math.abs(snapped % 15) < 0.01 && Math.abs(snapped) >= 15, `offset ${snapped.toFixed(2)}`);
    // numeric entry: Enter commits and keys, Esc reverts
    const field = page.locator("#xstrip .xf-in[data-ch=rotate]").first();
    await field.click();
    await page.keyboard.type("20");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("Enter commits the typed angle", Math.abs((await rotOf("upper_arm_near")) - 20) < 0.01, `${(await rotOf("upper_arm_near")).toFixed(2)}`);
    check("the keyboard is back on the editor after Enter", await E(() => document.activeElement === document.body));
    await field.click();
    await page.keyboard.type("55");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    check("Esc reverts the field", Math.abs((await rotOf("upper_arm_near")) - 20) < 0.01 && (await field.inputValue()) === "20.00", await field.inputValue());
    // copy the selected bones' pose, paste it on another frame
    await page.keyboard.press("Escape");
    await E(() => window.atlasEditor.select("upper_arm_near"));
    await page.click("#copyposesel");
    await E(() => window.atlasEditor.setTime(10 / 30));
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(150);
    const bones = await E(() => window.atlasEditor.state().clip.bones);
    const rot = bones.upper_arm_near?.rotate ?? [];
    check("Copy selected + Ctrl+V keys the selected bone on frame 10", rot.some((k) => Math.abs(k.time - 10 / 30) < 1e-3 && Math.abs(k.value - 20) < 0.01), JSON.stringify(rot.map((k) => [k.time, k.value])));
    check("only the selected bone was pasted", Object.keys(bones).length === 1, Object.keys(bones).join(","));
  },
  async layout() {
    await newClip("polish_layout");
    const sizes = [[1280, 720], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080]];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      await E(() => window.atlasEditor.fit());
      const m = await E(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const clipped = [];
        for (const sel of ["header", ".transport", "#left", "#right", "footer"]) {
          for (const n of document.querySelectorAll(sel)) if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== "auto") clipped.push(`${sel}:${n.scrollWidth}>${n.clientWidth}`);
        }
        const v = r("view");
        const tl = r("timeline");
        return { view: [Math.round(v.width), Math.round(v.height)], timeline: [Math.round(tl.width), Math.round(tl.height)], docOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, clipped, headerH: Math.round(document.querySelector("header").getBoundingClientRect().height) };
      });
      const area = (m.view[0] * m.view[1]) / (w * h);
      check(`${w}x${h}: nothing clipped or overflowing`, !m.docOverflow && m.clipped.length === 0, `${JSON.stringify(m)}`);
      check(`${w}x${h}: the canvas is the largest area`, m.view[0] * m.view[1] > m.timeline[0] * m.timeline[1] && area > 0.3, `canvas ${m.view.join("x")} = ${(area * 100).toFixed(0)}% of the window`);
      await shot(`layout-${w}x${h}.png`);
    }
    await page.setViewportSize({ width: 1680, height: 1000 });
  },
  async friction() {
    // The friction points found while posing the ready stance, as regression checks.
    const sel0 = await sel();
    check("a rig that has no upper_arm_l still opens with a real bone selected", sel0.active === "upper_arm_near", JSON.stringify(sel0));
    await E(() => window.atlasEditor.fit());
    await page.waitForTimeout(100);
    // a plain click on a bone never keys it
    const up = await ends("upper_arm_near");
    await page.mouse.click(up.mid.x, up.mid.y);
    await page.mouse.move(up.mid.x, up.mid.y);
    await page.mouse.down();
    await page.mouse.move(up.mid.x + 1, up.mid.y + 1);
    await page.mouse.up();
    await page.waitForTimeout(150);
    check("a click (or a 1 px jitter) on a bone does not key it", (await keysOf()).length === 0, (await keysOf()).join(","));
    // dropdowns and buttons hand the keyboard back
    // user_pose.clip.json is the user's own clip (not in the sandbox data dir): any other clip does the same job here.
    await page.selectOption("#clip", (await E(() => [...document.getElementById("clip").options].some((o) => o.value === "clip:user_pose"))) ? "clip:user_pose" : "clip:polish_selection");
    await page.keyboard.press("t");
    check("hotkeys work right after picking from the clip dropdown", (await state()).gizmoMode === "move");
    await page.click("#autokey");
    await page.click("#autokey");
    await page.keyboard.press("r");
    check("hotkeys work right after clicking a button", (await state()).gizmoMode === "rotate");
    // an IK-driven foot drags its target
    await dragMove("foot_near", -50, 0, "origin");
    const afterFoot = await state();
    check("dragging a driven foot moves its IK target (not a dead key on the foot)", afterFoot.selected === "foot_near_target" && Object.keys(afterFoot.clip.bones).includes("foot_near_target") && !Object.keys(afterFoot.clip.bones).includes("foot_near"), Object.keys(afterFoot.clip.bones).join());
    // Hand IK and the two-hand grip work on the near / far rig
    await page.keyboard.press("h");
    const ikPanelTop = await E(() => document.getElementById("ikpanel").getBoundingClientRect().top - document.getElementById("detail").getBoundingClientRect().bottom);
    check("the Hand IK panel sits right under the bone panel", ikPanelTop < 30, `${ikPanelTop}px below it`);
    await page.locator("#ikpanel input[type=checkbox]:not(#ikliveopt)").check();
    await dragRot("upper_arm_near", -50);
    await page.keyboard.press("h");
    await page.getByRole("button", { name: "Pin other hand now" }).click();
    await page.waitForTimeout(250);
    const bones = Object.keys((await state()).clip.bones);
    check("Pin other hand keys the far arm on the pro rig", bones.includes("upper_arm_far") && bones.includes("forearm_far"), bones.join(","));
    const grip = await E(() => window.atlasEditor.gripInfo());
    check("the grip point resolves on the pro rig", Array.isArray(grip.point), JSON.stringify(grip.point));
    // collapsible panels
    const collapsed = await E(() => document.getElementById("arcpanel").classList.contains("collapsed"));
    check("rarely used panels start folded", collapsed);
    await page.click("#arcpanel h2");
    check("a click on a panel heading unfolds it", !(await E(() => document.getElementById("arcpanel").classList.contains("collapsed"))));
    await page.click("#arcpanel h2");
  },
  async stance() {
    // Pose a ready stance with the axe on "Straight front (pro)" the way the user would: real mouse and keys only.
    await E(() => window.atlasEditor.fit());
    await page.waitForTimeout(150);
    await shot("stance-0-start.png");
    await dragMove("foot_near", -45, 0, "origin");
    await dragMove("foot_far", 45, 0, "origin");
    await dragMove("pelvis", 0, 22);
    await shot("stance-1-legs.png");
    await dragRot("upper_arm_near", -35);
    await dragRot("forearm_near", -30);
    await page.keyboard.press("h");
    await page.locator("#ikpanel input[type=checkbox]:not(#ikliveopt)").check();
    await page.getByRole("button", { name: "Pin other hand now" }).click();
    await page.keyboard.press("r");
    await shot("stance-2-arms.png");
    // lean the chest a touch with Shift snap, then frame the upper body
    await E(() => window.atlasEditor.select("spine_2"));
    await dragRot("spine_2", -12);
    await E(() => window.atlasEditor.select("head"));
    await page.keyboard.press("f");
    await page.waitForTimeout(700);
    await shot("stance-3-framed.png");
    await page.keyboard.press("Shift+F");
    await page.waitForTimeout(700);
    const gates = await E(() => window.atlasEditor.gatesNow());
    const bad = (gates?.issues ?? gates ?? []).filter?.((g) => g.severity === "error") ?? [];
    check("the stance has no blocking gate errors", bad.length === 0, bad.map((g) => g.message).join(" | "));
    await shot("stance-4-final.png");
  },
  async hotkeys() {
    await newClip("polish_hotkeys");
    await page.keyboard.press("Home");
    await page.keyboard.press("t");
    check("T selects the move tool", (await state()).gizmoMode === "move");
    await page.keyboard.press("r");
    check("R selects the rotate tool", (await state()).gizmoMode === "rotate");
    await page.keyboard.press("s");
    check("S selects the Scale gizmo (the scale branch)", (await state()).gizmoMode === "scale" && (await E(() => document.querySelector('#gizmo button[data-mode="scale"]').classList.contains("on"))));
    await page.keyboard.press("r");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    { const st = await state(); check("Right steps frames", Math.abs(st.time - 2 / 30) < 1e-6, JSON.stringify({ time: st.time, clip: st.clipName, dur: st.clip.duration })); }
    await page.keyboard.press("End");
    check("End goes to the last frame", Math.abs((await state()).time - 1) < 1e-6);
    await page.keyboard.press("Home");
    check("Home goes to frame 0", (await state()).time === 0);
    await page.keyboard.press("?");
    check("? opens the cheat sheet", await E(() => document.getElementById("help").classList.contains("open")));
    await shot("hotkeys-cheatsheet.png");
    await page.keyboard.press("Escape");
    check("Esc closes the cheat sheet", !(await E(() => document.getElementById("help").classList.contains("open"))));
  }
};

const names = which === "all" ? Object.keys(demos) : which.split(",");
for (const n of names) {
  if (!demos[n]) throw new Error(`unknown demo ${n}`);
  console.log(`--- ${n}`);
  await demos[n]();
}
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || errors.length ? 1 : 0);
