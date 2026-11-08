import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { attachmentSchema } from "./format.js";
import { parseAnimDocument } from "./formatLoader.js";
import { pathCurveLengths } from "./pathConstraint.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";
import { AnimationLibrary } from "./timelines.js";

/** Control point = handle in, point, handle out (y up). A straight line from (0,0) to (100,0), handles at thirds. */
const LINE = [-30, 0, 0, 0, 30, 0, 70, 0, 100, 0, 130, 0];
const UP = [0, -30, 0, 0, 0, 30, 0, 70, 0, 100, 0, 130];

function rig(path: Record<string, unknown>, constraint: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return testDocument({
    bones: [
      { name: "root" },
      { name: "b1", parent: "root", length: 20 },
      { name: "b2", parent: "b1", x: 20, length: 20 },
      { name: "b3", parent: "b2", x: 20, length: 20 }
    ],
    slots: [{ name: "track", bone: "root", attachment: "line" }],
    skins: { base: { attachments: { track: { line: { type: "path", vertexCount: 6, vertices: LINE, ...path } } } } },
    path: [{ name: "follow", bones: ["b1", "b2", "b3"], target: "track", positionMode: "fixed", position: 30, ...constraint }],
    ...extra
  } as never);
}

function solved(doc: ReturnType<typeof rig>, time?: { clip: string; at: number }): Skeleton {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["base"]);
  if (time) {
    const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
    state.setAnimation(0, time.clip, { loop: false });
    state.update(time.at);
    state.apply(skeleton);
  }
  skeleton.updateWorldTransform();
  return skeleton;
}

const at = (s: Skeleton, name: string) => s.getBone(name).world;

describe("path attachment schema", () => {
  it("takes 3 vertices per control point and defaults closed false, constant speed true", () => {
    const path = attachmentSchema.parse({ type: "path", vertexCount: 6, vertices: LINE });
    expect(path).toMatchObject({ type: "path", closed: false, constantSpeed: true });
  });
  it("rejects a vertex count that is not whole control points, too few points and a wrong value count", () => {
    expect(() => attachmentSchema.parse({ type: "path", vertexCount: 5, vertices: LINE.slice(0, 10) })).toThrow();
    expect(() => attachmentSchema.parse({ type: "path", vertexCount: 6, vertices: LINE.slice(0, 10) })).toThrow();
    expect(() => attachmentSchema.parse({ type: "path", closed: true, vertexCount: 6, vertices: LINE })).toThrow(/at least 3/);
  });
  it("checks a weighted stream against its bone table", () => {
    const weighted = LINE.length ? Array.from({ length: 6 }, (_, i) => [1, 0, LINE[i * 2], LINE[i * 2 + 1], 1]).flat() : [];
    expect(attachmentSchema.parse({ type: "path", vertexCount: 6, bones: ["root"], vertices: weighted }).type).toBe("path");
    expect(() => attachmentSchema.parse({ type: "path", vertexCount: 6, bones: ["root"], vertices: weighted.slice(0, 20) })).toThrow();
  });
});

describe("path constraint solving", () => {
  it("puts the chain on the path from the position, one bone length apart (fixed position, length spacing)", () => {
    const s = solved(rig({}));
    expect(at(s, "b1").x).toBeCloseTo(30, 2);
    expect(at(s, "b1").y).toBeCloseTo(0, 6);
    expect(at(s, "b2").x).toBeCloseTo(50, 2);
    expect(at(s, "b3").x).toBeCloseTo(70, 2);
    expect(at(s, "b1").a).toBeCloseTo(1, 6);
  });

  it("turns the bones along the tangent of a vertical path", () => {
    const s = solved(rig({ vertices: UP }));
    expect(at(s, "b1").x).toBeCloseTo(0, 6);
    expect(at(s, "b1").y).toBeCloseTo(30, 2);
    expect(at(s, "b1").c).toBeCloseTo(1, 6);
    expect(at(s, "b1").a).toBeCloseTo(0, 6);
    expect(at(s, "b2").y).toBeCloseTo(50, 2);
  });

  it("percent position scales with the path length", () => {
    const s = solved(rig({}, { positionMode: "percent", position: 0.5 }));
    expect(at(s, "b1").x).toBeCloseTo(50, 2);
  });

  it("continues along the end tangent past either end of an open path", () => {
    expect(at(solved(rig({}, { position: 110 })), "b1").x).toBeCloseTo(110, 2);
    expect(at(solved(rig({}, { position: -15 })), "b1").x).toBeCloseTo(-15, 2);
  });

  it("wraps on a closed path", () => {
    const square = [-10, 0, 0, 0, 10, 0, 90, 0, 100, 0, 110, 0, 100, 90, 100, 100, 100, 110, 10, 100, 0, 100, -10, 100];
    const closed = { closed: true, vertexCount: 12, vertices: square };
    const length = pathCurveLengths(square.slice(), true, 12).reduce((a, b) => a + b, 0);
    expect(length).toBeGreaterThan(300);
    const a = at(solved(rig(closed, { position: 25 })), "b1");
    const b = at(solved(rig(closed, { position: 25 + length })), "b1");
    expect(b.x).toBeCloseTo(a.x, 3);
    expect(b.y).toBeCloseTo(a.y, 3);
  });

  it("constant speed spaces bones evenly even when the handles bunch the parameter", () => {
    const bunched = [0, 0, 0, 0, 90, 0, 10, 0, 100, 0, 100, 0];
    const even = at(solved(rig({ vertices: bunched, constantSpeed: true }, { position: 10, spacingMode: "fixed", spacing: 20 })), "b2");
    const parameter = at(solved(rig({ vertices: bunched, constantSpeed: false }, { position: 10, spacingMode: "fixed", spacing: 20 })), "b2");
    expect(even.x).not.toBeCloseTo(parameter.x, 1);
    expect(Math.abs(at(solved(rig({ vertices: bunched }, { position: 10, spacingMode: "fixed", spacing: 20 })), "b1").x - 10)).toBeLessThan(0.3);
    expect(Math.abs(even.x - 30)).toBeLessThan(0.3);
  });

  it("chain mode aims each bone at the next; chain scale stretches it to reach", () => {
    const bent = [0, 0, 0, 0, 0, 0, 0, 40, 60, 40, 60, 40];
    const doc = (rotateMode: string) => rig({ vertices: [-5, 0, 0, 0, 5, 0, 55, 40, 60, 40, 65, 40] }, { rotateMode, position: 0, spacingMode: "fixed", spacing: 30 });
    void bent;
    const chain = solved(doc("chain"));
    const scale = solved(doc("chainScale"));
    expect(Math.hypot(at(chain, "b1").a, at(chain, "b1").c)).toBeCloseTo(1, 6);
    const reach = Math.hypot(at(scale, "b2").x - at(scale, "b1").x, at(scale, "b2").y - at(scale, "b1").y);
    expect(Math.hypot(at(scale, "b1").a, at(scale, "b1").c)).toBeCloseTo(reach / 20, 3);
  });

  it("mix 0 changes nothing and a half mix moves halfway", () => {
    const free = new Skeleton(rig({}, { mixRotate: 0, mixX: 0, mixY: 0 }));
    free.setActiveSkins(["base"]);
    free.updateWorldTransform();
    expect(at(free, "b1").x).toBe(0);
    const half = solved(rig({}, { mixX: 0.5, mixY: 0.5, mixRotate: 0 }));
    expect(at(half, "b1").x).toBeCloseTo(15, 1);
  });

  it("does nothing when the slot shows no path", () => {
    const s = solved(rig({}, {}, { animations: { hide: { duration: 1, slots: { track: { attachment: [{ time: 0, name: null }] } } } } }), { clip: "hide", at: 0.5 });
    expect(at(s, "b1").x).toBe(0);
  });

  it("a weighted path follows its bone", () => {
    const stream: number[] = [];
    for (let i = 0; i < 6; i++) stream.push(1, 0, LINE[i * 2] as number, LINE[i * 2 + 1] as number, 1);
    const doc = testDocument({
      bones: [{ name: "root" }, { name: "rail", parent: "root", y: 50 }, { name: "b1", parent: "root", length: 20 }],
      slots: [{ name: "track", bone: "root", attachment: "line" }],
      skins: { base: { attachments: { track: { line: { type: "path", vertexCount: 6, bones: ["rail"], vertices: stream } } } } },
      path: [{ name: "follow", bones: ["b1"], target: "track", positionMode: "fixed", position: 30 }],
      animations: { lift: { duration: 1, bones: { rail: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 100 }] } } } }
    } as never);
    expect(at(solved(doc as never), "b1").y).toBeCloseTo(50, 3);
    expect(at(solved(doc as never, { clip: "lift", at: 1 }), "b1").y).toBeCloseTo(150, 3);
  });

  it("runs after the bones it reads: a path riding a moving parent is current", () => {
    const doc = testDocument({
      bones: [{ name: "root" }, { name: "rail", parent: "root", y: 10 }, { name: "b1", parent: "root", length: 20 }],
      slots: [{ name: "track", bone: "rail", attachment: "line" }],
      skins: { base: { attachments: { track: { line: { type: "path", vertexCount: 6, vertices: LINE } } } } },
      path: [{ name: "follow", bones: ["b1"], target: "track", positionMode: "fixed", position: 30 }],
      animations: { lift: { duration: 1, bones: { rail: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 80 }] } } } }
    } as never);
    expect(at(solved(doc as never, { clip: "lift", at: 1 }), "b1").y).toBeCloseTo(90, 3);
  });
});

describe("path constraint timelines", () => {
  const animations = {
    sweep: {
      duration: 1,
      path: {
        follow: [
          { time: 0, position: 0, mixRotate: 1 },
          { time: 1, position: 60, mixRotate: 0 }
        ]
      }
    }
  };

  it("keys position and mix", () => {
    const doc = rig({}, {}, { animations });
    const s = solved(doc, { clip: "sweep", at: 0.5 });
    expect(s.pathPoses[0]?.position).toBeCloseTo(30, 6);
    expect(s.pathPoses[0]?.mixRotate).toBeCloseTo(0.5, 6);
    expect(at(s, "b1").x).toBeCloseTo(30, 1);
    expect(at(solved(doc, { clip: "sweep", at: 1 }), "b1").x).toBeCloseTo(60, 1);
  });

  it("setup pose restores the document values", () => {
    const doc = rig({}, {}, { animations });
    const s = solved(doc, { clip: "sweep", at: 1 });
    s.setToSetupPose();
    expect(s.pathPoses[0]?.position).toBe(30);
  });
});

describe("path references", () => {
  const issues = (doc: Record<string, unknown>) => {
    const result = parseAnimDocument({ format: "atlas-anim@1", name: "t", canvas: { width: 100, height: 100, originX: 0, originY: 0 }, ...doc });
    return result.ok ? result.warnings : result.issues;
  };
  it("reports an unknown slot, an unknown bone and a duplicate constraint name", () => {
    const base = { bones: [{ name: "root" }, { name: "b1", parent: "root" }], slots: [{ name: "s", bone: "root" }] };
    expect(issues({ ...base, path: [{ name: "p", bones: ["b1"], target: "nope" }] }).some((i) => i.message.includes("unknown slot"))).toBe(true);
    expect(issues({ ...base, path: [{ name: "p", bones: ["ghost"], target: "s" }] }).some((i) => i.message.includes("unknown bone"))).toBe(true);
    expect(issues({ ...base, ik: [], transform: [{ name: "p", bones: ["b1"], target: "root" }], path: [{ name: "p", bones: ["b1"], target: "s" }] }).some((i) => i.message.includes("duplicate constraint"))).toBe(true);
  });
  it("warns when the target slot has no path attachment, and rejects a path on a constrained bone", () => {
    const base = { bones: [{ name: "root" }, { name: "b1", parent: "root" }], slots: [{ name: "s", bone: "b1" }] };
    const found = issues({ ...base, path: [{ name: "p", bones: ["b1"], target: "s" }] });
    expect(found.some((i) => i.severity === "warning" && i.message.includes("no path attachment"))).toBe(true);
    expect(found.some((i) => i.severity === "error" && i.message.includes("move after being read"))).toBe(true);
  });
});
