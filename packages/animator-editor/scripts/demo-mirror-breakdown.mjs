// Demo of Mirror pose (M, Shift+M, arm / leg buttons) and the Breakdown slider (N) on the turned (pro) rig, with screenshots and checks.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-mirror-breakdown.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
// The turned rig's near and far setups differ by about 1.5 px (it is a side view), so "exact" mirror checks allow this much.
const TURNED_SETUP_PX = 2;
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/mirror-breakdown"));
const { url, dataDir } = await demoServer(process.argv[3]);
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
const shot = async (name, clip) => {
  await page.waitForTimeout(450);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};
const frame = async (f) => {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(250);
};
const world = (names) =>
  E((ns) => {
    const sk = window.atlasEditor.debug().skeleton;
    return Object.fromEntries(ns.map((n) => [n, { x: sk.findBone(n).world.x, y: sk.findBone(n).world.y }]));
  }, names);
const keyRotate = (bone, v) =>
  E(
    ([b, value]) => {
      const e = window.atlasEditor;
      e.select(b);
      e.rotate(b, value);
      e.key();
    },
    [bone, v]
  );
const keyMove = (bone, x, y) =>
  E(
    ([b, mx, my]) => {
      const e = window.atlasEditor;
      e.select(b);
      e.move(b, mx, my);
      e.key();
    },
    [bone, x, y]
  );
const clipNow = () => E(() => window.atlasEditor.state().clip);
const status = () => E(() => document.getElementById("status").textContent);

check("opens on the turned rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned");
await page.click("#newclip-open");
await page.fill("#newclip-name", "mirror_demo");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.fit());

// ---- cheat sheet
await page.keyboard.press("?");
await page.waitForTimeout(300);
const help = await E(() => document.getElementById("helpbody").innerText);
check("the cheat sheet lists M, Shift+M and N", /Mirror the selected/.test(help) && /Flip the whole pose/.test(help) && /Breakdown: key the selected/.test(help));
await shot("0-cheat-sheet.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- a one-sided pose at frame 0 (the torso stays upright, so a mirrored arm is the exact reflection in the world)
await frame(0);
for (const [b, v] of [["clavicle_near", 8], ["upper_arm_near", 62], ["forearm_near", -38], ["hand_near", 12], ["head", 14]]) await keyRotate(b, v);
await keyMove("foot_near_target", 0, -70);
await E(() => window.atlasEditor.select("upper_arm_near"));
await shot("1-posed-near-side.png");
const posed = await world(["hand_near", "hand_far", "foot_near", "foot_far", "head"]);

// ---- M: the selected bones only
await E(() => window.atlasEditor.selectBones(["upper_arm_near", "forearm_near", "hand_near"], "replace", "upper_arm_near"));
await page.keyboard.press("m");
await page.waitForTimeout(300);
let c = await clipNow();
check("M keys upper_arm_far, forearm_far and hand_far, and nothing else on the far arm", !!c.bones.upper_arm_far?.rotate && !!c.bones.forearm_far?.rotate && !!c.bones.hand_far?.rotate && !c.bones.clavicle_far, Object.keys(c.bones));
check("the keyed value is the mirrored one (setup +-4 deg: upper arm 62 near -> -62 far offset)", Math.abs(c.bones.upper_arm_far.rotate[0].value + 62) < 0.5, c.bones.upper_arm_far.rotate);
const afterM = await world(["hand_near", "hand_far"]);
check("with the clavicle left alone the far hand is not yet the mirror of the near hand", Math.abs(afterM.hand_far.y - afterM.hand_near.y) > 1, afterM);
await shot("2-m-selected-bones.png");

// ---- the whole arm
await E(() => window.atlasEditor.mirrorLimb("arm", "near"));
await page.waitForTimeout(300);
const arm = await world(["clavicle_near", "clavicle_far", "upper_arm_near", "upper_arm_far", "forearm_near", "forearm_far", "hand_near", "hand_far"]);
for (const n of ["clavicle", "upper_arm", "forearm", "hand"]) check(`${n}: far joint is the exact mirror image of the near joint`, Math.abs(arm[`${n}_far`].x + arm[`${n}_near`].x) < TURNED_SETUP_PX && Math.abs(arm[`${n}_far`].y - arm[`${n}_near`].y) < TURNED_SETUP_PX, { near: arm[`${n}_near`], far: arm[`${n}_far`] });
await shot("3-arm-near-to-far.png");

// ---- the leg (IK target)
await page.click("#mirror-leg-nf");
await page.waitForTimeout(300);
c = await clipNow();
check("Leg near to far keys the far foot target", !!c.bones.foot_far_target?.translate, c.bones.foot_far_target);
const leg = await world(["foot_near", "foot_far"]);
check("the far foot is lifted the same height as the near foot", Math.abs(leg.foot_far.y - leg.foot_near.y) < 0.5 && leg.foot_far.y < posed.foot_far.y - 30, { leg, rest: posed.foot_far });
await shot("4-leg-near-to-far.png");

// ---- far to near after changing the far arm
await keyRotate("upper_arm_far", -20);
await E(() => window.atlasEditor.mirrorLimb("arm", "far"));
await page.waitForTimeout(300);
const back = await world(["hand_near", "hand_far"]);
check("far arm to near arm: the near hand follows the far hand", Math.abs(back.hand_near.x + back.hand_far.x) < TURNED_SETUP_PX && Math.abs(back.hand_near.y - back.hand_far.y) < TURNED_SETUP_PX, back);

// ---- Shift+M flips a fresh one-sided pose (torso leaning, head tilted, one foot up) at frame 15
await frame(15);
for (const [b, v] of [["upper_arm_near", 80], ["forearm_near", -10], ["head", -18], ["spine_2", 7], ["spine_1", -8]]) await keyRotate(b, v);
await keyMove("foot_far_target", 6, -40);
const skeletonPos = () =>
  E(() => {
    const sk = window.atlasEditor.debug().skeleton;
    return Object.fromEntries(sk.bones.map((b) => [b.data.name, { x: b.world.x, y: b.world.y }]));
  });
const partners = await E(() => window.atlasEditor.mirrorPartners());
// The turned rig is a side view: the centre chain is not on x=0 and the hair pairs are not mirror images, so only the paired limb bones are reflected exactly.
const centre = [];
const reflectionError = (pre, post) => {
  let worst = { name: "", err: 0 };
  const note = (name, err) => err > worst.err && (worst = { name, err });
  // The shins are solved by the leg IK (both constraints bendPositive:false: the turned rig's knees both bend forward), so a knee is not a mirror image
  // of its partner; the feet (IK targets) and thighs are, and the knee side is checked on its own below.
  for (const [b, p] of Object.entries(partners)) if (!/^hair_|^(shin|knee)_/.test(b)) note(`${b}->${p}`, Math.hypot(post[p].x + pre[b].x, post[p].y - pre[b].y));
  for (const n of centre) note(n, Math.hypot(post[n].x + pre[n].x, post[n].y - pre[n].y));
  return worst;
};
const pre = await skeletonPos();
await shot("5-before-flip.png");
await page.keyboard.press("Shift+M");
await page.waitForTimeout(350);
const post = await skeletonPos();
const worst = reflectionError(pre, post);
check("Shift+M: every bone ends up where its partner was, reflected over the centre line (worst limb bone within the turned rig's own ~5 px near/far setup offset)", worst.err < 8, worst);
const kneeSide = (o, side) => Math.sign(o[`shin_${side}`].x - (o[`thigh_${side}`].x + o[`foot_${side}`].x) / 2);
check("Shift+M: the knees still bend forward on both legs (same screen side: the legs are IK with bendPositive false, not mirrored)", kneeSide(pre, "near") === kneeSide(post, "far") && kneeSide(pre, "far") === kneeSide(post, "near") && kneeSide(post, "near") === kneeSide(post, "far"), { pre: [kneeSide(pre, "near"), kneeSide(pre, "far")], post: [kneeSide(post, "near"), kneeSide(post, "far")] });
check("Shift+M: the head tilt goes the other way", pre.head.x * post.head.x < 0, { pre: pre.head, post: post.head });
check("Shift+M: the hands swap sides exactly", Math.abs(post.hand_far.x + pre.hand_near.x) < TURNED_SETUP_PX && Math.abs(post.hand_far.y - pre.hand_near.y) < TURNED_SETUP_PX, { preNear: pre.hand_near, postFar: post.hand_far });
await shot("6-after-flip.png");
await page.keyboard.press("Shift+M");
await page.waitForTimeout(350);
const twice = await skeletonPos();
check("flipping twice gives the original pose back", Object.keys(pre).every((n) => Math.abs(twice[n].x - pre[n].x) < 0.1 && Math.abs(twice[n].y - pre[n].y) < 0.1));

// ---- undo is one step per mirror
const keysBefore = JSON.stringify((await clipNow()).bones);
await page.keyboard.press("Shift+M");
await page.waitForTimeout(250);
check("the flip changed the clip", JSON.stringify((await clipNow()).bones) !== keysBefore);
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
check("one Ctrl+Z undoes the whole flip", JSON.stringify((await clipNow()).bones) === keysBefore);

// ---- Breakdown: a fresh clip, one bone with all four channels keyed at frames 5 and 25, breakdown at frame 15
await page.click("#newclip-open");
await page.fill("#newclip-name", "breakdown_demo");
await page.click("#newclip-make");
await page.waitForTimeout(300);
const keyAll = (f, rot, mv, sc, sh) =>
  E(
    ([bone, rotate, move, scale, shear]) => {
      const e = window.atlasEditor;
      e.select(bone);
      e.rotate(bone, rotate);
      e.move(bone, move[0], move[1]);
      e.scale(bone, scale[0], scale[1]);
      e.shear(bone, shear[0], shear[1]);
      e.keyScale(bone);
      e.keyShear(bone);
      e.key();
    },
    ["upper_arm_far", rot, mv, sc, sh]
  );
await frame(5);
await keyAll(5, 10, [0, 0], [1, 1], [0, 0]);
await frame(25);
await keyAll(25, 90, [30, -12], [1.3, 0.8], [16, 0]);
c = await clipNow();
const chans = ["rotate", "translate", "scale", "shear"].map((ch) => [ch, c.bones.upper_arm_far?.[ch]?.map((k) => Math.round(k.time * 30))]);
check("setup for the breakdown: frames 5 and 25 hold rotate, translate, scale and shear keys", chans.every(([, f]) => f?.length === 2 && f[0] === 5 && f[1] === 25), chans);
await frame(15);
await E(() => window.atlasEditor.select("upper_arm_far"));
await shot("7-breakdown-panel.png");

const keyAt15 = async () => {
  const cl = await clipNow();
  const at = (ks) => ks?.find((k) => Math.abs(k.time - 15 / 30) < 1e-3);
  const b = cl.bones.upper_arm_far;
  return { rotate: at(b.rotate)?.value, translate: at(b.translate), scale: at(b.scale), shear: at(b.shear) };
};
const presetPercents = await E(() => [...document.querySelectorAll("#bdpresets button")].map((b) => Number(b.textContent)));
check("quick buttons 0, 25, 33, 50, 66, 75, 100", JSON.stringify(presetPercents) === JSON.stringify([0, 25, 33, 50, 66, 75, 100]), presetPercents);
const range = await E(() => ({ min: document.getElementById("bdslider").min, max: document.getElementById("bdslider").max }));
check("the slider runs from -50 to 150", range.min === "-50" && range.max === "150", range);
const shots = { 0: "8-breakdown-0.png", 33: "9-breakdown-33.png", 50: "10-breakdown-50.png", 100: "11-breakdown-100.png" };
for (const p of [0, 25, 33, 50, 66, 75, 100]) {
  await page.click(`#bdpresets button[data-percent="${p}"]`);
  await page.waitForTimeout(250);
  const k = await keyAt15();
  const f = p / 100;
  const ok =
    Math.abs(k.rotate - (10 + 80 * f)) < 0.01 &&
    Math.abs(k.translate?.x - 30 * f) < 0.01 &&
    Math.abs(k.translate?.y + 12 * f) < 0.01 &&
    Math.abs(k.scale?.x - (1 + 0.3 * f)) < 0.01 &&
    Math.abs(k.scale?.y - (1 - 0.2 * f)) < 0.01 &&
    Math.abs(k.shear?.x - 16 * f) < 0.01;
  check(`${p}% button keys rotate, translate, scale and shear ${p}% of the way`, ok, k);
  if (shots[p]) await shot(shots[p]);
}
const drag = async (values) =>
  E((vs) => {
    const s = document.getElementById("bdslider");
    for (const v of vs) {
      s.value = String(v);
      s.dispatchEvent(new Event("input", { bubbles: true }));
    }
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, values);
await drag([-10, -30, -50]);
let k = await keyAt15();
check("slider at -50% overshoots behind the previous key (rotate -30, translate x -15)", Math.abs(k.rotate + 30) < 0.01 && Math.abs(k.translate.x + 15) < 0.01, k);
await shot("12-breakdown-minus50-overshoot.png");
await drag([120, 150]);
k = await keyAt15();
check("slider at 150% overshoots past the next key (rotate 130, scale x 1.45)", Math.abs(k.rotate - 130) < 0.01 && Math.abs(k.scale.x - 1.45) < 0.01, k);
await shot("13-breakdown-150-overshoot.png");
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
k = await keyAt15();
check("Ctrl+Z undoes the whole second drag at once (back to -50%)", Math.abs(k.rotate + 30) < 0.01, k);
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
k = await keyAt15();
check("...and the first drag at once (back to the 100% button)", Math.abs(k.rotate - 90) < 0.01, k);
await E(() => {
  document.getElementById("bdslider").value = "25";
  document.getElementById("bdvalue").value = "25";
});
await page.keyboard.press("n");
await page.waitForTimeout(250);
k = await keyAt15();
check("N keys the breakdown at the slider's value (25%: rotate 30)", Math.abs(k.rotate - 30) < 0.01, k);
await E(() => window.atlasEditor.select("hand_far"));
await page.keyboard.press("n");
await page.waitForTimeout(200);
const msg = await status();
check("a bone with no key either side is refused with a message", /need a key before and after/.test(msg), msg);
await E(() => window.atlasEditor.select("upper_arm_far"));
await page.click('#bdpresets button[data-percent="50"]');
await shot("14-final.png");

check("no page errors", errors.length === 0, errors);
await browser.close();
process.exit(failed ? 1 : 0);
