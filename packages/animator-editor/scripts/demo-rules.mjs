// Demo of the live rule checker overlay (ruleOverlay.ts) on the pro-turned rig: breaks each rule in turn and checks the matching chip
// turns red with its first bad frame, the red ticks appear on the timeline, a click on the chip jumps to the frame and selects the bone,
// and undoing the break turns everything green again. Screenshots go to docs/plans/atlas-animator-demos/editor/rules/.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-rules.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = resolve(args[0] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/rules"));
const { url } = await demoServer(args[1]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 900 } }), { workspace: "animate" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.evaluate(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForFunction(() => window.atlasEditor.state().outfit === "pro-turned", null, { timeout: 30_000 });
await page.waitForTimeout(600);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(450);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const FRAME = 12;
/** The broken-rule chips (the strip lists only those, and only after the pill is clicked). */
const chips = async () => {
  await E(() => {
    const p = document.getElementById("rules-pill");
    if (p && p.classList.contains("bad") && p.getAttribute("aria-expanded") !== "true") p.click();
  });
  return E(() => [...document.querySelectorAll("#rulechips .rule-chip")].map((c) => ({ rule: c.dataset.rule, bad: c.classList.contains("bad"), frame: c.dataset.frame ? Number(c.dataset.frame) : null, bone: c.dataset.bone ?? null, text: c.textContent })));
};
/** Red tick columns in the timeline ruler, counted from the canvas pixels. */
const ticks = () =>
  E(() => {
    const c = document.getElementById("tl");
    const g = c.getContext("2d");
    const y = Math.round(3 * (window.devicePixelRatio || 1));
    const row = g.getImageData(0, y, c.width, 1).data;
    let runs = 0;
    let inRun = false;
    for (let x = 0; x < c.width; x++) {
      const red = row[x * 4] > 220 && row[x * 4 + 1] < 110 && row[x * 4 + 2] < 110;
      if (red && !inRun) runs++;
      inRun = red;
    }
    return runs;
  });
const settle = () => page.waitForTimeout(700);
let n = 0;
const newClip = async () => {
  // Animate hides the New clip controls (clips come from the board), so a scratch clip is made from Pro and the demo returns to Animate.
  await E(() => window.atlasEditor.workspace("pro"));
  await page.click("#newclip-open");
  await page.fill("#newclip-name", `rules_${++n}`);
  await page.click("#newclip-make");
  await page.waitForTimeout(250);
  await E(() => window.atlasEditor.workspace("animate"));
  await page.waitForTimeout(150);
  await E(() => window.atlasEditor.setTime(12 / 30));
};
const undoAll = async () => {
  for (let i = 0; i < 8 && Object.keys(await E(() => window.atlasEditor.state().clip.bones ?? {})).length; i++) await E(() => window.atlasEditor.undo());
};
/** Finds a rotation of `bone` (pending, unkeyed) that makes `kind` show up in the pose gates. */
const searchRot = (bone, kind) =>
  E(
    ([b, k]) => {
      const e = window.atlasEditor;
      e.select(b);
      for (let v = -180; v <= 180; v += 6) {
        e.rotate(b, v);
        if (e.gatesNow().some((i) => i.kind === k)) return v;
      }
      e.rotate(b, 0);
      return null;
    },
    [bone, kind]
  );

// Baseline: everything green on an empty clip.
await newClip();
await settle();
const base = await chips();
const pillText = await E(() => document.getElementById("rules-pill").textContent);
check("the pill says all rules OK and lists no chips on an empty clip", base.length === 0 && pillText.startsWith("Rules: all OK"), pillText);
check("no ticks on a clean clip", (await ticks()) === 0);
await shot("0-all-green.png");

const BREAKS = [
  {
    rule: "fist on own arm",
    file: "1-fist-off-arm.png",
    // a rest key at frame 0 first, so the fist drifts off its arm over the clip and the first bad frame is after 0
    firstAfterZero: true,
    run: () =>
      E(() => {
        const e = window.atlasEditor;
        e.select("hand_near");
        e.setTime(0);
        e.move("hand_near", 0, 0);
        e.keyMove("hand_near");
        e.setTime(12 / 30);
        e.move("hand_near", 40, 0);
        e.keyMove("hand_near");
      })
  },
  {
    rule: "limb stretch",
    file: "2-limb-stretched.png",
    run: () => E(() => { const e = window.atlasEditor; e.select("forearm_near"); e.move("forearm_near", 30, 0); e.keyMove("forearm_near"); })
  },
  {
    rule: "limb scale",
    file: "3-limb-scaled.png",
    run: () => E(() => { const e = window.atlasEditor; e.select("forearm_near"); e.scale("forearm_near", 1.4, 1.4); e.keyScale("forearm_near"); })
  },
  {
    rule: "head scale",
    file: "4-head-size.png",
    run: () => E(() => { const e = window.atlasEditor; e.select("head"); e.scale("head", 1.25, 1.25); e.keyScale("head"); })
  },
  {
    rule: "arm behind head",
    file: "5-arm-behind-head.png",
    run: async () => {
      if ((await searchRot("upper_arm_near", "arm behind head")) === null) return false;
      await E(() => window.atlasEditor.key());
    }
  },
  {
    rule: "upper arm thrown back",
    file: "6-arm-thrown-back.png",
    run: async () => {
      if ((await searchRot("upper_arm_near", "upper arm thrown back")) === null) return false;
      await E(() => window.atlasEditor.key());
    }
  },
  {
    rule: "weapon across face",
    file: "7-axe-across-face.png",
    run: async () => {
      // Sweep the upper arm and forearm in 5 degree steps (the face is narrow now), collect every pose that puts the axe across it and use
      // the middle one, so the weapon sits well inside the face rather than grazing its edge. The rule itself is not loosened.
      const found = await E(() => {
        const e = window.atlasEditor;
        const hits = [];
        for (let a = -180; a <= 180; a += 5) {
          for (let f = -150; f <= 150; f += 5) {
            e.select("upper_arm_near");
            e.rotate("upper_arm_near", a);
            e.select("forearm_near");
            e.rotate("forearm_near", f);
            if (e.gatesNow().some((i) => i.kind === "weapon across face")) hits.push([a, f]);
          }
        }
        if (!hits.length) return null;
        const mid = hits[Math.floor(hits.length / 2)];
        e.select("upper_arm_near");
        e.rotate("upper_arm_near", mid[0]);
        e.select("forearm_near");
        e.rotate("forearm_near", mid[1]);
        return e.gatesNow().some((i) => i.kind === "weapon across face") ? mid : null;
      });
      if (!found) return false;
      await E(() => {
        const e = window.atlasEditor;
        e.select("upper_arm_near");
        e.key();
        e.select("forearm_near");
        e.key();
      });
    }
  }
];

for (const br of BREAKS) {
  await newClip();
  const ok = await br.run();
  await settle();
  const chip = (await chips()).find((x) => x.rule === br.rule);
  check(`${br.rule}: chip is red with a first bad frame (a single key holds from frame 0)`, ok !== false && !!chip?.bad && chip.frame >= (br.firstAfterZero ? 1 : 0) && chip.frame <= FRAME, chip);
  const t = await ticks();
  check(`${br.rule}: ticks on the timeline`, t >= 1, t);
  await shot(br.file);
  if (chip?.bad) {
    await E(() => window.atlasEditor.setTime(0));
    await page.waitForTimeout(200);
    await page.click(`#rulechips .rule-chip[data-rule="${br.rule}"]`);
    await page.waitForTimeout(300);
    const st = await E(() => ({ frame: Math.round(window.atlasEditor.state().time * 30), sel: window.atlasEditor.boneSelection().active }));
    check(`${br.rule}: clicking the chip jumps to frame ${chip.frame} and selects ${chip.bone}`, st.frame === chip.frame && st.sel === chip.bone, st);
  }
  await undoAll();
  await settle();
  const after = await chips();
  const t2 = await ticks();
  check(`${br.rule}: restored, all chips green and no ticks`, after.every((x) => !x.bad) && t2 === 0, { bad: after.filter((x) => x.bad).map((x) => x.rule), ticks: t2 });
}

// Eyes widen: this rig's eyes ride the head bone, so a clip cannot widen them; the only route is an eye look outside the allowed list.
await newClip();
const eyes = await E(() => {
  try {
    window.atlasEditor.setSetupPlaceholder("eyes", "eyes_angry");
    return window.atlasEditor.gatesNow().some((i) => i.kind === "eyes widen");
  } catch (error) {
    return String(error);
  }
});
await settle();
const ec = (await chips()).find((x) => x.rule === "eyes widen");
check("eyes widen: chip red when the eyes show a look that is not allowed", eyes === true && !!ec?.bad, { eyes, ec });
await shot("8-eyes-widen.png");

// Pro shows the strip too; the toggle hides the chips; Rig does not show the strip.
await E(() => window.atlasEditor.workspace("pro"));
await page.waitForTimeout(400);
check("strip shows in Pro", await E(() => getComputedStyle(document.getElementById("rulestrip")).display !== "none"));
await shot("9-pro-workspace.png");
// One pill is the whole control: it opens a popover whose footer button turns the checker off; the pill then reads "Rules: off".
await E(() => {
  const p = document.getElementById("rules-pill");
  if (p.getAttribute("aria-expanded") !== "true") p.click();
});
await page.waitForTimeout(200);
await page.click("#rules-toggle");
await page.waitForTimeout(300);
check("turning the checker off hides the popover", await E(() => document.getElementById("rulechips").hidden));
check("the pill reads Rules: off", (await E(() => document.getElementById("rules-pill").textContent)) === "Rules: off");
await shot("10-toggle-off.png");
await page.click("#rules-pill");
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(300);
check("strip hidden in Rig", await E(() => getComputedStyle(document.getElementById("rulestrip")).display === "none"));
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
