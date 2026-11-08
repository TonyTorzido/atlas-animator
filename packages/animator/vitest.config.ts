import { defineConfig } from "vitest/config";

// Test files that build surface rigs (tools/surface buildRig: a template7 build blocks one process
// for ~35 s uncontended). A test that blocks longer than vitest's fixed 60 s worker RPC timeout
// fails the run ("Timeout calling onTaskUpdate"), which happened when these ran in parallel with
// everything else. They run as their own project: after the unit project (groupOrder), in one
// fork without isolation, so the canonical rigs are built once and shared (surface/testRigs.ts),
// and each test yields first (surface/testYield.ts) so no RPC reply waits behind several of them.
const surface = [
  "src/tools/surface/build.test.ts",
  "src/tools/surface/regions.test.ts",
  "src/tools/surface/clearance.test.ts",
  "src/tools/surface/solver.test.ts",
  "src/tools/surface/review4d4k.test.ts",
  "src/tools/mirrorRig.test.ts",
  // builds the canonical shoulder rig (~80 s in the parallel unit run: the 60 s RPC timeout fired)
  "src/tools/mirrorOpaque.test.ts",
  "src/tools/validateGeometry.test.ts"
];

export default defineConfig({
  test: {
    // Browser render tests (Playwright, SwiftShader) live in browser-tests/ and run with `test:browser`.
    // `include` is set per project (a root include would be merged into both).
    // The steady-state allocation test (src/pixi/allocation.test.ts) forces GC; it skips without it.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", ...surface], sequence: { groupOrder: 0 } } },
      {
        extends: true,
        test: {
          name: "surface",
          include: surface,
          sequence: { groupOrder: 1 },
          setupFiles: ["src/tools/surface/testYield.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          poolOptions: { forks: { singleFork: true, isolate: false } }
        }
      }
    ]
  }
});
