// One command for the Atlas Animator gate:  pnpm --filter @atlas-animator/editor verify   (or `pnpm verify` inside this package;
// from the repo root `pnpm verify`).  Runs, in order, tsc for both packages, vitest for both, the browser QA suite with
// --strict-xpass, qa-pipeline (Batch 9), qa-persistence and qa-data-safety, then prints one summary and exits non-zero if any step failed.
// Every step runs even after a failure, so one run shows everything that is broken.  The log of each step is kept in a temp folder.
//   node scripts/verify.mjs [--fast]     --fast skips the browser suites (qa, pipeline, persistence, data-safety) for a quick check.
// The browser suites start their own sandboxed servers on free ports and temp data folders; they never touch :5211 or the user's data.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDITOR = fileURLToPath(new URL("..", import.meta.url));
const ENGINE = resolve(EDITOR, "../animator");
const fast = process.argv.includes("--fast");
const logs = join(tmpdir(), `atlas-animator-verify-${Date.now()}`);
mkdirSync(logs, { recursive: true });

const node = (...args) => ({ cmd: process.execPath, args });
const pnpm = (...args) => ({ cmd: "pnpm", args, shell: true });
const steps = [
  { name: "tsc animator", cwd: ENGINE, ...pnpm("run", "typecheck") },
  { name: "tsc animator-editor", cwd: EDITOR, ...pnpm("run", "typecheck") },
  { name: "vitest animator", cwd: ENGINE, ...pnpm("run", "test") },
  { name: "vitest animator-editor", cwd: EDITOR, ...pnpm("run", "test") },
  { name: "qa --strict-xpass", cwd: EDITOR, browser: true, ...node("scripts/qa-core.mjs", "--strict-xpass", "--skip-pipeline") },
  { name: "qa-pipeline", cwd: EDITOR, browser: true, ...node("scripts/qa-pipeline.mjs") },
  { name: "qa-persistence", cwd: EDITOR, browser: true, ...node("scripts/qa-persistence.mjs") },
  { name: "qa:data-safety", cwd: EDITOR, browser: true, ...node("scripts/qa-data-safety.mjs") }
];

function run(step, index) {
  return new Promise((done) => {
    const log = join(logs, `${index + 1}-${step.name.replace(/[^a-z0-9]+/gi, "-")}.log`);
    const out = createWriteStream(log);
    const started = Date.now();
    const child = step.shell ? spawn([step.cmd, ...step.args].join(" "), { shell: true, cwd: step.cwd, env: { ...process.env, FORCE_COLOR: "0" } }) : spawn(step.cmd, step.args, { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => { out.write(`spawn error: ${e.message}\n`); });
    child.on("close", (code) => {
      out.end();
      done({ ...step, log, code: code ?? 1, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const results = [];
for (const [i, step] of steps.entries()) {
  if (fast && step.browser) { results.push({ ...step, skipped: true }); continue; }
  process.stdout.write(`... ${step.name}\n`);
  const r = await run(step, i);
  results.push(r);
  process.stdout.write(`${r.code === 0 ? "PASS" : "FAIL"} ${step.name} (${r.seconds.toFixed(0)} s)\n`);
}

console.log("\n=== Atlas Animator verify ===");
for (const r of results) {
  const status = r.skipped ? "SKIP" : r.code === 0 ? "PASS" : "FAIL";
  console.log(`${status}  ${r.name.padEnd(24)} ${r.skipped ? "(--fast)" : `${r.seconds.toFixed(0)} s`}`);
}
const failed = results.filter((r) => !r.skipped && r.code !== 0);
for (const r of failed) {
  const text = readFileSync(r.log, "utf8").trimEnd().split(/\r?\n/);
  console.log(`\n--- ${r.name}: last lines of ${r.log}`);
  console.log(text.slice(-25).join("\n"));
}
console.log(failed.length ? `\nverify FAILED: ${failed.map((r) => r.name).join(", ")}` : `\nverify OK${fast ? " (browser suites skipped)" : ""}; logs in ${logs}`);
process.exit(failed.length ? 1 : 0);
