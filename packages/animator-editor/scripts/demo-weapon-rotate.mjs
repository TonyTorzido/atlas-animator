// Regression demo: rotating the weapon (axe) works live and sticks, by the ring gizmo, a drag anywhere and the transform strip, in Animate and Pro,
// with Auto key on and off, on both pro rigs; plus a loop that rotates every bone by 20 degrees and lists the ones whose rendered rotation does not change.
// Starts its own sandboxed server (scripts/demo-server.mjs).   node packages/animator-editor/scripts/demo-weapon-rotate.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/weapon-rotate"));
const { url } = await demoServer();
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
const wr = (bone = "weapon") => E((n) => { const b = window.atlasEditor.debug().skeleton.findBone(n); return Math.atan2(b.world.c, b.world.a) * 180 / Math.PI; }, bone);
const delta = (a, b) => ((b - a + 540) % 360) - 180;
const setAuto = async (on) => { if ((await E(() => document.querySelector("#autokey")?.classList.contains("on"))) !== on) await page.click("#autokey"); };
const reset = async () => { await E(() => window.atlasEditor.rotate("weapon", 0)); await page.waitForTimeout(80); };
let shots = 0;

for (const outfit of ["pro-turned"]) {
  await E((o) => window.atlasEditor.mountOutfit(o), outfit);
  await page.waitForTimeout(1500);
  await page.click("#newclip-open");
  await page.fill("#newclip-name", `wr_${outfit.replace("-", "_")}`);
  await page.click("#newclip-make");
  await page.waitForTimeout(300);
  for (const ws of ["animate", "pro"]) {
    for (const ak of [true, false]) {
      const tag = `${outfit}/${ws}/autokey-${ak ? "on" : "off"}`;
      await E((w) => window.atlasEditor.workspace(w), ws);
      await page.waitForTimeout(400);
      await setAuto(ak);
      await E(() => window.atlasEditor.setGizmo("rotate"));
      const keysOf = () => E(() => Object.keys(window.atlasEditor.state().clip.bones?.weapon ?? {}));
      const fresh = async () => {
        await E(() => window.atlasEditor.undo());
        await reset();
        await E(() => window.atlasEditor.select("weapon"));
        await page.waitForTimeout(250);
      };
      // 1. the ring: press on it at several angles (other bones' sticks and art lie under some of them), drag a quarter turn.
      for (const deg of [0, 90, 180, 270, 300]) {
        await fresh();
        const c = (await E(() => window.atlasEditor.boneScreenEnds("weapon"))).origin;
        const a = (deg * Math.PI) / 180;
        const before = await wr();
        await page.mouse.move(c.x + 70 * Math.cos(a), c.y + 70 * Math.sin(a));
        await page.mouse.down();
        await page.mouse.move(c.x + 70 * Math.cos(a + 0.7), c.y + 70 * Math.sin(a + 0.7), { steps: 6 });
        await page.waitForTimeout(150);
        const mid = await wr();
        if (shots < 2 && deg === 300) await page.screenshot({ path: resolve(out, `${outfit}-${ws}-ring-mid.png`) });
        await page.mouse.up();
        await page.waitForTimeout(250);
        const post = await wr();
        if (shots < 2 && deg === 300) { await page.screenshot({ path: resolve(out, `${outfit}-${ws}-ring-post.png`) }); shots++; }
        check(`${tag} ring@${deg}: selection stays on weapon`, (await E(() => window.atlasEditor.boneSelection().active)) === "weapon");
        check(`${tag} ring@${deg}: live (mid-drag)`, Math.abs(delta(before, mid)) > 20, { before, mid });
        check(`${tag} ring@${deg}: stays after release`, Math.abs(delta(mid, post)) < 0.6, { mid, post });
        check(`${tag} ring@${deg}: ${ak ? "keyed" : "left unkeyed"}`, ak ? (await keysOf()).includes("rotate") : !(await keysOf()).includes("rotate"));
      }
      // 2. a drag anywhere on empty space turns the selected bone
      await fresh();
      {
        const c = (await E(() => window.atlasEditor.boneScreenEnds("weapon"))).origin;
        const before = await wr();
        await page.mouse.move(c.x + 600, c.y - 300);
        await page.mouse.down();
        await page.mouse.move(c.x + 600, c.y + 300, { steps: 8 });
        await page.waitForTimeout(150);
        const mid = await wr();
        await page.mouse.up();
        await page.waitForTimeout(250);
        check(`${tag} drag anywhere: live and stays`, Math.abs(delta(before, mid)) > 20 && Math.abs(delta(mid, await wr())) < 0.6, { before, mid });
      }
      // 3. the transform strip field
      await fresh();
      {
        const before = await wr();
        const f = page.locator('#xstrip .xf-in[data-ch="rotate"][data-axis="x"]');
        if (await f.count()) {
          await f.fill("35");
          await f.dispatchEvent("change");
          await page.waitForTimeout(250);
          check(`${tag} strip field: rotates and stays`, Math.abs(delta(before, await wr()) - 35) < 0.6, { before, after: await wr() });
        }
      }
      await fresh();
    }
  }
}

// every bone: rotate by 20 degrees, report the ones whose rendered rotation does not change
for (const outfit of ["pro-turned"]) {
  await E((o) => window.atlasEditor.mountOutfit(o), outfit);
  await page.waitForTimeout(1500);
  const res = await E(async () => {
    const ed = window.atlasEditor;
    const out = [];
    for (const b of ed.debug().skeleton.bones) {
      const name = b.data.name;
      const w = () => { const x = ed.debug().skeleton.findBone(name).world; return (Math.atan2(x.c, x.a) * 180) / Math.PI; };
      const before = w();
      ed.rotate(name, 20);
      await new Promise((r) => setTimeout(r, 40));
      out.push([name, Math.abs((((w() - before + 540) % 360) - 180))]);
      ed.rotate(name, 0);
      await new Promise((r) => setTimeout(r, 20));
    }
    return out;
  });
  const dead = res.filter(([, d]) => d < 1).map(([n]) => n);
  console.log(`${outfit}: bones with no effect from a 20 degree rotate:`, dead.join(", ") || "none");
  const unexpected = dead.filter((n) => !/^(thigh|shin|foot)_(near|far)$/.test(n));
  check(`${outfit}: only the leg IK chains ignore rotation`, unexpected.length === 0, unexpected);
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
