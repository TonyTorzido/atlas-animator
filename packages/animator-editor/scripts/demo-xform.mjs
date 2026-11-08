// Demo of the transform strip (transformStrip.ts), the axis spaces, Compensate Bones / Images, the Bones / Images / Others grid and the
// canvas edge controls (canvasTools.ts) with screenshots. Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is
// ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-xform.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/xform"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

// Very wide window: the whole strip (all four channels, Compensate and Layers) needs about 2000 px; narrower, parts of it give way into its "..." popover, which these steps would have to open first.
const page = revealTabs(await browser.newPage({ viewport: { width: 3000, height: 1300 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  console.log(resolve(out, `${name}.png`));
};
const field = (ch, axis = "x") => page.locator(`#xstrip .xf-in[data-ch="${ch}"][data-axis="${axis}"]`);
const keyBtn = (ch) => page.locator(`#xstrip .xf-key[data-ch="${ch}"]`);
const val = async (ch, axis = "x") => Number(await field(ch, axis).inputValue());
const keysOf = async (bone) => E((b) => Object.keys(window.atlasEditor.state().clip.bones?.[b] ?? {}), bone);
const BONE = "forearm_near";

// A clip to key into; Auto key off so every key below is an explicit click.
await page.click("#newclip-open");
await page.fill("#newclip-name", "xform_demo");
await page.click("#newclip-make");
await page.waitForTimeout(300);
if (await E(() => document.querySelector("#autokey")?.classList.contains("on"))) await page.click("#autokey");
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(400);

// 1. The strip shows in Pro, with all four rows.
check("strip is visible in Pro", await page.locator("#xstrip").isVisible());
check("a row per channel", (await page.locator("#xstrip .xf-key").count()) === 4);
check("keys start grey", (await keyBtn("rotate").getAttribute("data-state")) === "none");
await shot("01-pro-strip");

// 1b. The Tool group is Pose / Mesh / Weights / Create; Mesh and Weights switch into Setup and show the "coming" panel (Mesh) or the real Weights panel.
check("tool group has 4 buttons", (await page.locator("#xstrip .xs-tools button").allInnerTexts()).join("|") === "Pose|Mesh|Weights|Create", await page.locator("#xstrip .xs-tools button").allInnerTexts());
await shot("01b-tool-group");
await page.click("#tp-mesh");
await page.waitForTimeout(500);
check("Mesh in Animate opens Shape keys and stays in Animate", (await E(() => window.atlasEditor.mode())) === "animate");
check("no coming-soon Mesh panel is left", (await page.locator("#setup-coming-mesh").count()) === 0);
await page.click("#tp-mesh"); // toggles Shape keys off again
await shot("01c-mesh-shapekeys");
await page.click("#tp-weights");
await page.waitForTimeout(500);
check("Weights switches to the weights tool", (await E(() => window.atlasEditor.setupState().tool)) === "weights");
check("Weights shows the real Weights panel", (await page.locator("#setup-coming-weights").count()) === 0 && (await page.locator("#wt-root").count()) === 1);
await page.keyboard.press("m");
check("M in Setup is the mesh tool", (await E(() => window.atlasEditor.setupState().tool)) === "mesh");
await page.keyboard.press("w");
check("W in Setup is the weights tool", (await E(() => window.atlasEditor.setupState().tool)) === "weights");
await page.click("#tp-select");
await page.waitForTimeout(400);
check("Pose returns to Animate", (await E(() => window.atlasEditor.mode())) === "animate");
await page.keyboard.press("w");
await page.waitForTimeout(500);
check("W in Animate opens Setup weights", (await E(() => window.atlasEditor.mode() + "/" + window.atlasEditor.setupState().tool)) === "setup/weights");
await page.click("#tp-select");
await page.waitForTimeout(400);
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(300);

// 2. Editing a field turns its key orange; clicking it keys only that channel.
await field("rotate").fill("25");
await field("rotate").dispatchEvent("change");
await field("translate", "x").fill("6");
await field("translate", "x").dispatchEvent("change");
await page.waitForTimeout(200);
check("changed channels are orange", (await keyBtn("rotate").getAttribute("data-state")) === "changed" && (await keyBtn("translate").getAttribute("data-state")) === "changed");
check("scale was not touched", (await keyBtn("scale").getAttribute("data-state")) === "none");
await shot("02-changed");
await keyBtn("rotate").click();
await page.waitForTimeout(200);
check("keying rotate keys only rotate", JSON.stringify(await keysOf(BONE)) === JSON.stringify(["rotate"]), await keysOf(BONE));
check("rotate is red, translate stays orange", (await keyBtn("rotate").getAttribute("data-state")) === "keyed" && (await keyBtn("translate").getAttribute("data-state")) === "changed");
await keyBtn("scale").click({ modifiers: ["Shift"] });
await page.waitForTimeout(200);
const all = (await keysOf(BONE)).sort();
check("Shift-click keys every channel", all.join() === "rotate,scale,shear,translate", all);
check("every key is red now", (await Promise.all(["rotate", "translate", "scale", "shear"].map((c) => keyBtn(c).getAttribute("data-state")))).every((s) => s === "keyed"));
await shot("03-keyed");

// 3. Wheel and drag-scrub.
await field("shear", "x").hover();
const s0 = await val("shear", "x");
await page.mouse.wheel(0, -100);
await page.waitForTimeout(300);
check("wheel up raises the field", (await val("shear", "x")) > s0, { s0, now: await val("shear", "x") });
const g = await page.locator('#xstrip .xf-grip[data-ch="scale"]').first().boundingBox();
const sc0 = await val("scale", "x");
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
await page.mouse.down();
await page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
check("dragging the label scrubs the value", Math.abs((await val("scale", "x")) - sc0 - 0.4) < 0.05, { sc0, now: await val("scale", "x") });

// 4. Pose panel uses the same controls.
check("the strip is the only copy of the transform rows (the Pose panel drops its duplicate)", (await page.locator("#detail .xf-in").count()) === 0 && (await page.locator("#detail .xf-key").count()) === 0 && (await page.locator("#xstrip .xf-in").count()) === 7);
check("the Pose panel keeps the bone info", (await page.locator("#detail").innerText()).includes("PARENT") || (await page.locator("#detail").innerText()).toLowerCase().includes("parent"));

// 5. Axis spaces: typing in World and reading it back in Parent differs under a rotated parent, and World round-trips.
await E(() => window.atlasEditor.select("upper_arm_near"));
await E(() => window.atlasEditor.rotate("upper_arm_near", 40));
await E((b) => window.atlasEditor.select(b), BONE);
await page.waitForTimeout(300);
const parentTranslate = [await val("translate", "x"), await val("translate", "y")];
await page.click("#xs-space-world");
const worldTranslate = [await val("translate", "x"), await val("translate", "y")];
check("world translate differs from the stored (parent) offset under a rotated parent", Math.hypot(worldTranslate[0] - parentTranslate[0], worldTranslate[1] - parentTranslate[1]) > 0.5, { parentTranslate, worldTranslate });
await field("translate", "x").fill("10");
await field("translate", "y").fill("0");
await field("translate", "y").dispatchEvent("change");
await page.waitForTimeout(250);
check("typed world values read back unchanged", Math.abs((await val("translate", "x")) - 10) < 0.06 && Math.abs(await val("translate", "y")) < 0.06, [await val("translate", "x"), await val("translate", "y")]);
await page.click("#xs-space-local");
check("local space shows another frame", (await val("translate", "x")) !== 10);
await page.click("#xs-space-world");
await page.click('#gizmo [data-mode="move"]');
await shot("04-world-move-gizmo");
await page.click("#xs-space-local");
await shot("05-local-move-gizmo");
await page.click("#xs-space-parent");
await page.click('#gizmo [data-mode="rotate"]');

// 6. Compensate: Bones works in Animate; Images is disabled there and enabled in Setup.
const imagesDisabled = await page.locator("#xs-comp-images").isDisabled();
check("Images stay put is disabled in Animate, with a tooltip saying so", imagesDisabled && /Setup mode only/i.test((await page.locator("#xs-comp-images").getAttribute("title")) ?? ""));
await page.click("#xs-comp-bones");
check("Bones toggle drives the existing Compensate", (await E(() => window.atlasEditor.state().compensate)) === true && (await page.locator("#xs-comp-bones.on").count()) === 1);
check("the top-bar Compensate button follows", await E(() => document.querySelector("#compensate").classList.contains("on")));
await page.click("#xs-comp-bones");
await page.click('#modeseg [data-mode="setup"]');
await page.waitForTimeout(900);
check("Images is enabled in Setup", !(await page.locator("#xs-comp-images").isDisabled()));
await page.click("#xs-comp-images");
await page.click("#xs-comp-bones");
const st = await E(() => window.atlasEditor.setupState?.() ?? null);
check("Setup keeps follow the toggles", (await page.locator("#xs-comp-images.on").count()) === 1 && (await page.locator("#xs-comp-bones.on").count()) === 1, st && { keepBones: st.keepBones, keepImages: st.keepImages });
check("the transform rows are dimmed in Setup (the Rig panel edits the setup pose)", await E(() => document.querySelector("#xstrip").classList.contains("setup")));
await shot("06-setup-compensate");
await page.click('#modeseg [data-mode="animate"]');
await page.waitForTimeout(500);

// 7. Bones / Images / Others grid (editor only).
await page.click("#xs-grid-bones-visible");
check("bones visible off hides the overlay", (await E(() => window.atlasEditor.overlayState().showBones)) === false);
await page.click("#xs-grid-bones-visible");
await page.click("#xs-grid-images-visible");
await shot("07-images-hidden");
await page.click("#xs-grid-images-visible");
await page.click("#xs-grid-others-visible");
check("others visible shows helper bones", (await E(() => window.atlasEditor.overlayState().showHelpers)) === true);
await page.click("#xs-grid-others-visible");
await page.click("#xs-grid-bones-selectable");
check("selectable toggles are editor state", (await page.locator("#xs-grid-bones-selectable.on").count()) === 0);
await page.click("#xs-grid-bones-selectable");
check("nothing in the clip changed from the grid", JSON.stringify((await keysOf(BONE)).sort()) === JSON.stringify(["rotate", "scale", "shear", "translate"]));

// 8. Canvas edge controls.
const zoomText = () => E(() => document.querySelector("#zoom").textContent);
const z0 = await zoomText();
await page.click("#xs-zin");
await page.waitForTimeout(500);
const z1 = await zoomText();
check("+ zooms in", parseInt(z1) > parseInt(z0), { z0, z1 });
await page.click("#xs-zout");
await page.click("#xs-zout");
await page.waitForTimeout(500);
check("- zooms out", parseInt(await zoomText()) < parseInt(z1), await zoomText());
await page.click("#xs-mag");
await page.waitForTimeout(500);
check("magnifier goes to 100%", (await zoomText()) === "100%", await zoomText());
await page.locator("#xs-zoom").fill("700");
await page.waitForTimeout(600);
check("the slider zooms", parseInt(await zoomText()) > 100, await zoomText());
await page.click("#xs-fit");
await page.waitForTimeout(700);
check("fit comes back to the whole character", parseInt(await zoomText()) < 400, await zoomText());
await page.click("#xs-ruler");
await page.waitForTimeout(500);
check("rulers show", await page.locator("#xs-rulers").isVisible());
await shot("08-rulers");

// 9. The Animate workspace shows it too; other workspaces do not.
await page.click('#wsbar [data-go="animate"]');
await page.waitForTimeout(900);
check("strip shows in the Animate workspace", await page.locator("#xstrip").isVisible());
const clipBtn = await E(() => !!document.querySelector("#tp-bone"));
check("Create is disabled in Animate (it never edits the rig)", clipBtn && (await page.locator("#tp-bone").isDisabled()));
await shot("09-animate");
await page.click('#wsbar [data-go="ship"]');
await page.waitForTimeout(500);
check("strip is hidden in Ship", !(await page.locator("#xstrip").isVisible()));

// 10. Nothing overlaps at the canvas bottom or edges: every workspace, two window sizes, phone dock open / collapsed, Game view open.
const SELS = ["#xstrip", "#vtip", "#pathstack > *", "#xs-edge", "#view .hud.tl", "#view .hud.tr", "#rulerow > *", "#setuphud"];
const overlaps = () =>
  E((sels) => {
    const rects = sels.flatMap((s) => [...document.querySelectorAll(s)].map((e) => ({ s, e, r: e.getBoundingClientRect(), cs: getComputedStyle(e) }))).filter((x) => x.r.width > 0 && x.r.height > 0 && x.cs.display !== "none" && x.cs.visibility !== "hidden");
    const bad = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r, b = rects[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(rects[i].s + " x " + rects[j].s);
      }
    const strip = rects.find((x) => x.s === "#xstrip");
    const opaque = strip ? getComputedStyle(strip.e).backgroundColor : null;
    return { bad, opaque, seen: rects.map((x) => x.s) };
  }, SELS);
await E(() => window.atlasEditor.select("upper_arm_near"));
for (const [w, h] of [[1600, 900], [1920, 1080]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const ws of ["animate", "pro", "rig", "swag"]) {
    await E((x) => window.atlasEditor.workspace(x), ws);
    await page.waitForTimeout(700);
    for (const state of ["default", "dock toggled", "game view"]) {
      if (state === "dock toggled") {
        const open = await page.locator("#dock-open:visible").count();
        await E((o) => document.querySelector(o ? "#dock-open" : "#dock-collapse")?.click(), open > 0);
      } else if (state === "game view") {
        if (!(await page.locator("#gameviewbtn").count())) continue;
        await E(() => document.querySelector("#gameviewbtn")?.click());
      }
      await page.waitForTimeout(600);
      if (state === "default") {
        // Fit frames the character in the free canvas: nothing in the toolbar row, the edge column, the tip line or the strip covers it.
        await E(() => window.atlasEditor.fit());
        await page.waitForTimeout(300);
        const hit = await E((sels) => {
          const a = window.atlasEditor.artBox();
          return sels.flatMap((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed").map((e) => ({ s, r: e.getBoundingClientRect() }))).filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.left < a.x1 && a.x0 < x.r.right && x.r.top < a.y1 && a.y0 < x.r.bottom).map((x) => x.s);
        }, SELS);
        check("the fitted character is clear of every overlay: " + ws + " " + w + "x" + h, hit.length === 0, hit);
      }
      const o = await overlaps();
      check("no overlaps: " + ws + " " + w + "x" + h + " " + state, o.bad.length === 0 && (!o.seen.includes("#xstrip") || o.opaque.startsWith("rgb(")), o);
      if (state === "default" || o.bad.length) await shot("10-" + ws + "-" + w + "x" + h + "-" + state.replace(" ", "-"));
      if (state === "game view") await E(() => document.querySelector("#gameviewbtn")?.click());
    }
  }
}

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
