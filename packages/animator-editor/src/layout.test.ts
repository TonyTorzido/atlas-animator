import { describe, expect, it } from "vitest";
import { collapsedFor, defaultCollapsed, WIDE_WINDOW } from "./layout.js";
import { dockModeFor } from "./phoneDock.js";

describe("panel defaults", () => {
  it("collapses the bone list in Animate on windows narrower than the wide breakpoint", () => {
    expect(defaultCollapsed("left", "animate", 1340)).toBe(false);
    expect(defaultCollapsed("left", "animate", 1600)).toBe(false);
    expect(defaultCollapsed("left", "animate", WIDE_WINDOW)).toBe(false);
    expect(defaultCollapsed("left", "pro", 1340)).toBe(false);
    expect(defaultCollapsed("right", "animate", 1340)).toBe(false);
  });
  it("a remembered choice wins over the default", () => {
    expect(collapsedFor("left", "animate", 1340, { left: false })).toBe(false);
    expect(collapsedFor("right", "pro", 1920, { right: true })).toBe(true);
    expect(collapsedFor("left", "animate", 1340, {})).toBe(false);
    expect(collapsedFor("left", "animate", 1340, { left: true })).toBe(true);
    expect(collapsedFor("left", "swag", 1340, { left: true })).toBe(false);
    expect(collapsedFor("right", "swag", 1340, { right: false })).toBe(true);
  });
});

describe("dock default on narrow windows", () => {
  it("starts on the rail in Animate and Swag below the wide breakpoint, open above it", () => {
    expect(dockModeFor("animate", 1340)).toBe("rail");
    expect(dockModeFor("animate", 1600)).toBe("rail");
    expect(dockModeFor("animate", 1920)).toBe("rail");
    expect(dockModeFor("animate", 2560)).toBe("open");
    expect(dockModeFor("swag", 1340)).toBe("rail");
    expect(dockModeFor("pro", 1340)).toBe("rail");
    expect(dockModeFor("rig", 1340)).toBe("hidden");
  });
});
