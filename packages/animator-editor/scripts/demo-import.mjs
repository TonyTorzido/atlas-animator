// Demo of Import from Spine / Export Spine (Export tab; src/spineApi.ts) in a sandbox (scripts/demo-server.mjs; never port 5211):
//   export the Turned L rig to Spine through the button (temp folder under the sandbox data dir), damage the rig file's torso skin
//   mesh on disk, reload, import the exported .json back through the button, check the summary and that the mesh is restored,
//   then Revert import and check the damage is back.
//   node packages/animator-editor/scripts/demo-import.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = createRequire(resolve(here, "../../animator/package.json"))("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/import"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const rigPath = resolve(dataDir, "rigs/player/front-turn15-faceA.anim.json");
const meshOf = (doc) => doc.skins.body.attachments.torso.skin;
/** Per vertex, the influences as sorted "bone x y weight" strings: independent of the mesh's bone table order. */
function decode(m) {
  const out = [];
  let c = 0;
  for (let v = 0; v < m.uvs.length / 2; v++) {
    const n = m.vertices[c++];
    const list = [];
    for (let k = 0; k < n; k++, c += 4) list.push(`${m.bones[m.vertices[c]]} ${m.vertices[c + 1].toFixed(2)} ${m.vertices[c + 2].toFixed(2)} ${m.vertices[c + 3].toFixed(3)}`);
    out.push(list.sort().join("|"));
  }
  return out;
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1800, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = async (name) => {
  await page.waitForTimeout(400);
  const file = resolve(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
};
const open = async () => {
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.atlasEditor.mountOutfit("turned-l"));
  await page.waitForTimeout(1500);
};
const resultText = () => page.locator("#spine-result").innerText();

await open();
const original = JSON.parse(readFileSync(rigPath, "utf8"));
const wasVertices = meshOf(original).vertices.slice();
const wasDecoded = decode(meshOf(original));

// 1. Export through the button.
await page.click("#spine-export");
await page.waitForFunction(() => /Wrote /.test(document.getElementById("spine-result")?.textContent ?? ""), null, { timeout: 120_000 });
const exported = await resultText();
await shot("0-exported");
const spinePath = exported.split("\n")[0].replace(/^Wrote /, "").trim();
const spine = JSON.parse(readFileSync(spinePath, "utf8"));
check("export wrote a Spine 4.x skeleton with the torso mesh", /^4\./.test(spine.skeleton.spine) && JSON.stringify(spine.skins).includes('"torso"'), spine.skeleton.spine);
check("export summary reports deform and linked mesh counts", /deform timelines?, \d+ linked mesh/.test(exported), exported.split("\n")[1]);

// 2. Damage the saved rig's torso mesh.
const damaged = structuredClone(original);
meshOf(damaged).vertices[2] += 7;
meshOf(damaged).vertices[3] -= 7;
writeFileSync(rigPath, JSON.stringify(damaged));
await open();
const before = await page.evaluate(() => window.atlasEditor.setupRaw());
check("the editor shows the damaged mesh", decode(meshOf(before)).join() !== wasDecoded.join());

// 3. Import it back.
await page.setInputFiles("#spine-file", spinePath);
await page.waitForFunction(() => /Imported |nothing in it matched|Import failed/.test(document.getElementById("spine-result")?.textContent ?? ""), null, { timeout: 120_000 });
await page.waitForTimeout(1200);
const summary = await resultText();
await shot("1-imported");
console.log(summary);
check("summary says what was imported", /Imported .*: \d+ mesh\(es\) with weights, \d+ linked mesh\(es\), \d+ deform timeline\(s\), \d+ clip\(s\)/.test(summary));
check("summary lists the torso skin mesh", /torso\/skin|skin/.test(summary), summary.split("\n").find((l) => l.includes("meshes:")));
const after = await page.evaluate(() => window.atlasEditor.setupRaw());
const nowDecoded = decode(meshOf(after));
const wrong = nowDecoded.filter((d, i) => d !== wasDecoded[i]).length;
check("the torso mesh weights and bind positions are restored (per vertex, 0.01 px / 0.001 weight)", nowDecoded.length === wasDecoded.length && wrong === 0, { vertices: nowDecoded.length, wrong });
check("Revert import is enabled", !(await page.locator("#spine-revert").isDisabled()));

// 4. Revert.
await page.click("#spine-revert");
await page.waitForFunction(() => /Reverted/.test(document.getElementById("spine-result")?.textContent ?? ""), null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const reverted = await page.evaluate(() => window.atlasEditor.setupRaw());
check("revert puts the damaged mesh back", decode(meshOf(reverted)).join() === decode(meshOf(before)).join());
await shot("2-reverted");

check("no page errors", errors.length === 0, errors);
await browser.close();
process.exit(failures ? 1 : 0);
