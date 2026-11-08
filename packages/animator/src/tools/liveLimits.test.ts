import { describe, expect, it } from "vitest";
import { applyCommands, CommandError, type Command } from "./commands.js";
import { nearestLegalPose, outsideDistance, projectToConvex } from "./liveLimits.js";

// A two-driver arm: raise x elbow limited by a polygon that cuts the high-raise, bent-elbow corner.
const POLYGON: [number, number][] = [[-15, 0], [105, 0], [105, 10], [85, 40], [60, 70], [-15, 70]];

function rig() {
  return applyCommands({}, [
    { op: "doc.new", name: "arm", width: 100, height: 100 },
    { op: "bone.add", name: "upper", parent: "root", length: 20, limits: { min: -15, max: 105 } },
    { op: "bone.add", name: "fore", parent: "upper", x: 20, length: 20, limits: { min: 0, max: 70 } },
    { op: "patch", patch: [{ op: "add", path: "/poseLimits", value: [{ name: "hand_head", x: "upper", y: "fore", polygon: POLYGON }] }] },
    { op: "clip.add", name: "swing", duration: 1 }
  ]).doc;
}

const key = (bone: string, time: number, value: number): Command => ({ op: "key.set", clip: "swing", bone, timeline: "rotate", time, value });
const swing: Command[] = [key("upper", 0, 0), key("upper", 0.5, 97), key("upper", 1, 0), key("fore", 0, 0), key("fore", 0.5, 60), key("fore", 1, 0)];

describe("live pose limits ()", () => {
  it("projects onto the polygon", () => {
    expect(outsideDistance(POLYGON, [0, 0])).toBeLessThanOrEqual(0);
    expect(outsideDistance(POLYGON, [97, 60])).toBeGreaterThan(0);
    const q = projectToConvex(POLYGON, [97, 60]);
    expect(outsideDistance(POLYGON, q)).toBeLessThan(1e-9);
    const pose = nearestLegalPose([{ name: "l", x: "upper", y: "fore", polygon: POLYGON }], { upper: 97, fore: 60 });
    expect(outsideDistance(POLYGON, [pose["upper"] ?? 0, pose["fore"] ?? 0])).toBeLessThan(0);
  });

  it("rejects the key that leaves the limits, naming it and the nearest legal pose", () => {
    let error: unknown;
    try {
      applyCommands(rig(), swing, { limits: "reject" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).index).toBe(4);
    expect((error as Error).message).toMatch(/key\.set fore rotate t 0\.5s/);
    expect((error as Error).message).toMatch(/the keyed pose and \d+ in-between poses outside pose limit 'hand_head'/);
    expect((error as Error).message).toMatch(/nearest legal pose: upper \d+\.\d, fore \d+\.\d/);
  });

  it("warns and applies under warn; off and legal clips stay quiet", () => {
    const warned = applyCommands(rig(), swing, { limits: "warn" });
    expect(warned.limitWarnings.length).toBe(1);
    expect(warned.limitWarnings[0]).toMatch(/^command 5 \(key\.set fore rotate t 0\.5s\).*'hand_head'/);
    expect(applyCommands(rig(), swing).limitWarnings).toEqual([]);
    const legal = swing.map((c) => (c["time"] === 0.5 ? { ...c, value: c["bone"] === "upper" ? 85 : 30 } : c));
    expect(applyCommands(rig(), legal, { limits: "reject" }).limitWarnings).toEqual([]);
  });

  it("an in-between alone is caught (both keys legal, the curved path is not)", () => {
    // (60, 60) -> (100, 0) is a legal straight line, but the raise eases out fast while the elbow is
    // linear, so mid-way the raise is already high with the elbow still bent.
    const doc = applyCommands(rig(), [key("fore", 0, 60), key("fore", 1, 0), { ...key("upper", 0, 60), curve: [0, 1, 0, 1] }], { limits: "reject" }).doc;
    expect(() => applyCommands(doc, [key("upper", 1, 100)], { limits: "reject" })).toThrow(/: \d+ in-between poses? outside pose limit 'hand_head' \(first t /);
  });

  it("--check end checks once at the end and blames the batch", () => {
    expect(() => applyCommands(rig(), swing, { check: "end", limits: "reject" })).toThrow(/rejected at the end/);
    const warned = applyCommands(rig(), swing, { check: "end", limits: "warn" });
    expect(warned.limitWarnings.join("\n")).toMatch(/^end of batch: clip 'swing': the keyed pose/);
  });
});
