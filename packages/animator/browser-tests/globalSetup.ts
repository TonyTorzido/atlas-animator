/*
 * Atlas Animator: original implementation.
 *
 * Builds the render harness page (harness/) with Vite into browser-tests/dist before the tests.
 */
import { fileURLToPath } from "node:url";
import { build } from "vite";

export default async function globalSetup(): Promise<void> {
  const root = fileURLToPath(new URL("./harness/", import.meta.url));
  await build({
    root,
    base: "./",
    logLevel: "warn",
    configFile: false,
    build: { outDir: fileURLToPath(new URL("./dist/", import.meta.url)), emptyOutDir: true, sourcemap: true, target: "es2022" }
  });
}
