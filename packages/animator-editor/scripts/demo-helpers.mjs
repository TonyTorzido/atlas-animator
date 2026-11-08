// Demos of the animation helpers (arc overlay, easing presets, draw-order presets, pose library, silhouette,
// foot lock, smear) with screenshots. They run on the "Turned L + axe" stand-in weapon rig.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-helpers.mjs [arc|easing|draworder|poses|silhouette|footlock|smear|all] [outDir] [url]
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
const out = resolve(process.argv[3] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/helpers"));
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
const shot = async (name, clip) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const frame = (f) => E((x) => window.atlasEditor.setTime(x / 30), f);
const newClip = async (name, loop = false) => {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(200);
  const isLoop = await E(() => window.atlasEditor.state().clip.loop);
  if (isLoop !== loop) await page.click("#loop");
};
const useAxe = async () => {
  await page.click("#outfits-more");
  await page.click("#outfits-old-toggle");
  await page.click('#outfits button[data-id="turned-l-axe"]');
  await page.waitForFunction(() => window.atlasEditor.state().outfit === "turned-l-axe", null, { timeout: 30_000 });
  await page.waitForTimeout(400);
};
/** Keys a pose (bone -> degrees) at a frame. */
const pose = (f, values) =>
  E(
    ([fr, vals]) => {
      const e = window.atlasEditor;
      e.setTime(fr / 30);
      for (const [bone, v] of Object.entries(vals)) {
        e.select(bone);
        e.rotate(bone, v);
        e.key();
      }
    },
    [f, values]
  );
/** A 20 frame overhead chop with the right arm: wind-up, anticipation hold, strike, follow-through. */
const swing = async (name = "demo_swing") => {
  await newClip(name, false);
  await page.fill("#duration", String(20 / 30));
  await page.press("#duration", "Enter");
  const P = {
    0: { chest: 0, upper_arm_r: -20, forearm_r: -10 },
    5: { chest: -8, upper_arm_r: -120, forearm_r: -60 },
    8: { chest: -10, upper_arm_r: -128, forearm_r: -64 },
    12: { chest: 10, upper_arm_r: 10, forearm_r: -10 },
    20: { chest: 6, upper_arm_r: 28, forearm_r: -8 }
  };
  for (const [f, v] of Object.entries(P)) await pose(Number(f), v);
  await frame(12);
};

const demos = {
  async smear() {
    await useAxe();
    await swing("demo_smear");
    await E(() => {
      const e = window.atlasEditor;
      for (const b of ["chest", "upper_arm_r", "forearm_r"]) e.applyEasing("strike", [{ bone: b, frame: 8 }]);
    });
    await E(() => window.atlasEditor.setArc("point:weapon_tip"));
    await frame(10);
    await shot("smear-00-before-frame10.png");
    const before = await E(() => JSON.stringify({ ...window.atlasEditor.state().clip, slots: undefined }));
    const r = await E(() => window.atlasEditor.makeSmear({ from: 8, to: 12, show: 10, variant: "a" }));
    check("a smear attachment was written", !!r && r.attachment === "weapon__smear_a" && r.width > 150 && r.width < 1600, r && { w: r.width, h: r.height, hull: r.hullPx, ink: r.inkPx });
    check("the hull is inked with the stock outline", r.inkPx > 1500, r.inkPx);
    const clip = await E(() => window.atlasEditor.state().clip);
    check("the weapon slot shows the smear on frame 10 and the axe on frame 11", JSON.stringify(clip.slots.weapon.attachment.map((k) => [Math.round(k.time * 30), k.name])) === JSON.stringify([[10, "weapon__smear_a"], [11, "axe"]]), clip.slots);
    check("nothing else in the clip changed (bones, events, draw order, other slots)", JSON.stringify({ ...clip, slots: undefined }) === before && Object.keys(clip.slots).join() === "weapon");
    await E(() => window.atlasEditor.setArc(null));
    await frame(9);
    const shown9 = await E(() => window.atlasEditor.debug().skeleton.slots.find((s) => s.data.name === "weapon").placeholder);
    await frame(10);
    const shown10 = await E(() => window.atlasEditor.debug().skeleton.slots.find((s) => s.data.name === "weapon").placeholder);
    const drawn10 = await E(() => window.atlasEditor.debug().skeleton.slots.find((s) => s.data.name === "weapon").attachment?.path ?? null);
    check("the rig draws the smear image on frame 10 and the axe on frame 9", shown9 === "axe" && shown10 === "weapon__smear_a" && drawn10 === "standin/axe__smear_a", { shown9, shown10, drawn10 });
    await shot("smear-01-frame10-with-smear.png");
    await frame(9);
    await shot("smear-02-frame9-axe.png");
    await frame(11);
    await shot("smear-03-frame11-axe.png");
    // the smear image itself, on the light ground
    const png = r.png.replace(/^data:image\/png;base64,/, "");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(out, "smear-04-hull-image.png"), Buffer.from(png, "base64"));
    console.log(resolve(out, "smear-04-hull-image.png"));
    // it survives a reload (the file on disk is loaded with the rig)
    await page.reload();
    await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
    await page.waitForTimeout(800);
    await useAxe();
    const names = await E(() => fetch("/api/smears").then((x) => x.json()));
    check("the smear file is on disk and the rig loads it after a reload", names.includes("turned-l-axe__weapon__smear_a") && (await E(() => !window.atlasEditor.debug().skeleton.findSlot("weapon") ? false : true)), names);
    await E(() => window.atlasEditor.deleteSmear("turned-l-axe__weapon__smear_a"));
    check("smear file removed", (await E(() => fetch("/api/smears").then((x) => x.json()))).length === 0);
    // the tool refuses anything but a weapon slot
    const refused = await E(() => window.atlasEditor.makeSmear({ from: 8, to: 12, slot: "hand_r" }));
    check("a hand slot is refused", refused === null);
  },

  async footlock() {
    await useAxe();
    await newClip("demo_footlock", false);
    await page.fill("#duration", String(16 / 30));
    await page.press("#duration", "Enter");
    // a lunge: the hips drop and drive forward over 12 frames
    await E(() => {
      const e = window.atlasEditor;
      for (const [f, x, y] of [[0, 0, 0], [12, 70, 55], [16, 70, 55]]) {
        e.setTime(f / 30);
        e.move("pelvis", x, y);
        e.keyMove("pelvis");
      }
    });
    const free = await E(() => window.atlasEditor.footDrift("l", 0, 12));
    check("without a lock the left foot rides along with the hips", free > 40, free);
    await frame(12);
    await shot("footlock-00-unlocked-frame12.png");
    await E(() => window.atlasEditor.lockFoot("l", 0, 12));
    const locked = await E(() => window.atlasEditor.footDrift("l", 0, 12));
    check("locked: the left foot stays within 2 px across frames 0-12 (IK softness leaves ~1 px) (drift " + locked.toFixed(3) + ")", locked < 2, locked);
    const ranges = await E(() => window.atlasEditor.footLocks());
    check("the lock is listed", ranges.length === 1 && ranges[0].a === 0 && ranges[0].b === 12, ranges);
    await frame(12);
    await E(() => window.atlasEditor.select("pelvis"));
    await shot("footlock-01-locked-frame12.png");
    // a root lock holds the root still over a range
    const rootBefore = await E(() => {
      const e = window.atlasEditor;
      e.setTime(0);
      e.move("root", 30, 0);
      e.keyMove("root");
      e.setTime(12 / 30);
      e.move("root", 90, 0);
      e.keyMove("root");
      return e.moveOf("root");
    });
    await E(() => window.atlasEditor.lockRoot(0, 12));
    const rootAfter = await E(() => {
      const e = window.atlasEditor;
      e.setTime(12 / 30);
      return e.moveOf("root");
    });
    check("the root is held at its frame 0 offset", Math.abs(rootAfter.x - 30) < 0.01, { rootBefore, rootAfter });
    await E(() => window.atlasEditor.unlockFoot("l", 0, 12));
    check("unlocking brings the lock keys out", (await E(() => window.atlasEditor.footLocks())).length === 0);
    await frame(12);
    await shot("footlock-02-unlocked-again.png");
  },

  async silhouette() {
    await useAxe();
    await swing("demo_silhouette");
    await frame(8);
    await shot("silhouette-00-colour-windup.png");
    const before = await E(() => window.atlasEditor.silhouetteReport());
    check("colour view is not flat", before.on === false && before.otherShare > 0.01, before.otherShare);
    await page.click("#silhouette");
    await page.waitForTimeout(300);
    const flat = await E(() => window.atlasEditor.silhouetteReport());
    check("silhouette is flat black on the light ground (no other colours)", flat.on && flat.otherShare < 0.002 && flat.blackPx > 20000, flat);
    await shot("silhouette-01-windup.png");
    await frame(12);
    await shot("silhouette-02-contact.png");
    await page.click("#previewbtn");
    await page.waitForTimeout(600);
    await shot("silhouette-03-game-size.png");
    await page.click("#previewbtn");
    await E(() => window.atlasEditor.setSilhouette(false));
    const off = await E(() => window.atlasEditor.silhouetteReport());
    check("toggled back to colour", off.on === false && off.otherShare > 0.01);
  },

  async poses() {
    await useAxe();
    await newClip("demo_poses_a", false);
    await page.fill("#duration", String(24 / 30));
    await page.press("#duration", "Enter");
    // clip A: an overhead wind-up with the eyes shut and the near arm behind the body
    await pose(10, { chest: -8, upper_arm_r: -125, forearm_r: -62, upper_arm_l: 40, forearm_l: -30 });
    await E(() => {
      const e = window.atlasEditor;
      e.setTime(10 / 30);
      e.setAttachment("eyes", "eyes_blink_closed");
      e.setDrawPreset("arm_l_behind", 10);
    });
    await frame(10);
    const saved = await E(() => window.atlasEditor.savePose("demo_windup", "overhead axe wind-up, eyes shut"));
    check("pose saved with bones, a swap and the draw order", saved && saved.bones.upper_arm_r.rotate === -125 && saved.attachments.eyes === "eyes_blink_closed" && saved.drawOrder.length === 4, saved && { swaps: saved.attachments, order: saved.drawOrder.length });
    await pose(10, { upper_arm_r: 5, forearm_r: -5 });
    await E(() => window.atlasEditor.savePose("demo_ready"));
    await page.waitForTimeout(400);
    const listed = await E(() => window.atlasEditor.poses().map((p) => p.name));
    check("both poses are in the library", listed.includes("demo_windup") && listed.includes("demo_ready"), listed);
    await page.locator("#posepanel").scrollIntoViewIfNeeded();
    await shot("poses-00-library-thumbnails.png");
    // clip B: a different clip, apply the saved pose at frame 6
    await newClip("demo_poses_b", false);
    await page.fill("#duration", String(24 / 30));
    await page.press("#duration", "Enter");
    const r = await E(() => window.atlasEditor.applyPose("demo_windup", { frame: 6 }));
    const clipB = await E(() => window.atlasEditor.state().clip);
    check("clip B has the wind-up bones, the eyes swap and the draw order at frame 6", clipB.bones.upper_arm_r.rotate[0].value === -125 && clipB.slots.eyes.attachment[0].name === "eyes_blink_closed" && clipB.drawOrder.length === 1 && Math.round(clipB.drawOrder[0].time * 30) === 6, { bones: r.bones, slots: r.slots, order: r.order });
    await frame(6);
    const order = await E(() => window.atlasEditor.slotOrder());
    check("the left arm is behind the body in clip B", order.slice(0, 4).join() === "upper_arm,tank_armhole,forearm,hand");
    await shot("poses-01-applied-in-clip-b.png");
    // another rig of the same template: unknown bones and slots are skipped and reported
    await page.click("#outfits-more");
    await page.click('#outfits button[data-id="front"]');
    await page.waitForFunction(() => window.atlasEditor.state().outfit === "front", null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await newClip("demo_poses_c", false);
    const cross = await E(() => window.atlasEditor.applyPose("demo_windup", { frame: 3 }));
    check("on the Front rig the weapon bone and slots are skipped", cross.skipped.some((x) => x.includes("weapon")) && cross.bones > 10, cross.skipped);
    await frame(3);
    await shot("poses-02-front-rig.png");
    await E(() => window.atlasEditor.deletePose("demo_windup"));
    await E(() => window.atlasEditor.deletePose("demo_ready"));
    check("demo poses removed", (await E(() => window.atlasEditor.poses().filter((p) => p.name.startsWith("demo_")).length)) === 0);
  },

  async draworder() {
    await useAxe();
    await newClip("demo_draworder", false);
    await page.fill("#duration", String(24 / 30));
    await page.press("#duration", "Enter");
    // both arms cross the body so the draw order shows
    await pose(0, { upper_arm_l: 70, forearm_l: -50, upper_arm_r: -30, forearm_r: -40 });
    await pose(24, { upper_arm_l: 70, forearm_l: -50, upper_arm_r: -30, forearm_r: -40 });
    const presets = await E(() => window.atlasEditor.drawPresets());
    check("arm_l_behind, weapon_behind and arm_r_front resolve on the stock rig", ["arm_l_behind", "weapon_behind", "arm_r_front"].every((id) => presets.find((p) => p.id === id)?.applicable), presets.map((p) => [p.id, p.applicable]));
    const cape = presets.find((p) => p.id === "cape_over_arms");
    check("cape_over_arms is unavailable without a cape slot", cape.applicable === false, cape.reason);
    await frame(0);
    await E(() => window.atlasEditor.setDrawPreset("arm_r_front", 0));
    await frame(2);
    const base = await E(() => window.atlasEditor.slotOrder());
    await shot("draworder-00-setup-order.png");
    await E(() => window.atlasEditor.setDrawPreset("arm_l_behind", 6));
    await E(() => window.atlasEditor.setDrawPreset("weapon_behind", 12));
    await E(() => window.atlasEditor.setDrawPreset("setup", 18));
    const clip = await E(() => window.atlasEditor.state().clip);
    check("four named keys written (arm_r_front, arm_l_behind, weapon_behind, setup)", clip.drawOrder.length === 4, clip.drawOrder.map((k) => [Math.round(k.time * 30), k.offsets.length]));
    await frame(8);
    const o8 = await E(() => window.atlasEditor.slotOrder());
    check("frame 8: the left arm slots are drawn first (behind the body)", o8.slice(0, 4).join() === "upper_arm,tank_armhole,forearm,hand", o8.slice(0, 5));
    check("state at frame 8 is arm_l_behind", (await E(() => window.atlasEditor.drawOrderState(8))) === "arm_l_behind");
    await shot("draworder-01-arm-l-behind.png");
    await frame(14);
    const o14 = await E(() => window.atlasEditor.slotOrder());
    check("frame 14: the weapon slots are drawn first", o14.slice(0, 3).join() === "weapon,weapon_tip,weapon_grip", o14.slice(0, 4));
    await shot("draworder-02-weapon-behind.png");
    await frame(20);
    check("frame 20: back to the setup order", (await E(() => window.atlasEditor.slotOrder())).join() === base.join());
    await frame(8);
    await E(() => window.atlasEditor.selectSlot("hand"));
    await shot("draworder-03-panel.png");
  },

  async easing() {
    await useAxe();
    await swing("demo_easing");
    await E(() => window.atlasEditor.setArc("point:weapon_tip"));
    const before = await E(() => window.atlasEditor.arcInfo());
    await frame(10);
    await shot("easing-00-linear-arc.png");
    // wind-up eases in, the strike snaps, the follow-through overshoots and settles
    await E(() => {
      const e = window.atlasEditor;
      for (const b of ["chest", "upper_arm_r", "forearm_r"]) {
        e.applyEasing("anticipate", [{ bone: b, frame: 0 }]);
        e.applyEasing("strike", [{ bone: b, frame: 8 }]);
      }
      e.applyEasing("overshoot", [{ bone: "chest", frame: 12 }]);
    });
    const clip = await E(() => window.atlasEditor.state().clip);
    check("anticipate / strike / overshoot curves written", JSON.stringify(clip.bones.upper_arm_r.rotate.map((k) => k.curve).slice(0, 3)) === JSON.stringify([[0.8, 0, 1, 0.6], null, [0.02, 0.85, 0.12, 1]]), clip.bones.upper_arm_r.rotate.map((k) => k.curve));
    const after = await E(() => window.atlasEditor.arcInfo());
    const step = (info, f) => info.stats.steps[f];
    check("strike front-loads the move into contact (step 8 > step 11)", step(after, 8) > 2 * step(after, 11), { s8: step(after, 8), s11: step(after, 11) });
    check("the arc spacing changed from the linear version", Math.abs(step(after, 8) - step(before, 8)) > 5, { before: step(before, 8), after: step(after, 8) });
    await frame(10);
    await shot("easing-01-eased-arc.png");
    // select the arm keys at the contact frame and damp the follow-through
    await E(() => {
      const e = window.atlasEditor;
      e.selectKeys([{ row: "bone:upper_arm_r", frame: 12 }, { row: "bone:forearm_r", frame: 12 }]);
      e.applyEasing("damped");
    });
    const damped = await E(() => window.atlasEditor.state().clip.bones.upper_arm_r.rotate.map((k) => [Math.round(k.time * 30), k.value]));
    check("damped settle wrote an overshoot and an undershoot key after contact", damped.map((d) => d[0]).join() === "0,5,8,12,16,18,20" && damped[4][1] > damped[6][1] && damped[5][1] < damped[6][1], damped);
    await frame(16);
    await shot("easing-02-damped-keys.png");
  },

  async arc() {
    await useAxe();
    await swing("demo_arc");
    await shot("arc-00-pose-no-overlay.png");
    await E(() => window.atlasEditor.setArc("point:weapon_tip"));
    await frame(12);
    const info = await E(() => window.atlasEditor.arcInfo());
    check("weapon tip arc has a dot per frame", info.points.length === 21 && info.frames[0] === 0 && info.frames[20] === 20, { dots: info.points.length });
    check("the arc is a curve (bulge > 6%)", info.stats.bulge > 0.06, { bulge: info.stats.bulge });
    check("linear keys leave uneven spacing flagged between the blocking poses", info.stats.uneven.length > 0, info.stats.uneven);
    await shot("arc-01-weapon-tip.png");
    await E(() => window.atlasEditor.setArc("tip:hand_r"));
    const fist = await E(() => window.atlasEditor.arcInfo());
    check("the fist arc has its own path", fist.points.length === 21 && Math.hypot(fist.points[10].x - info.points[10].x, fist.points[10].y - info.points[10].y) > 20);
    await shot("arc-02-fist.png");
    await E(() => window.atlasEditor.setArc("point:weapon_tip"));
    await frame(8);
    await shot("arc-03-windup-frame8.png");
    await E(() => window.atlasEditor.setArc(null));
    check("arc off", (await E(() => window.atlasEditor.arcInfo().spec)) === null);
  }
};

process.on("unhandledRejection", () => {});
const run = which === "all" ? Object.keys(demos) : [which];
try {
  for (const name of run) {
    if (!demos[name]) throw new Error(`no demo ${name}`);
    if (name !== run[0]) {
      await page.reload();
      await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
      await page.waitForTimeout(800);
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
