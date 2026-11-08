import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { anchorsFor, drivenBones, solveCompensation } from "./compensate.js";
import { ALL_OUTFITS } from "./fixtures.js";

const load = (id: string) => {
  const outfit = ALL_OUTFITS.find((o) => o.id === id)!;
  const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${outfit.document}`, import.meta.url), "utf8")));
  const sk = new Skeleton(doc);
  sk.limitsEnforced = false;
  sk.setToSetupPose();
  sk.updateWorldTransform("reset");
  return sk;
};
const angle = (sk: Skeleton, n: string) => (Math.atan2(sk.findBone(n)!.world.c, sk.findBone(n)!.world.a) * 180) / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

for (const id of ["pro-front", "turned-r"]) {
  const parentName = id === "pro-front" ? "upper_arm_near" : "upper_arm_r";
  describe(`compensate on ${id}`, () => {
    it("never anchors a constraint-driven child (the half-twist helpers)", () => {
      const sk = load(id);
      const driven = drivenBones(sk);
      if (id === "pro-front") expect(driven.size).toBeGreaterThan(0);
      for (const a of anchorsFor(sk, [parentName], new Set())) expect(driven.has(a.name)).toBe(false);
    });

    for (const edit of ["rotate", "move"] as const) {
      it(`keeps the direct children in place when the parent is ${edit === "rotate" ? "rotated" : "moved"}`, () => {
        const sk = load(id);
        const parent = sk.findBone(parentName)!;
        const driven = drivenBones(sk);
        const kids = parent.children.map((c) => c.data.name).filter((n) => !driven.has(n));
        expect(kids.length).toBeGreaterThan(0);
        const before = Object.fromEntries(kids.map((n) => [n, { x: sk.findBone(n)!.world.x, y: sk.findBone(n)!.world.y, a: angle(sk, n) }]));
        const anchors = anchorsFor(sk, [parentName], new Set());
        expect(anchors.map((a) => a.name).sort()).toEqual([...kids].sort());
        if (edit === "rotate") parent.pose.rotation += 33;
        else {
          parent.pose.x += 25;
          parent.pose.y -= 12;
        }
        sk.updateWorldTransform("reset");
        const moved = kids.some((n) => Math.hypot(sk.findBone(n)!.world.x - before[n]!.x, sk.findBone(n)!.world.y - before[n]!.y) > 1);
        expect(moved).toBe(true);
        const fixes = solveCompensation(sk, anchors);
        expect(fixes.length).toBeGreaterThan(0);
        for (const f of fixes) {
          const b = sk.findBone(f.name)!;
          b.pose.rotation = b.data.rotation + f.rotate;
          b.pose.x = b.data.x + f.move.x;
          b.pose.y = b.data.y + f.move.y;
        }
        sk.updateWorldTransform("reset");
        for (const n of kids) {
          const b = sk.findBone(n)!;
          expect(b.world.x).toBeCloseTo(before[n]!.x, 4);
          expect(b.world.y).toBeCloseTo(before[n]!.y, 4);
          expect(wrap(angle(sk, n) - before[n]!.a)).toBeCloseTo(0, 4);
        }
      });
    }

    it("leaves children that are edited too alone, and reports nothing when nothing moved", () => {
      const sk = load(id);
      const parent = sk.findBone(parentName)!;
      const driven = drivenBones(sk);
      const kid = parent.children.find((c) => !driven.has(c.data.name))!.data.name;
      expect(anchorsFor(sk, [parentName], new Set([kid])).map((a) => a.name)).not.toContain(kid);
      expect(solveCompensation(sk, anchorsFor(sk, [parentName], new Set()))).toEqual([]);
    });
  });
}
