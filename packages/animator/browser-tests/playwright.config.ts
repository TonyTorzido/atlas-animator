import { defineConfig } from "@playwright/test";

/*
 * Render tests for the Pixi adapter in headless Chromium with SwiftShader (software WebGL), so
 * goldens do not depend on the machine's GPU. The harness page is built by globalSetup and served
 * through request routing (no port). Regenerate goldens on purpose only:
 *   ANIMATOR_UPDATE_GOLDENS=1 pnpm --filter @atlas-animator/core test:browser
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  globalSetup: "./globalSetup.ts",
  outputDir: "../test-results/browser",
  use: {
    browserName: "chromium",
    viewport: { width: 400, height: 400 },
    deviceScaleFactor: 1,
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    }
  }
});
