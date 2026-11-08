// Demo of the Clip board with screenshots at 1600x900 and 1920x1080: open the board from Home, create atk_axe_warrior_1 from its
// template (events and length checked), mark it done, reload and confirm the status persists.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-clipboard.mjs [outDir] [url]
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/clipboard"));
const { url, dataDir } = await demoServer(process.argv[3]);
const CLIP = "atk_axe_warrior_1";
const clipsDir = dataDir ? resolve(dataDir, "clips") : resolve(here, "../clips");
const cleanup = () => {
  for (const f of ["board.json", `${CLIP}.clip.json`]) if (existsSync(resolve(clipsDir, f))) rmSync(resolve(clipsDir, f));
};
mkdirSync(out, { recursive: true });
cleanup();

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

for (const [w, h] of [
  [1600, 900],
  [1920, 1080]
]) {
  cleanup();
  const page = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }), { workspace: null });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const boot = async () => {
    await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
    await page.waitForTimeout(1200);
  };
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    await page.waitForTimeout(500);
    const file = resolve(out, `${name}-${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };
  const status = (id) => E((c) => document.querySelector(`#clipboard .cb-dot[data-clip="${c}"]`)?.dataset.status, id);
  const noBars = () =>
    E(() => {
      const b = document.getElementById("clipboard");
      return b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1 && document.documentElement.scrollWidth <= innerWidth;
    });

  await page.goto(url);
  await boot();

  // The Animate card opens the board.
  await page.click('#home .home-card[data-go="animate"]');
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot");
  await page.waitForTimeout(600);
  check(`${w}: board opens from Home`, (await E(() => window.atlasEditor.workspace())) === "animate");
  check(`${w}: 12 attack cells x 3 dots`, (await E(() => document.querySelectorAll("#clipboard .cb-dot").length)) === 36, await E(() => document.querySelectorAll("#clipboard .cb-dot").length));
  check(`${w}: board fits without scrollbars`, await noBars());
  check(`${w}: ${CLIP} starts missing`, (await status(CLIP)) === "missing");
  await shot("board");

  // Filters and tooltips.
  await page.click('#clipboard [data-filter="missing"]');
  check(`${w}: Missing filter dims nothing missing`, (await E(() => document.querySelectorAll("#clipboard .cb-dot.dim").length)) === 0);
  await page.click('#clipboard [data-filter="problems"]');
  check(`${w}: Problems filter dims all dots`, (await E(() => document.querySelectorAll("#clipboard .cb-dot:not(.dim)").length)) === 0);
  await page.click('#clipboard [data-filter="all"]');
  check(`${w}: dots carry a tooltip`, /Warrior double axe attack 1: Missing/.test((await E((c) => document.querySelector(`#clipboard [data-clip="${c}"]`).title, CLIP)) ?? ""));
  await page.hover(`#clipboard .cb-dot[data-clip="${CLIP}"]`);

  // One click: rig, facing, clip from the template, Animate workspace.
  await page.click(`#clipboard .cb-dot[data-clip="${CLIP}"]`);
  await page.waitForFunction((c) => window.atlasEditor.state().clipName === c, CLIP, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const st = await E(() => window.atlasEditor.state());
  check(`${w}: board closes into Animate`, (await E(() => window.atlasEditor.workspace())) === "animate" && (await E(() => document.getElementById("clipboard").hidden)));
  check(`${w}: pro-turned rig mounted`, st.outfit === "pro-turned", st.outfit);
  check(`${w}: facing left`, !(await E(() => document.getElementById("facingbtn").classList.contains("on"))));
  const names = (st.clip.events ?? []).map((e) => e.name);
  console.log("clip", JSON.stringify({ length: st.clip.duration, fps: st.clip.fps, loop: st.clip.loop, events: st.clip.events }));
  for (const n of ["windup", "hit", "trailOn", "trailOff", "ready"]) check(`${w}: template event ${n}`, names.includes(n));
  check(`${w}: template length is positive and not looping`, st.clip.duration > 0.3 && !st.clip.loop, st.clip.duration);
  check(`${w}: axe needs no stand-in chip`, await E(() => document.getElementById("cb-standin").hidden));
  await shot("animate-after-click");

  // Mark done (right click, confirm).
  await page.click("#clips-open");
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot");
  await page.waitForTimeout(500);
  check(`${w}: clip is a draft now`, (await status(CLIP)) === "draft");
  await page.click(`#clipboard .cb-dot[data-clip="${CLIP}"]`, { button: "right" });
  await shot("menu");
  await page.click('#clipboard .cb-menu-item[data-act="done"]');
  await shot("confirm");
  await page.click("#clipboard .cb-go");
  await page.waitForFunction(() => /marked done/.test(document.getElementById("cb-notice")?.textContent ?? ""), null, { timeout: 30_000 });
  check(`${w}: marked done`, (await status(CLIP)) === "done", await status(CLIP));
  await shot("done");

  // A second clip as a draft with a stand-in weapon, for the picture.
  await page.click(`#clipboard .cb-dot[data-clip="atk_bow_ranger_2"]`);
  await page.waitForFunction(() => window.atlasEditor.state().clipName === "atk_bow_ranger_2", null, { timeout: 30_000 });
  await page.waitForTimeout(600);
  check(`${w}: bow shows the stand-in chip`, !(await E(() => document.getElementById("cb-standin").hidden)), await E(() => document.getElementById("cb-standin").textContent));
  await shot("animate-standin");

  // Reload: the status must persist.
  await page.reload();
  await boot();
  await page.click('#home .home-card[data-go="animate"]');
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot");
  await page.waitForTimeout(900);
  check(`${w}: status persists after reload`, (await status(CLIP)) === "done", await status(CLIP));
  check(`${w}: the other clip is a draft... or missing (never saved)`, ["missing", "draft"].includes(await status("atk_bow_ranger_2")));
  const boardFile = await E(() => fetch("/api/board").then((r) => r.json()));
  check(`${w}: board.json has the rig hash`, !!boardFile[CLIP]?.done && boardFile[CLIP].rigHash.length > 8, boardFile[CLIP]);
  await shot("board-after-reload");
  check(`${w}: no console errors`, errors.length === 0, errors.slice(0, 3));
  await page.close();
}

cleanup();
await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
