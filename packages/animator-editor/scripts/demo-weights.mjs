// Demo of the Weights tool (weightsTool.ts) in a sandbox (scripts/demo-server.mjs; never port 5211):
//   Turned L rig, torso skin mesh (339 vertices, arm bones), paint forearm_l, Bend test at 90 degrees, smooth the elbow with the real
//   brush (mouse strokes), check the elbow weights got smoother, then time the brush.
//   node packages/animator-editor/scripts/demo-weights.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/weights"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1800, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name, clip) => {
  await page.waitForTimeout(500);
  const file = resolve(out, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};

await E(() => window.atlasEditor.mountOutfit("turned-l"));
await page.waitForTimeout(1500);
await page.click("#tp-weights");
await page.waitForTimeout(500);
await E(() => window.atlasEditor.selectSlot("torso"));
await page.waitForTimeout(600);
check("the real Weights panel replaces the placeholder", (await page.locator("#wt-root").count()) === 1 && (await page.locator("#setup-coming-weights").count()) === 0);
const st0 = await E(() => window.atlasWeights.state());
check("torso skin mesh is loaded", st0.addr?.name === "skin" && st0.vertices === 339, st0);
await E(() => window.atlasWeights.setActive("forearm_l"));
await page.waitForTimeout(300);
check("heat map draws as a vertex-colour mesh", (await E(() => window.atlasWeights.state().heatKind)) === "mesh", await E(() => window.atlasWeights.state().heatKind));

// Frame the arm: zoom in on the elbow.
const elbow = await E(() => window.atlasWeights.bone("forearm_l"));
const at = await E((p) => window.atlasWeights.client(p[0], p[1]), elbow);
await page.mouse.move(at.x, at.y);
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -240);
await page.waitForTimeout(500);
await shot("0-rest-heat");

// Bend test at 90 degrees through the real slider.
await E(() => {
  const r = document.getElementById("wt-bend");
  r.value = "90";
  r.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
const st1 = await E(() => window.atlasWeights.state());
const hidden = await E(() => window.atlasEditor.hiddenSlots());
check("bend 90 shows the skin overlay and hides the real slot", st1.bend === 90 && st1.skinOverlay && hidden.includes("torso"), { ...st1, hidden });
const rough0 = await E((p) => window.atlasWeights.roughness(p[0], p[1], 90), elbow);
const at2 = await E((p) => window.atlasWeights.client(p[0], p[1]), elbow);
const clip = { x: Math.max(0, at2.x - 330), y: Math.max(0, at2.y - 300), width: 660, height: 600 };
await shot("1-before-bend90");
await shot("1b-before-bend90-closeup", clip);

// Smooth the elbow: four passes of the Smooth brush around the elbow pivot, each pass one stroke (one undo step each).
await E(() => window.atlasWeights.setBrush({ mode: "smooth", radiusPx: 95, strength: 1 }));
const undoBefore = await E(() => window.atlasEditor.setupState());
for (let pass = 0; pass < 6; pass++) {
  // A plus-shaped sweep over the elbow, so every vertex around the crease is hit from several sides.
  const pts = [[-70, 0], [70, 0], [0, -70], [0, 70], [-50, -50], [50, 50]];
  const [a, b] = [pts[(pass * 2) % 6], pts[(pass * 2 + 1) % 6]];
  await page.mouse.move(at2.x + a[0], at2.y + a[1]);
  await page.mouse.down();
  for (let k = 0; k <= 16; k++) await page.mouse.move(at2.x + a[0] + ((b[0] - a[0]) * k) / 16, at2.y + a[1] + ((b[1] - a[1]) * k) / 16);
  await page.mouse.up();
  await page.waitForTimeout(800);
}
const rough1 = await E((p) => window.atlasWeights.roughness(p[0], p[1], 90), elbow);
// The mesh-arm rig has a denser elbow, so a stroke that smooths a vertex can widen the gap to a neighbour just outside its radius: the rms must fall clearly and the worst jump may not grow by more than 10% (it was an exact <= on the old sparse mesh).
check("smoothing lowers the weight jumps around the elbow (rms clearly, max within 10%)", rough1.rms < rough0.rms * 0.95 && rough1.max <= rough0.max * 1.1, { before: rough0, after: rough1 });
const undoAfter = await E(() => window.atlasEditor.setupState());
console.log("setupState before/after:", JSON.stringify(undoBefore), JSON.stringify(undoAfter));
await shot("2-after-smooth-bend90");
await shot("2b-after-smooth-bend90-closeup", clip);

// Heat map "all bones" view.
await E(() => window.atlasWeights.setHeat("all"));
await shot("3-all-bones-blend");
await E(() => window.atlasWeights.setHeat("active"));

// Radius hotkeys.
const r0 = await E(() => Number(document.getElementById("wt-radius").value));
await page.keyboard.press("]");
const r1 = await E(() => Number(document.getElementById("wt-radius").value));
await page.keyboard.press("[");
check("] grows and [ shrinks the brush", r1 > r0, { r0, r1 });

// Selection table: select all, check the virtual list renders few rows.
await E(() => window.atlasWeights.selectAll());
await page.waitForTimeout(400);
const rows = await page.locator("#wt-tbody .wt-trow").count();
check("the table is virtualised (339 selected, few DOM rows)", rows > 3 && rows < 40, rows);
await shot("4-table");

// Bench: the brush at 60 fps on the largest editor mesh (339 vertices here).
const bench = await E(() => window.atlasWeights.bench(300, false));
const benchRender = await E(() => window.atlasWeights.bench(60, true));
console.log("BENCH compute", JSON.stringify(bench));
console.log("BENCH with redraw", JSON.stringify(benchRender));
check("brush compute + re-skin + heat upload under 16.7 ms per dab (p95)", bench.p95Ms < 16.7, bench);

// --- W3: restore pipeline weights, then mirror near -> far (sandboxed rig copy; the pro turned rig keeps its build-*.jsonl).
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const rigDir = resolve(here, "../../animator/rigs/kit-body-cutout");
  const expected = (slot, name) => {
    const rows = [];
    for (const f of readdirSync(rigDir).filter((n) => /^build-.*\.jsonl$/.test(n)).sort())
      for (const line of readFileSync(resolve(rigDir, f), "utf8").split("\n")) {
        if (!line.includes('"weights.set"')) continue;
        const c = JSON.parse(line);
        if (c.skin !== "body" || c.slot !== slot || c.name !== name) continue;
        const sum = c.influences.reduce((s, i) => s + i.weight, 0);
        for (const v of c.vertices) rows[v] = Object.fromEntries(c.influences.map((i) => [i.bone, i.weight / sum]));
      }
    return rows;
  };
  const worst = (got, want) => {
    let w = 0;
    for (let v = 0; v < want.length; v++) for (const b of new Set([...Object.keys(want[v] ?? {}), ...Object.keys(got[v] ?? {})])) w = Math.max(w, Math.abs((want[v]?.[b] ?? 0) - (got[v]?.[b] ?? 0)));
    return w;
  };
  const all = async () => E(() => Array.from({ length: window.atlasWeights.state().vertices }, (_, v) => window.atlasWeights.weights(v)));

  await page.click("#tp-select");
  await page.waitForTimeout(500);
  await E(() => window.atlasEditor.mountOutfit("pro-turned"));
  await page.waitForTimeout(2500);
  await page.click("#tp-weights");
  await page.waitForTimeout(500);
  const pickMesh = async (slot, name) => {
    await page.selectOption("#wt-mesh", `body|${slot}|${name}`);
    await page.waitForTimeout(700);
  };
  await pickMesh("shirt_torso", "torso");
  const want = expected("shirt_torso", "torso");
  await E(() => window.atlasEditor.select("chest"));
  await page.waitForTimeout(300);
  await E(() => document.querySelectorAll("details.wt-fold").forEach((d) => (d.open = true)));
  await page.click("#wt-apply"); // scrambles the weights (heat over the chain)
  await page.waitForTimeout(1200);
  const scrambled = worst(await all(), want);
  check("auto-weights moved the torso away from the build weights", scrambled > 0.05, scrambled);
  await page.click("#wt-restore");
  await page.waitForTimeout(1500);
  const restored = worst(await all(), want);
  console.log("report:", await page.locator("#wt-import-report").innerText());
  check("Restore pipeline weights reproduces the build weights", restored < 2e-4, restored);
  await shot("5-restored");
  const undoable = await E(() => window.atlasEditor.setupState().undoable);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(800);
  check("the restore is one undo step", (await E(() => window.atlasEditor.setupState().undoable)) === undoable - 1 && worst(await all(), want) > 0.05, { undoable });

  // Mirror: shirt_tip_near/tip -> shirt_tip_far/tip.
  await pickMesh("shirt_tip_near", "tip");
  await page.click("#wt-restore");
  await page.waitForTimeout(1200);
  check("the near tip restored", worst(await all(), expected("shirt_tip_near", "tip")) < 2e-4);
  check("Mirror near to far is enabled on a near slot", (await page.locator("#wt-mirror-far").isEnabled()) && (await page.locator("#wt-mirror-near").isDisabled()));
  const beforeMirror = await E(() => window.atlasEditor.setupState().undoable);
  await page.click("#wt-mirror-far");
  await page.waitForTimeout(1500);
  console.log("report:", await page.locator("#wt-import-report").innerText());
  check("the mirror is one undo step", (await E(() => window.atlasEditor.setupState().undoable)) === beforeMirror + 1, beforeMirror);
  await pickMesh("shirt_tip_far", "tip");
  const farRows = await all();
  const bonesFar = new Set(farRows.flatMap((r) => Object.keys(r)));
  check("the far tip now weights the far-side bones", [...bonesFar].some((b) => b.endsWith("_far")) && ![...bonesFar].some((b) => b.endsWith("_near")), [...bonesFar]);
  const vs = worst(farRows, expected("shirt_tip_far", "tip"));
  console.log("mirror vs the far tip's own build weights, worst per-weight difference:", vs);
  await shot("6-mirrored-far");
}

check("no page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
process.exit(failures ? 1 : 0);
