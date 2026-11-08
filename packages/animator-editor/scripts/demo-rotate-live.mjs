// Regression demo for "the rotate ring counts the angle but the bone does not move": a bone the user rotates turns live on the canvas
// during the drag (the RENDERED attachment mesh, not just the skeleton) and keeps the angle on release. Checked with NO clip open (the
// pose is kept as a working pose) and with a clip (Auto key on and off), with the leather skin worn, on the weapon, a plain bone
// (forearm) and a bone under a live IK constraint (the drag turns the constraint's target and the arm stays held).
// Starts its own sandboxed server (scripts/demo-server.mjs).   node packages/animator-editor/scripts/demo-rotate-live.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/rotate-live"));
const { url } = await demoServer();
const ONLY_CLIP = process.env.ONLY_CLIP === "1"; // skip the no-clip block (to see the clip case on its own)
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 2400, height: 1300 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
const delta = (a, b) => ((b - a + 540) % 360) - 180;
// The rendered attachment: the angle of the first edge of the slot's Pixi mesh (what the canvas draws), after the last render.
const meshAngle = (slotName) =>
  E((n) => {
    const { skeleton, character } = window.atlasEditor.debug();
    const i = skeleton.drawOrder.findIndex((s) => s.data.name === n);
    const m = character.slotMeshes[i];
    const p = m.geometry.attributes.aPosition.buffer.data;
    // The vector from the first vertex to the one farthest from it: it turns with the bone whatever the mesh's vertex order.
    let far = 1;
    let best = -1;
    for (let k = 1; k < p.length / 2; k++) {
      const d = Math.hypot(p[2 * k] - p[0], p[2 * k + 1] - p[1]);
      if (d > best) { best = d; far = k; }
    }
    return (Math.atan2(p[2 * far + 1] - p[1], p[2 * far] - p[0]) * 180) / Math.PI;
  }, slotName);
// What the canvas draws for a bone with several (or hidden) meshes: the summed vertex positions of every visible mesh.
const meshSig = () =>
  E(() => {
    const { character } = window.atlasEditor.debug();
    let sx = 0;
    let sy = 0;
    for (const m of character.slotMeshes) {
      if (!m.visible) continue;
      const p = m.geometry.attributes.aPosition.buffer.data;
      for (let k = 0; k < p.length; k += 2) { sx += p[k]; sy += p[k + 1]; }
    }
    return [sx, sy];
  });
const boneAngle = (bone) => E((n) => { const b = window.atlasEditor.debug().skeleton.findBone(n); return (Math.atan2(b.world.c, b.world.a) * 180) / Math.PI; }, bone);
const setAuto = async (on) => { if ((await E(() => document.querySelector("#autokey")?.classList.contains("on"))) !== on) await page.click("#autokey"); };
let shots = 0;

await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
// Wear the leather skin (the user's setup).
await E(() => [...document.querySelectorAll('#skinpanel .skinrow[data-skin="chest.leather"] button')].find((b) => /Wear/.test(b.textContent))?.click());
await page.waitForTimeout(800);
check("leather skin is worn", (await E(() => window.atlasEditor.skins().active)).includes("chest.leather"), await E(() => window.atlasEditor.skins().active));
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setGizmo("rotate"));

// [label, bone] (the bone's own slot mesh must turn)
const cases = [
  ["weapon", "weapon"],
  ["forearm", "forearm_near"]
];

// The weapon is checked on its own rendered mesh; any other bone on its world angle plus the summed vertices of everything drawn.
const measure = (bone) => (bone === "weapon" ? meshAngle("weapon") : boneAngle(bone));

const dragRing = async (bone, tag, shotName) => {
  const c = (await E((n) => window.atlasEditor.boneScreenEnds(n), bone)).origin;
  const R = 70;
  const a0 = -0.6;
  const at = (a) => [c.x + R * Math.cos(a), c.y + R * Math.sin(a)];
  const slot = bone === "weapon" ? "weapon mesh" : `${bone} (world)`;
  const before = await measure(bone);
  const sig0 = await meshSig();
  await page.mouse.move(...at(a0));
  await page.mouse.down();
  const seen = [before];
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(...at(a0 + (i * 1.3) / 24)); // small steps, 75 degrees in all
    if (i % 4 === 0) {
      await page.waitForTimeout(40);
      seen.push(await measure(bone));
    }
  }
  const mid = seen[seen.length - 1];
  if (shotName) await page.screenshot({ path: resolve(out, `${shotName}-mid.png`) });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const post = await measure(bone);
  const sig1 = await meshSig();
  const rot = { x: Number(await E(() => document.querySelector('#xstrip .xf-in[data-ch="rotate"][data-axis="x"]')?.value)) };
  if (shotName) await page.screenshot({ path: resolve(out, `${shotName}-post.png`) });
  const steps = seen.slice(1).map((v, i) => Math.abs(delta(seen[i], v)));
  check(`${tag}: rendered ${slot} turns live (mid-drag)`, Math.abs(delta(before, mid)) > 40, { before, mid });
  check(`${tag}: the drawn meshes changed`, Math.abs(sig1[0] - sig0[0]) + Math.abs(sig1[1] - sig0[1]) > 1, { sig0, sig1 });
  check(`${tag}: it turns progressively, not only at the end`, steps.filter((s) => s > 3).length >= 4, steps.map((s) => Math.round(s)));
  check(`${tag}: it stays after mouseup`, Math.abs(delta(mid, post)) < 0.6, { mid, post });
  check(`${tag}: the Rotate field keeps the angle (not back to 0)`, Math.abs(rot?.x ?? 0) > 20, rot);
};

const reset = async () => {
  for (const [, b] of cases) await E((n) => window.atlasEditor.rotate(n, 0), b);
  await page.waitForTimeout(100);
};

// 1. NO clip (the rig ships none): the pose is a working pose.
check("no clip is open", (await E(() => window.atlasEditor.state().clipName)) === "");
for (const ak of ONLY_CLIP ? [] : [true, false]) {
  await setAuto(ak);
  for (const [label, bone] of cases) {
    await reset();
    await E((b) => window.atlasEditor.select(b), bone);
    await page.waitForTimeout(250);
    await dragRing(bone, `no clip / auto key ${ak ? "on" : "off"} / ${label}`, shots++ < 2 && label === "weapon" ? `noclip-${label}` : null);
    check(`no clip / auto key ${ak ? "on" : "off"} / ${label}: no phantom clip was created`, (await E(() => window.atlasEditor.state().clipName)) === "");
  }
}

// 2. A clip: auto key on keys the bone, off leaves it unkeyed; live and sticky either way.
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "rot_live");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
await E(() => window.atlasEditor.setGizmo("rotate"));
for (const ak of [true, false]) {
  await setAuto(ak);
  for (const [label, bone] of cases) {
    await E(() => window.atlasEditor.undo());
    await reset();
    await E((b) => window.atlasEditor.select(b), bone);
    await page.waitForTimeout(250);
    await dragRing(bone, `clip / auto key ${ak ? "on" : "off"} / ${label}`, label === "weapon" ? `clip-${label}-autokey-${ak ? "on" : "off"}` : null);
    const keys = await E((b) => Object.keys(window.atlasEditor.state().clip.bones?.[b] ?? {}), bone);
    check(`clip / auto key ${ak ? "on" : "off"} / ${label}: ${ak ? "keyed" : "left unkeyed"}`, ak ? keys.includes("rotate") : !keys.includes("rotate"), keys);
  }
}

// 3. A bone under a live IK constraint: the drag turns the constraint's target, the arm follows and stays held.
{
  // Keep IK live + drag the near hand once with the Hand IK tool: keys the constraint on (mix 1) and the target.
  await setAuto(true);
  await E(() => { window.atlasEditor.setGizmo("ik"); window.atlasEditor.setIkLive(true); });
  await E(() => window.atlasEditor.select("hand_near"));
  const h = (await E(() => window.atlasEditor.boneScreenEnds("hand_near"))).origin;
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x - 60, h.y - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check("IK clip keyed", (await E(() => window.atlasEditor.state().clip.ik?.hand_ik_near ?? [])).some((k) => k.mix === 1));
  await setAuto(true);
  await E(() => window.atlasEditor.setGizmo("rotate"));
  const mix = await E(() => window.atlasEditor.debug().skeleton.ikConstraints.find((c) => c.data.name === "hand_ik_near")?.pose.mix);
  check("hand IK is live (mix 1)", mix === 1, mix);
  await E(() => window.atlasEditor.select("forearm_near"));
  await page.waitForTimeout(250);
  const c = (await E(() => window.atlasEditor.boneScreenEnds("forearm_near"))).origin;
  const before = await boneAngle("forearm_near");
  const handPos = () => E(() => { const b = window.atlasEditor.debug().skeleton.findBone("hand_near"); return [b.world.x, b.world.y]; });
  const tgt = () => E(() => { const b = window.atlasEditor.debug().skeleton.findBone("hand_near_target"); return [b.world.x, b.world.y]; });
  const tgt0 = await tgt();
  await page.mouse.move(c.x + 70, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(c.x + 70 * Math.cos((i * 1.3) / 24), c.y + 70 * Math.sin((i * 1.3) / 24));
  await page.waitForTimeout(80);
  const mid = await boneAngle("forearm_near");
  const handMid = await handPos();
  const tgtMid = await tgt();
  await page.screenshot({ path: resolve(out, "ik-forearm-mid.png") });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const post = await boneAngle("forearm_near");
  const tgt1 = await tgt();
  check("IK forearm: the arm moves live (its target is dragged)", Math.abs(delta(before, mid)) > 3 && Math.hypot(tgtMid[0] - tgt0[0], tgtMid[1] - tgt0[1]) > 5, { before, mid, tgt0, tgtMid });
  const sh = await E(() => { const b = window.atlasEditor.debug().skeleton.findBone("upper_arm_near"); return [b.world.x, b.world.y]; });
  const reach = Math.hypot(tgtMid[0] - sh[0], tgtMid[1] - sh[1]);
  // The target can be out of the arm's reach (here it is): the held hand then sits at full stretch, on the line to the target.
  const stretch = Math.hypot(handMid[0] - sh[0], handMid[1] - sh[1]);
  check("IK forearm: the hand stays held on the arm (at the target, or at full stretch toward it)", Math.abs(stretch - Math.min(reach, 184.4)) < 12, { stretch, reach });
  check("IK forearm: stays after release", Math.abs(delta(mid, post)) < 1 && Math.hypot(tgt1[0] - tgtMid[0], tgt1[1] - tgtMid[1]) < 1, { mid, post });
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
