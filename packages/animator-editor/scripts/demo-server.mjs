// Shared by every demo script: gives it a throw-away editor server so demo runs never write into the user's editor data.
//   const { url, dataDir } = await demoServer(process.argv[3]);
// Starts its own Vite dev server on a free port with ATLAS_EDITOR_DATA_DIR pointing at a fresh temp folder (clips, poses,
// autosave, exports, history and the rig copies the run edits live there; the stock rigs in the repo are never written), and removes both when the script exits. A URL argument is ignored,
// because a server started by hand has no sandbox; the one exception is the user's server on :5211, which is refused
// unless --allow-user-server is passed (then that URL is used as is, and the demo writes into the user's data).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageDir = resolve(here, "..");

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** True when `url` points at the user's server (port 5211). */
export const isUserServer = (url) => /:5211(\/|$)/.test(url ?? "");

export async function demoServer(urlArg, argv = process.argv) {
  if (isUserServer(urlArg)) {
    if (!argv.includes("--allow-user-server")) {
      console.error("Refusing to run against port 5211 (the user's server): demos write into the user's editor data. Omit the URL (the demo starts its own sandboxed server) or pass --allow-user-server.");
      process.exit(2);
    }
    return { url: urlArg, dataDir: null };
  }
  if (urlArg && !urlArg.startsWith("--")) console.log(`note: ignoring ${urlArg}; starting a sandboxed server instead (demos never use a server they did not start)`);
  const dataDir = mkdtempSync(resolve(tmpdir(), "atlas-editor-demo-"));
  const port = await freePort();
  const viteBin = resolve(dirname(createRequire(resolve(packageDir, "package.json")).resolve("vite/package.json")), "bin/vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: packageDir,
    env: { ...process.env, ATLAS_EDITOR_DATA_DIR: dataDir },
    stdio: "ignore"
  });
  child.unref();
  const cleanup = () => {
    try {
      child.kill();
    } catch {}
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`sandbox vite server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}api/clips`)).ok) return { url, dataDir };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("sandbox vite server did not start in 60 s");
}
