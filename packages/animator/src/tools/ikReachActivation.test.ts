import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "../core/format.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { describeViolations, limitDocument, newViolations } from "./liveLimits.js";
import { checkPoseLimits, type ValidationIssue } from "./validate.js";

/*
 * Live and batch IK reach checks share the skeleton's constraint-activation rules: an active overextended chain is found by both, an inactive skin chain by
 * neither, IK-only documents reach the live check, and a correction is offered only when it
 * resolves the violation.
 */

/** Two 50 px bones reaching for a target at 99.8 px (0.998 of the chain: past MAX_IK_REACH 0.995 = overextended). */
function json(ik: { skin?: boolean } = {}, skins: Record<string, { constraints?: string[] }> = { body: {} }, limits = false) {
  const doc: AnimDocumentInput & { format: string; name: string; canvas: unknown } = {
    format: "atlas-anim@1",
    name: "arm",
    canvas: { width: 200, height: 200, originX: 0, originY: 0 },
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", length: 50, rotation: 10 },
      { name: "lower", parent: "upper", x: 50, length: 50, rotation: 10 },
      { name: "hand", parent: "root", x: 99.8 }
    ],
    ik: [{ name: "arm", bones: ["upper", "lower"], target: "hand", ...ik }],
    skins,
    animations: { idle: { duration: 1, bones: { hand: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 0 }] } } } },
    ...(limits ? { poseLimits: [{ name: "wide", x: "upper", y: "lower", polygon: [[-180, -180], [180, -180], [180, 180], [-180, 180]] }] } : {})
  };
  return doc;
}

function batch(raw: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  checkPoseLimits(loadAnimDocument(raw), issues);
  return issues.filter((i) => /IK samples past/.test(i.message));
}

function live(raw: unknown) {
  const doc = limitDocument(raw);
  return doc ? newViolations(null, doc, ["idle"]).filter((v) => v.limits.some((n) => n.startsWith("ik reach"))) : [];
}

describe("IK reach: live and batch share activation (item 2)", () => {
  it("an IK-only document reaches the live check; an active overextended chain fails both", () => {
    expect(limitDocument(json())).not.toBeNull();
    expect(batch(json())).toHaveLength(1);
    expect(live(json()).length).toBeGreaterThan(0);
  });

  it("an inactive skin-dependent chain produces no violation in either", () => {
    const raw = json({ skin: true });
    expect(batch(raw)).toHaveLength(0);
    expect(live(raw)).toHaveLength(0);
  });

  it("an outfit that activates the skin chain is checked by both", () => {
    const raw = json({ skin: true }, { body: {}, gauntlet: { constraints: ["arm"] } });
    expect(batch(raw)).toHaveLength(1);
    expect(live(raw).length).toBeGreaterThan(0);
  });

  it("offers no driver correction for an IK reach violation (it would not resolve it)", () => {
    const doc = limitDocument(json({}, { body: {} }, true))!;
    const found = newViolations(null, doc, ["idle"]);
    expect(found.length).toBeGreaterThan(0);
    for (const v of found) expect(v.nearest).toBeUndefined();
    const lines = describeViolations(found);
    expect(lines.join("\n")).not.toMatch(/nearest legal pose/);
    expect(lines.join("\n")).toMatch(/ik reach arm/);
  });
});
