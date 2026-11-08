// Atlas Animator: original implementation.
//
// Builds the phone bench into ONE self-contained HTML file: the bench bundle (Pixi + the
// animator runtime, esbuild IIFE) and both rigs with their atlas pages (base64 data URLs) inline.
// Usage: node packages/animator/bench-page/build.mjs [out.html]
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const demos = join(repo, "docs/plans/atlas-animator-demos");
// --no-minify keeps function names (CPU profiles); the published bench is minified.
const noMinify = process.argv.includes("--no-minify");
const outArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const out = resolve(outArg ?? join(demos, "phase-4d4f/bench.html"));
// esbuild ships with vite (a devDependency of this package).
const esbuild = createRequire(createRequire(join(here, "../package.json")).resolve("vite"))("esbuild");

const bundle = await esbuild.build({
  entryPoints: [join(here, "main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: !noMinify,
  keepNames: noMinify,
  write: false,
  legalComments: "none",
  logLevel: "warning"
});
const js = bundle.outputFiles[0].text;

function rig(id, label, note, docPath, atlasPath, clips, skins) {
  const atlas = JSON.parse(readFileSync(atlasPath, "utf8"));
  const pages = {};
  for (const page of atlas.pages) pages[page.file] = `data:image/png;base64,${readFileSync(join(dirname(atlasPath), page.file)).toString("base64")}`;
  return { id, label, note, document: JSON.parse(readFileSync(docPath, "utf8")), atlas, pages, clips, skins, figureHeight: 1074 };
}

const rigs = [
  rig(
    "sparse-shoulder",
    "Sparse template7 shoulder (runtime rig)",
    " sparse runtime rig: torso, tank (garment sandwich), one arm, head, 5 contours, correctives. Half a body: per-character numbers are a lower bound for a dressed body. Clips: raise_elbow70 looped, transition to elbow.",
    join(demos, "phase-4d4e/rig/template7-shoulder.anim.json"),
    join(demos, "phase-4d4e/rig/template7-shoulder.atlas.json"),
    ["raise_elbow70", "elbow"],
    ["body"]
  ),
  rig(
    "full-body",
    "Full-body humanoid template7 (phase 4)",
    "Phase 4 full-body rig (15 slots, 24 bones, IK, no contours, pre-4d topology): whole-body slot/draw-order realism. Clips: generated looping sway (1.6 s, 6 deg) and a larger sway (1.0 s, 14 deg).",
    join(demos, "phase-4/rig/humanoid-template7.anim.json"),
    join(demos, "phase-4/rig/humanoid-template7.atlas.json"),
    ["sway", "sway_big"],
    ["body"]
  )
];

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
} catch {}
const safe = (text) => text.replace(/<\/(script)/gi, "<\\/$1");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Animator Phone Bench</title>
<style>
:root { --bg: #f4f2ee; --fg: #1d1f23; --muted: #5d636b; --card: #ffffff; --line: #d9d5cc; --accent: #2f6fdf; --pass: #1f7a3f; --pass-bg: #e3f3e8; --fail: #b3261e; --fail-bg: #fbe5e3; --na: #6b6f75; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #16181c; --fg: #e8e6e1; --muted: #9aa0a8; --card: #1f2227; --line: #343840; --accent: #6d9cff; --pass: #7fd69a; --pass-bg: #1c3325; --fail: #ff8a80; --fail-bg: #3a1f1d; --na: #9aa0a8; } }
:root[data-theme="dark"] { --bg: #16181c; --fg: #e8e6e1; --muted: #9aa0a8; --card: #1f2227; --line: #343840; --accent: #6d9cff; --pass: #7fd69a; --pass-bg: #1c3325; --fail: #ff8a80; --fail-bg: #3a1f1d; --na: #9aa0a8; }
* { box-sizing: border-box; scrollbar-width: none; }
*::-webkit-scrollbar { display: none; width: 0; height: 0; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-x: hidden; }
main { max-width: 860px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 24px 0 8px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
p { margin: 6px 0; }
.sub, .device, .note, #build { color: var(--muted); font-size: 13px; }
.buttons { display: flex; gap: 12px; margin: 18px 0 8px; flex-wrap: wrap; }
button { flex: 1 1 140px; min-height: 64px; font: 600 18px/1.2 inherit; border: 0; border-radius: 14px; background: var(--accent); color: #fff; cursor: pointer; }
button.secondary { background: var(--card); color: var(--fg); border: 2px solid var(--accent); }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child { text-align: left; }
thead th { font-weight: 600; color: var(--muted); vertical-align: bottom; }
td.pass { color: var(--pass); background: var(--pass-bg); }
td.fail { color: var(--fail); background: var(--fail-bg); font-weight: 600; }
td.na { color: var(--na); }
details { margin-top: 18px; }
summary { cursor: pointer; font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px; max-height: 60vh; overflow: auto; }
#stage { position: fixed; inset: 0; display: none; z-index: 1; }
#stage canvas { display: block; }
#hud { position: fixed; left: 0; right: 0; top: 0; z-index: 2; display: none; padding: 10px 16px; background: rgba(0,0,0,0.55); color: #fff; font-size: 13px; }
#track { height: 8px; border-radius: 4px; background: rgba(255,255,255,0.25); margin-top: 6px; overflow: hidden; }
#bar { height: 100%; width: 0; background: #6d9cff; }
@media (max-width: 640px) {
  .table { overflow: visible; border: 0; background: transparent; }
  table, tbody, tr, td, th { display: block; width: 100%; }
  thead { display: none; }
  tr { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-bottom: 10px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--card); }
  tr > th { grid-column: 1 / -1; text-align: left; border-bottom: 1px solid var(--line); }
  td { text-align: left; border-bottom: 1px solid var(--line); white-space: normal; }
  td::before { content: attr(data-label); display: block; font-size: 11px; color: var(--muted); }
}
#pageStatus { font-size: 13px; color: var(--muted); }
#errors { display: none; margin: 14px 0; padding: 12px; border-radius: 10px; background: var(--fail-bg); color: var(--fail); white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
#errors.shown { display: block; }
body.running { overflow: hidden; }
body.running #stage, body.running #hud { display: block; }
body.running main { visibility: hidden; }
</style>
</head>
<body>
<script>
// Visible failures: a script error or rejected promise is printed on the page (and the run view is
// dropped so it cannot hide it). Installed before the bench bundle so bundle errors are caught too.
(function () {
  function show(text) {
    var box = document.getElementById("errors");
    if (!box) { document.addEventListener("DOMContentLoaded", function () { show(text); }); return; }
    box.className = "shown";
    box.textContent += (box.textContent ? "\\n\\n" : "") + text;
    document.body.classList.remove("running");
    var status = document.getElementById("pageStatus");
    if (status) status.textContent = "The bench hit an error (below).";
  }
  window.showBenchError = function (text) { show("Error: " + text); };
  window.addEventListener("error", function (e) { show("Error: " + (e.message || e.type) + (e.filename ? " (" + e.filename.slice(0, 80) + ":" + e.lineno + ":" + e.colno + ")" : "") + (e.error && e.error.stack ? "\\n" + e.error.stack : "")); });
  window.addEventListener("unhandledrejection", function (e) { var r = e.reason; show("Unhandled rejection: " + (r && r.stack ? r.stack : String(r))); });
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", function (e) { window.__cspViolations.push(e.violatedDirective + " " + (e.blockedURI || "")); show("Blocked by the page's security policy: " + e.violatedDirective + " " + (e.blockedURI || "") + (e.sample ? " (" + e.sample + ")" : "")); });
})();
</script>
<div id="stage"></div>
<div id="hud"><div id="status">Starting</div><div id="track"><div id="bar"></div></div></div>
<main>
<h1>Animator phone bench</h1>
<p class="sub">Phase. 50 and then 20 characters (20 = total animated actors, players plus mobs; ?count=N runs one count), 30 fps held frames, a 60 Hz display, production game scale (figure = ${140} game px) at this device's DPR. Two rigs, five scenarios each: synchronized, phased, moving crowd, repeated clip transitions and pinch-zoom. Keep the screen on and the page in front: a run with any gap over 250 ms or a hidden page is marked INVALID.</p>
<p id="pageStatus">Loading the bench script...</p>
<noscript><p>This bench needs JavaScript.</p></noscript>
<div id="errors" role="alert"></div>
<div class="buttons"><button id="quick">Quick<br><small>15 s per scenario, 50 + 20, about 6 min</small></button><button id="full" class="secondary">Full<br><small>60 s per scenario, 50 + 20, about 22 min</small></button><button id="long" class="secondary">Long<br><small>5 min sustained per rig at 20, about 11 min</small></button></div>
<p class="sub">Targets: at most 100 draw calls for the crowd, at most 2500 vertices per character, CPU at most 5 ms p95 and 8 ms p99, under 1% lost refresh opportunities (against the expected 60 Hz period), GPU at most 5 ms p95 where the timer is available, and zero work on cache hits.</p>
<div id="results"></div>
<p id="build"></p>
</main>
<script>window.BENCH_RIGS = ${safe(JSON.stringify(rigs))}; window.BENCH_BUILD = ${JSON.stringify({ commit, built: new Date().toISOString() })};</script>
<script>${safe(js)}</script>
</body>
</html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}: ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB (bundle ${(js.length / 1024).toFixed(0)} KB)`);
