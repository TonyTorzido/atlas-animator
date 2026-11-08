// Atlas Animator: original implementation.
//
// Runs the built phone bench headless in Chromium (hardware GPU via ANGLE when available) and
// writes the result JSON. The page is served (routed, no network) under the strict CSP of an
// artifact page (no eval, no fetch); any CSP violation or page error fails the run. Usage:
//   node packages/animator/bench-page/run.mjs [quick|full|smoke] [out.json] [--swiftshader] [--no-csp]
//     [--throttle=N] (CDP CPU throttling, the phone proxy) [--page=bench.html] [--query=rig=x&scenario=y]
//     [--profile=out.cpuprofile] (V8 sampling profile of the measured run)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const demos = resolve(here, "../../../docs/plans/atlas-animator-demos/phase-4d4f");
const mode = process.argv[2] === "full" ? "full" : "quick";
const smoke = process.argv[2] === "smoke"; // 2 s scenarios: checks the harness, not a measurement
const out = resolve(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : join(demos, "desktop-baseline.json"));
const swiftshader = process.argv.includes("--swiftshader");
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const throttle = Number(flag("throttle") ?? 1);
const pageFile = flag("page") ?? "bench.html";
const extraQuery = flag("query");
const profileOut = flag("profile");
const csp = process.argv.includes("--no-csp")
  ? null
  : "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src blob:";
const args = swiftshader
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"];

const browser = await chromium.launch({ headless: true, args });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  const query = `?autostart=${mode}${smoke ? "&seconds=2" : ""}${extraQuery ? `&${extraQuery}` : ""}`;
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  if (profileOut) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
  }
  if (csp) {
    const html = readFileSync(resolve(demos, pageFile));
    await page.route("http://bench.test/**", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }, body: html }));
    await page.goto(`http://bench.test/bench.html${query}`);
  } else {
    await page.goto(`${pathToFileURL(resolve(demos, pageFile)).href}${query}`);
  }
  const timeout = (mode === "full" ? 13 : 4) * 60_000 * Math.max(1, throttle / 2);
  await page.waitForFunction(() => window.__benchResults !== undefined || document.getElementById("errors")?.textContent, undefined, { timeout, polling: 1000 }).catch((error) => {
    throw new Error(`bench did not finish: ${error.message}${errors.length ? `; page errors: ${errors.join("; ")}` : ""}`);
  });
  const shown = await page.evaluate(() => document.getElementById("errors")?.textContent ?? "");
  if (shown) throw new Error(`bench page shows an error: ${shown}`);
  const json = await page.evaluate(() => window.__benchResults);
  if (throttle > 1) json.cpuThrottlingRate = throttle;
  if (profileOut) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(resolve(profileOut), JSON.stringify(profile));
    console.log(`wrote ${resolve(profileOut)}`);
  }
  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  if (csp) console.log(`CSP: ${violations.length} violations${violations.length ? `: ${violations.join("; ")}` : ""}`);
  if (violations.length || errors.length) process.exitCode = 1;
  writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote ${out}`);
  if (errors.length) console.log(`page errors: ${errors.join("; ")}`);
} finally {
  await browser.close();
}
