// UI sweep for the Atlas Animator editor: every workspace and state at three window sizes, with measurements.
//   node scripts/ui-sweep.mjs <outDir> [sizes]   e.g. node scripts/ui-sweep.mjs ./test-results/ui-sweep 1340x900,1600x900
// Starts its own sandboxed editor server (demo-server.mjs), walks every workspace and state at each window size, writes
// screenshots plus measurements.json, and prints a per-size summary (overlaps, small text, clipped, scroll-fade misses).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(resolve(PKG, "../animator/package.json"));
const { chromium } = require("@playwright/test");
const { demoServer } = await import(pathToFileURL(resolve(PKG, "scripts/demo-server.mjs")).href);
// --quick: only the workspace screens (and the states Batch F cares about), for a fast overlap and page-error pass.
const quick = process.argv.includes("--quick");
const QUICK = new Set(["home", "animate-noclip", "animate-empty", "guide", "clipboard", "open-clip", "animate-gameview-off", "help", "pro", "pro-pose", "pro-graph", "rig", "swag", "swag-item", "swag-wear", "ship"]);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = resolve(args[0]);
const sizes = (args[1] ?? "1340x900,1600x900,1920x1080").split(",").map((s) => s.split("x").map(Number));
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const report = {};
let pageErrors = 0;

// Measurement script run in the page: canvas share, overlapping boxes, small text, low-contrast text, native scrollbars, title check.
const SWEEP = () => {
  const W = innerWidth, H = innerHeight;
  const vis = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    // content of a closed <details> is not rendered (its boxes still report a size)
    for (let n = e.parentElement; n; n = n.parentElement) if (n.tagName === "DETAILS" && !n.open && !(e.tagName === "SUMMARY" && e.parentElement === n) && !e.closest("summary")) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  };
  // clip-aware: content scrolled out of a scroll container (or an <option>) is not drawn, so it cannot overlap anything
  const clipOut = (e) => { const r = e.getBoundingClientRect(); for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflow + getComputedStyle(n).overflowY; if (/auto|scroll|hidden/.test(o)) { const c = n.getBoundingClientRect(); if (r.bottom <= c.top + 0.5 || r.top >= c.bottom - 0.5 || r.right <= c.left + 0.5 || r.left >= c.right - 0.5) return true; } } return false; };
  const all = [...document.querySelectorAll("body *")].filter((e) => !["SCRIPT", "STYLE", "svg", "path", "circle", "rect", "line", "g", "polyline", "ellipse", "OPTION"].includes(e.tagName) && vis(e) && !clipOut(e));
  const path = (e) => {
    const parts = [];
    let n = e;
    while (n && n !== document.body && parts.length < 4) {
      parts.unshift(n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}${n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`);
      n = n.parentElement;
    }
    return parts.join(">");
  };
  const txt = (e) => (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  // leaves: controls, text-bearing elements without element children that also have text, canvases, images
  const hasOwnText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const leaf = all.filter((e) => ["BUTTON", "INPUT", "SELECT", "CANVAS", "IMG", "KBD"].includes(e.tagName) || hasOwnText(e));
  const mainCanvas = document.querySelector("#view > canvas");
  // Occlusion: a leaf whose centre (and a second probe point) is topped by an unrelated element is covered by it.
  const overlaps = [];
  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  for (const e of leaf) {
    if (e === mainCanvas) continue;
    const r = e.getBoundingClientRect();
    const probes = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + Math.min(6, r.width / 3), r.top + r.height / 2], [r.right - Math.min(6, r.width / 3), r.top + r.height / 2]];
    // a probe point scrolled out of a scroll container is not drawn, so it cannot be covered
    const inClip = (x, y) => { for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (/auto|scroll|hidden/.test(cs.overflow + cs.overflowY)) { const c = n.getBoundingClientRect(); if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false; } } return true; };
    const hits = probes.filter(([x, y]) => inClip(x, y)).map(([x, y]) => (x >= 0 && y >= 0 && x < W && y < H ? document.elementFromPoint(x, y) : null)).filter((t) => t && !related(e, t));
    if (hits.length) {
      const t = hits[0];
      // a fixed/absolute overlay layer (Home, Clip board, help, confirm) covering the editor behind it is by design
      if (t.closest("#phonepop, .cb-menu, #newclip, #key-menu, #mirror-menu, #wg-card")) continue; // popovers cover what is behind them by design
      const layer = t.closest("#home, #clipboard, #help, #swagsheet, .cb-confirm-layer, #soon");
      const eLayer = e.closest("#home, #clipboard, #help, #swagsheet, .cb-confirm-layer, #soon");
      if (layer && layer !== eLayer) continue;
      overlaps.push({ covered: `${path(e)} "${txt(e)}"`, by: `${path(t)} "${txt(t)}"`, probes: hits.length, r: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
    }
  }
  // text: font sizes + contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(",").map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (e) => {
    let n = e, acc = null;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (acc.a >= 0.99 || c.a >= 0.99) return acc; }
      n = n.parentElement;
    }
    const base = { r: 20, g: 23, b: 29, a: 1 };
    return acc ? blend(acc, base) : base;
  };
  const texts = all.filter(hasOwnText);
  const fonts = {};
  const small = [], lowContrast = [];
  for (const e of texts) {
    const cs = getComputedStyle(e);
    const fs = parseFloat(cs.fontSize);
    fonts[fs] = (fonts[fs] ?? 0) + 1;
    if (fs < 11) small.push({ el: path(e), text: txt(e), px: fs });
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(e);
    const fgb = fg.a < 1 ? blend(fg, bg) : fg;
    const L1 = lum(fgb), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const op = parseFloat(cs.opacity);
    if (ratio < need || op < 0.6) lowContrast.push({ el: path(e), text: txt(e), px: fs, ratio: +ratio.toFixed(2), opacity: op, color: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` });
  }
  // scroll containers that actually overflow
  const scrollers = all.filter((e) => e.tagName !== "SELECT").filter((e) => { const cs = getComputedStyle(e); return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2); }).map((e) => ({ el: path(e), sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, barW: e.offsetWidth - e.clientWidth, fade: e.classList.contains("scroll-fade") || /gradient/.test(getComputedStyle(e).maskImage + getComputedStyle(e).webkitMaskImage) }));
  // clipped text (ellipsis or overflow hidden with scrollWidth > clientWidth)
  const clipped = texts.filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => ({ el: path(e), text: txt(e), sw: e.scrollWidth, cw: e.clientWidth }));
  // offscreen controls
  const inScroller = (e) => { for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) return true; } return false; };
  const offscreen = leaf.filter((e) => !inScroller(e)).filter((e) => { const r = e.getBoundingClientRect(); return r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1; }).map((e) => ({ el: path(e), text: txt(e), r: (({ left, top, right, bottom }) => ({ l: Math.round(left), t: Math.round(top), r: Math.round(right), b: Math.round(bottom) }))(e.getBoundingClientRect()) }));
  // control sizes (buttons/inputs heights histogram)
  const heights = {};
  for (const e of leaf) if (["BUTTON", "INPUT", "SELECT"].includes(e.tagName) && e.type !== "range" && e.type !== "checkbox") { const h = Math.round(e.getBoundingClientRect().height); heights[h] = (heights[h] ?? 0) + 1; }
  // canvas
  const view = document.getElementById("view")?.getBoundingClientRect();
  const v2 = (id) => { const e = document.getElementById(id); return e && vis(e) ? e.getBoundingClientRect() : null; };
  const top = v2("vtop"), tip = v2("vtip"), strip = v2("xstrip"), edge = v2("toolpalette");
  const canvas = view ? { w: Math.round(view.width), h: Math.round(view.height), sharePct: +((view.width * view.height) / (W * H) * 100).toFixed(1), free: (() => { const l = edge ? edge.right + 6 : view.left; const t = top ? top.bottom + 4 : view.top; const b = Math.min(tip?.top ?? view.bottom, strip?.top ?? view.bottom); return { w: Math.round(view.right - l), h: Math.round(b - t), pct: +(((view.right - l) * (b - t)) / (W * H) * 100).toFixed(1) }; })() } : null;
  // titles: derived generic ones
  const generic = [...document.querySelectorAll("button, input, select")].filter(vis).filter((e) => /^(Button|Field|Number|Slider|Choose|Toggle)( \(|$)/.test(e.title)).map((e) => ({ el: path(e), text: txt(e), title: e.title }));
  const noTitle = [...document.querySelectorAll("button, input, select")].filter(vis).filter((e) => !e.title).length;
  return { viewport: { W, H }, canvas, overlaps, fonts, small, lowContrast, scrollers, clipped, offscreen, heights, genericTitles: generic, noTitle };
};

for (const [w, h] of sizes) {
  const tag = `${w}x${h}`;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
  await page.waitForTimeout(1200);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(opts.wait ?? 500);
    const file = resolve(out, `${name}-${tag}.png`);
    await page.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
    try {
      const m = await E(SWEEP);
      report[`${name}-${tag}`] = m;
      console.log(`${name} ${tag}: canvas ${m.canvas?.sharePct ?? "-"}% free ${m.canvas?.free.pct ?? "-"}% overlaps ${m.overlaps.length} small ${m.small.length} lowC ${m.lowContrast.length} clipped ${m.clipped.length} off ${m.offscreen.length} scrollers ${m.scrollers.length} noFade ${m.scrollers.filter((x) => x.sh > x.ch + 2 && !x.fade).length}`);
    } catch (e) { console.log(`${name} ${tag}: sweep failed ${e.message}`); }
  };
  const safe = async (name, fn) => { if (quick && !QUICK.has(name)) return; try { await fn(); } catch (e) { console.log(`!! ${name} ${tag}: ${e.message.split("\n")[0]}`); } };
  const ws = async (id) => { await E((x) => window.atlasEditor.workspace(x), id); await page.waitForTimeout(700); };
  const fit = async () => { await E(() => window.atlasEditor.fit?.()); await page.waitForTimeout(400); };
  const tab = async (id) => { await E((t) => window.atlasEditor.showTab(t), id); await page.waitForTimeout(300); };

  // ---- Home
  await safe("home", async () => { await ws("home"); await shot("01-home"); });
  await safe("home-hover", async () => { await page.hover("#home .home-card[data-go='animate']"); await shot("01-home-hover-card", { wait: 400 }); });
  await safe("home-focus", async () => { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await shot("01-home-focus", { wait: 200 }); });

  // ---- Animate before any clip (empty-ish state: a rig with the default clip only)
  await safe("animate-noclip", async () => { await ws("animate"); await fit(); await shot("02-animate-noclip"); });
  await safe("animate-empty", async () => { const on = await E(() => !document.getElementById("animempty")?.hidden); console.log("animate empty-state card", on ? "shown" : "MISSING"); });
  await safe("guide", async () => { await E(() => window.atlasEditor.showGuide("animate")); await shot("02-animate-first-run-card", { wait: 400 }); await E(() => window.atlasEditor.hideGuide()); });

  // ---- Clip board
  await safe("clipboard", async () => { await page.click("#home .home-card[data-go='animate']").catch(async () => { await ws("home"); await page.click("#home .home-card[data-go='animate']"); }); await page.waitForTimeout(800); await shot("03-clipboard"); });
  await safe("clipboard-filter", async () => { await page.click("#clipboard [data-filter='missing']"); await shot("03-clipboard-filter-missing", { wait: 300 }); await page.click("#clipboard [data-filter='all']"); });
  await safe("clipboard-hover", async () => { await page.hover("#clipboard .cb-dot[data-clip='atk_sword_ronin_1']"); await shot("03-clipboard-hover-dot", { wait: 300 }); });
  await safe("clipboard-menu", async () => { await page.click("#clipboard .cb-dot[data-clip='atk_sword_ronin_1']", { button: "right" }); await shot("03-clipboard-menu", { wait: 300 }); });
  await safe("clipboard-confirm", async () => {
    const acts = await E(() => [...document.querySelectorAll("#clipboard .cb-menu-item")].map((b) => [b.dataset.act, b.textContent]));
    console.log("menu acts", JSON.stringify(acts));
    const dup = acts.find((a) => /dup/i.test(a[0]) || /Duplicate/i.test(a[1]));
    await page.click(`#clipboard .cb-menu-item[data-act='${dup ? dup[0] : "done"}']`);
    await shot("03-clipboard-confirm", { wait: 400 });
    await page.click("#clipboard .cb-cancel").catch(() => {});
  });
  // open an attack clip from the board (creates it from the template, switches to Animate with game view for attacks)
  await safe("open-clip", async () => { await page.click("#clipboard .cb-dot[data-clip='atk_sword_ronin_1']"); await page.waitForTimeout(1500); });
  await safe("animate-as-opened", async () => { await shot("04-animate-as-opened-from-board", { wait: 800 }); });
  await safe("animate-gameview-off", async () => { await E(() => window.atlasEditor.gameView(false)); await fit(); await shot("04-animate-clip"); });
  // dock states
  await safe("animate-dock-open", async () => { const mode = await E(() => (document.getElementById("app").classList.contains("dockopen") ? (document.getElementById("app").classList.contains("dockrail") ? "rail" : "open") : "hidden")); console.log("dock mode", mode); if (mode !== "open") await page.click("#dock-open").catch(() => {}); await fit(); await shot("04-animate-dock-open"); });
  await safe("animate-dock-rail", async () => { await page.click("#dock-collapse"); await fit(); await shot("04-animate-dock-rail"); });
  await safe("animate-gameview", async () => { await E(() => window.atlasEditor.gameView(true)); await fit(); await shot("04-animate-gameview", { wait: 900 }); await E(() => window.atlasEditor.gameView(false)); await page.click("#dock-open").catch(() => {}); });
  // rules pill expanded
  await safe("animate-rules", async () => { await E(() => window.atlasEditor.rotate("upper_arm_l", -170)); await E(() => window.atlasEditor.key()); await page.waitForTimeout(300); await page.click("#rules-pill"); await fit(); await shot("04-animate-rules-expanded"); await page.click("#rules-pill"); await E(() => window.atlasEditor.undo()); });
  // Paths and Pins popovers
  await safe("animate-paths", async () => { await page.click("#paths-toggle"); await shot("04-animate-paths-popover"); await page.click("#paths-toggle"); });
  await safe("animate-pins", async () => { await page.click("#pins-toggle"); await shot("04-animate-pins-popover"); await page.click("#pins-toggle"); });
  // hit-lock chip
  await safe("animate-hitlock", async () => { const st = await E(() => ({ hidden: document.getElementById("hitlock")?.hidden, text: document.getElementById("hitlock-pill")?.textContent })); console.log("hitlock", JSON.stringify(st)); if (st && !st.hidden) { await page.click("#hitlock-pill"); await shot("04-animate-hitlock-open"); await page.click("#hitlock-pill"); } else await shot("04-animate-hitlock-hidden", { clip: { x: 0, y: 0, width: w, height: 200 } }); });
  // phone preview popover
  await safe("animate-phonepop", async () => { await page.click("#phonebtn"); await shot("04-animate-phone-popover", { wait: 1200 }); await page.click("#phoneclose").catch(() => {}); });
  // bone list -> full tree + property panel
  await safe("animate-bones", async () => { await E(() => document.getElementById("app").classList.remove("lcol")); await page.waitForTimeout(200); await shot("04-animate-bonelist-open"); });
  await safe("animate-tree", async () => { await page.click("#bones .bones-showall:has-text('tree')"); await page.waitForTimeout(400); await E(() => window.atlasEditor.select("upper_arm_l")); await shot("04-animate-tree-props"); });
  await safe("animate-tree-back", async () => { await page.click("#outliner .ol-simple"); await page.waitForTimeout(300); });
  // tween panel (Keys tab)
  await safe("animate-tween", async () => { await tab("keys"); await E(() => document.getElementById("tweenpanel")?.scrollIntoView()); await shot("04-animate-keys-tab-tween"); });
  await safe("animate-library", async () => { await tab("library"); await shot("04-animate-library-tab"); await tab("pose"); });
  // transform strip zoom
  await safe("animate-strip", async () => { const r = await E(() => document.getElementById("xstrip")?.getBoundingClientRect().toJSON()); if (r) await shot("04-animate-transform-strip-zoom", { clip: { x: r.x, y: r.y - 30, width: r.width, height: r.height + 30 } }); });
  // hover + focus
  await safe("animate-hover", async () => { await page.hover("#setkey"); await shot("04-animate-hover-primary", { wait: 300, clip: { x: 0, y: h - 400, width: w, height: 400 } }); });
  // keys sheet
  await safe("help", async () => { await page.click("#helpbtn"); await page.click("#help-keys"); await shot("05-help-sheet"); await page.click("#helpclose"); });
  // playing state
  await safe("animate-playing", async () => { await page.click("#play"); await page.waitForTimeout(400); await shot("04-animate-playing", { wait: 100 }); await page.click("#play"); });

  // ---- Pro: every tab + graph
  await safe("pro", async () => { await ws("pro"); await fit(); });
  for (const t of ["pose", "keys", "rig", "skins", "preview", "library", "export"]) await safe(`pro-${t}`, async () => { await tab(t); await shot(`06-pro-${t}`); });
  await safe("pro-graph", async () => { await tab("keys"); await page.click("#graphbtn"); await fit(); await shot("06-pro-graph", { wait: 800 }); await page.click("#graphbtn"); });
  await safe("pro-newclip", async () => { await page.click("#newclip-open"); await shot("06-pro-newclip-inline", { clip: { x: 0, y: 0, width: w, height: 120 } }); await page.click("#newclip-cancel"); });
  await safe("pro-setup", async () => { await page.click("#modeseg [data-mode='setup']"); await fit(); await shot("06-pro-setup-mode"); await page.click("#modeseg [data-mode='animate']"); });

  // ---- Rig
  await safe("rig", async () => { await ws("rig"); await fit(); await shot("07-rig"); });
  await safe("rig-skins", async () => { await tab("skins"); await shot("07-rig-skins"); });
  await safe("rig-select", async () => { await E(() => window.atlasEditor.select("head")); await shot("07-rig-selected-head"); });

  // ---- Swag
  await safe("swag", async () => { await ws("swag"); await fit(); await shot("08-swag-list"); });
  await safe("swag-item", async () => { const first = await E(() => document.querySelector(".swrow")?.dataset.item); console.log("first item", first); if (first) { await page.click(`.swrow[data-item='${first}']`); await shot("08-swag-item-selected"); } });
  await safe("swag-wear", async () => { await page.click(".swrow.sel [data-act='wear']").catch(() => page.click(".swrow [data-act='wear']")); await fit(); await shot("08-swag-wearing", { wait: 900 }); });
  await safe("swag-delete-confirm", async () => { const first = await E(() => document.querySelector(".swrow")?.dataset.item); await page.click(`.swrow[data-item='${first}']`, { timeout: 4000 }).catch(() => {}); await page.waitForTimeout(300); const has = await E(() => !!document.querySelector("[data-act='delete']")); console.log("delete btn", has); if (has) { await page.click("[data-act='delete']", { timeout: 4000 }).catch(() => {}); await shot("08-swag-delete-confirm"); await page.click(`.swrow[data-item='${first}']`); await page.waitForTimeout(200); await page.click(`.swrow[data-item='${first}']`); } });
  await safe("swag-sheet", async () => { await page.click("[data-act='sheet']"); await shot("08-swag-contact-sheet", { wait: 4000 }); });
  await safe("swag-sweep", async () => { await page.click("#swagsheet [data-mode='sweep']"); await shot("08-swag-pose-sweep", { wait: 4000 }); await page.click("[data-act='close-sheet']"); });
  await safe("swag-new", async () => { await page.click("#swnew"); await shot("08-swag-new-step1"); });
  await safe("swag-new-slot", async () => { await page.click(".swdoll .zone[data-slot='chest']"); await page.fill("#switemname", "Test Vest"); await shot("08-swag-new-step2-named"); });
  await safe("swag-new-view", async () => { await page.click(".swseg [data-view='turned']", { timeout: 2000 }).catch(() => {}); await shot("08-swag-new-turned", { wait: 900 }); await page.click("[data-act='cancel']"); });
  await safe("swag-preview-tab", async () => { await tab("preview"); await shot("08-swag-preview-tab"); await tab("skins"); });

  // ---- Ship
  await safe("ship", async () => { await ws("ship"); await shot("09-ship"); });

  // ---- Rig with no clips: fresh profile is the same data dir; emulate by dropping clips? Skip destructive; capture Pro clip select state instead.
  await safe("pro-clipselect", async () => { await ws("pro"); const n = await E(() => document.getElementById("clip").options.length); console.log("clip options", n); });

  // Focus ring sample in Pro
  await safe("pro-focus", async () => { await page.focus("#fit"); await shot("06-pro-focus-ring", { clip: { x: 0, y: 0, width: w, height: 160 } }); });

  if (errors.length) { console.log("PAGE ERRORS", tag, [...new Set(errors)].slice(0, 10)); pageErrors += errors.length; }
  await page.close();
}
writeFileSync(resolve(out, "measurements.json"), JSON.stringify(report, null, 1));
await browser.close();
const totalOverlaps = Object.values(report).reduce((n, m) => n + m.overlaps.length, 0);
console.log(`SUMMARY overlaps ${totalOverlaps} pageErrors ${pageErrors}`);
process.exit(pageErrors ? 1 : 0);
