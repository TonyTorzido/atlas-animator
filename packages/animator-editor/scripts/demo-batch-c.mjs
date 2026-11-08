// UX2 Batch C check: Swag judge bar (Phone size, Facing right, pose steps, gate chips), the contact sheet grid, the sheet PNG.
// Real clicks and keys, leather and jacket_b worn, in a sandbox server.   node packages/animator-editor/scripts/demo-batch-c.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("pro"));
for (const name of ["idle", "walk_down", "walk_side", "run", "dash"]) {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(300);
  await E(() => {
    const a = window.atlasEditor;
    a.select("upper_arm_near");
    a.setTime(0.3, true);
    a.rotate("upper_arm_near", 25);
    a.key();
    a.setTime(0.8, true);
    a.rotate("upper_arm_near", -35);
    a.key();
  });
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
}
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(2500);

const shot = (n) => page.screenshot({ path: resolve(out, n) });
const zoom = () => E(() => window.atlasEditor.view().zoom);
const chipStates = () => E(() => Object.fromEntries([...document.querySelectorAll(".swgate")].map((b) => [b.dataset.gate, { state: b.dataset.state, text: b.textContent }])));

for (const item of ["chest.leather", "chest.jacket_b"]) {
  const tag = item.split(".")[1];
  await page.click(`.swrow[data-item="${item}"]`);
  await page.waitForFunction((n) => window.atlasSwag.worn().includes(n), item);
  check(`one click wears ${item}`, true);
  await page.waitForTimeout(600);

  await page.click("#sw-phone");
  await page.waitForTimeout(900);
  const z1 = await zoom();
  check(`${tag}: Phone size button -> zoom 0.42`, Math.abs(z1 - 0.42) < 0.02, z1);
  check(`${tag}: toggle shows on`, await E(() => document.getElementById("sw-phone").classList.contains("on")));
  await page.keyboard.press("p");
  await page.waitForTimeout(900);
  const z2 = await zoom();
  check(`${tag}: P key turns Phone size off`, Math.abs(z2 - 0.42) > 0.05, z2);
  await page.keyboard.press("p");
  await page.waitForTimeout(900);

  await page.click("#sw-facing");
  await page.waitForTimeout(300);
  check(`${tag}: Facing right button`, (await E(() => window.atlasEditor.facing().facing)) === "right" && (await E(() => document.getElementById("sw-facing").classList.contains("on"))));
  await shot(`${tag}-1600-phone-facing-right.png`);
  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  check(`${tag}: X key flips back`, (await E(() => window.atlasEditor.facing().facing)) === "left");

  await E(() => window.atlasEditor.setTime(0, true));
  await page.waitForTimeout(300);
  const f0 = await E(() => document.getElementById("sw-pose").textContent);
  await page.click("#sw-nextpose");
  await page.waitForTimeout(300);
  const f1 = await E(() => document.getElementById("sw-pose").textContent);
  check(`${tag}: next pose steps the frame`, f0 !== f1, [f0, f1]);
  await page.keyboard.press("]");
  await page.waitForTimeout(300);
  const f2 = await E(() => document.getElementById("sw-pose").textContent);
  check(`${tag}: ] key steps again`, f2 !== f1, [f1, f2]);
  await page.keyboard.press("[");
  await page.waitForTimeout(300);

  let st = await chipStates();
  console.log("chips", JSON.stringify(st));
  check(`${tag}: three gate chips`, Object.keys(st).length === 3);
  await page.click("#sw-gate-outline");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => window.atlasGate && !window.atlasGate.summary().checking, null, { timeout: 180_000 });
  await page.waitForTimeout(1200);
  st = await chipStates();
  console.log("chips after check", JSON.stringify(st));
  check(`${tag}: outline chip has a verdict`, st.outline.state === "pass" || st.outline.state === "fail", st.outline);
  if (st.outline.state === "fail") {
    const t0 = await E(() => window.atlasEditor.state().time);
    await page.click("#sw-gate-outline");
    await page.waitForTimeout(400);
    const t1 = await E(() => window.atlasEditor.state().time);
    check(`${tag}: clicking the failing chip jumps to the pose`, t0 !== t1, [t0, t1]);
  }
  await shot(`${tag}-1600-gates.png`);
  if (await E(() => window.atlasPhone.on())) await page.keyboard.press("p");
  await page.waitForTimeout(500);
}

const geometry = () =>
  E(() => {
    const body = document.querySelector(".swsbody").getBoundingClientRect();
    const labels = [...document.querySelectorAll(".swrl")].map((e) => e.getBoundingClientRect());
    const cellEls = [...document.querySelectorAll(".swc")];
    const cells = cellEls.map((c) => c.getBoundingClientRect());
    const rows = labels.map((l) => cells.filter((c) => Math.abs((c.top + c.bottom) / 2 - (l.top + l.bottom) / 2) < l.height / 2 + 4));
    return {
      rows: labels.length,
      perRow: rows.map((r) => r.length),
      labelsLeftOfCells: labels.every((l, i) => rows[i].every((c) => l.right <= c.left + 1)),
      inside: cells.every((c) => c.top >= body.top - 1 && c.bottom <= body.bottom + 1 && c.left >= body.left - 1 && c.right <= body.right + 1),
      sizes: [...new Set(cells.map((c) => `${Math.round(c.width)}x${Math.round(c.height)}`))],
      page: document.getElementById("swspage")?.textContent,
      count: document.getElementById("swscount")?.textContent
    };
  });
for (const [w, h, tag] of [[1600, 1000, "1600"], [1366, 768, "1366"]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(600);
  await page.click('[data-act="sheet"]');
  await page.waitForFunction(() => window.atlasSwag.sheetState()?.open, null, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll(".swc").length > 0 && document.querySelectorAll(".swc.wait").length === 0, null, { timeout: 180_000 });
  const g = await geometry();
  console.log("geometry", tag, JSON.stringify(g));
  check(`sheet ${tag}: 4 cells per row, label first`, g.rows > 0 && g.perRow.every((n) => n === 4) && g.labelsLeftOfCells, g.perRow);
  check(`sheet ${tag}: whole page visible`, g.inside);
  check(`sheet ${tag}: one cell size`, g.sizes.length === 1, g.sizes);
  await shot(`sheet-${tag}-clips.png`);
  await page.click('[data-mode="sweep"]');
  await page.waitForFunction(() => document.querySelectorAll(".swc").length > 0 && document.querySelectorAll(".swc.wait").length === 0, null, { timeout: 180_000 });
  const g2 = await geometry();
  console.log("geometry sweep", tag, JSON.stringify(g2));
  check(`sheet ${tag}: sweep 4 per row, visible`, g2.perRow.every((n) => n === 4) && g2.inside && g2.sizes.length === 1, g2.perRow);
  await shot(`sheet-${tag}-sweep.png`);
  if (tag === "1600") {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.click('[data-act="download"]')]);
    await dl.saveAs(resolve(out, "export-sweep.png"));
    check("download made a PNG", true, dl.suggestedFilename());
  }
  const fail = await page.$(".swfchip");
  if (fail) {
    await fail.click();
    await page.waitForTimeout(500);
    check(`sheet ${tag}: failing chip goes to its cell`, !!(await page.$(".swc.flash")));
  } else console.log("note: no failing cell on this sweep");
  await page.click('[data-act="close-sheet"]');
  await page.waitForTimeout(300);
}
for (const [w, h, tag] of [[1600, 1000, "1600"], [1366, 768, "1366"]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(800);
  await shot(`swag-${tag}.png`);
}
check("gate card hidden in Swag", await E(() => getComputedStyle(document.getElementById("gate-overlay")).display === "none"));
check("no page errors", errors.length === 0, errors.slice(0, 3));
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);
