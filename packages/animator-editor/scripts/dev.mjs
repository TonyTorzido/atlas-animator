// Starts the editor dev server on any OS. By default your work is kept in your own data folder (see README: "Where data is stored");
//   node scripts/dev.mjs [--sandbox] [--port 5211] [--data-dir <absolute folder>] [--publish-dir <absolute folder>]
// --sandbox keeps everything in <checkout>/.atlas-sandbox-data instead (throwaway data for trying things out).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const editor = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const env = { ...process.env };
if (!flag("--sandbox")) env.ATLAS_EDITOR_USER_DATA = "1";
const dataDir = value("--data-dir", "");
if (dataDir) env.ATLAS_EDITOR_DATA_DIR = resolve(dataDir);
const publishDir = value("--publish-dir", "");
if (publishDir) env.ATLAS_EDITOR_PUBLISH_DIR = resolve(publishDir);
const port = value("--port", "5211");
const vite = resolve(dirname(createRequire(resolve(editor, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
const child = spawn(process.execPath, [vite, "--port", port, "--strictPort"], { cwd: editor, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
