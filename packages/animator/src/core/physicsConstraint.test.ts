import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "./format.js";
import { RAD_TO_DEG } from "./math.js";
import { MAX_FRAME_DELTA, MAX_PHYSICS_STEPS } from "./physicsConstraint.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;
type PhysicsInput = NonNullable<Sections["physics"]>[number];
type BoneInput = Sections["bones"][number];

const DT = 1 / 60;
const TAIL = 50;

/** A body bone with a tail (length 50) hanging off it; physics on the tail. */
function rig(physics: Partial<PhysicsInput> = {}, tail: Partial<BoneInput> = {}): Skeleton {
  const skeleton = new Skeleton(
    testDocument({
      bones: [
        { name: "root" },
        { name: "body", parent: "root", y: -100 },
        { name: "tail", parent: "body", rotation: 90, length: TAIL, ...tail }
      ],
      physics: [{ name: "tail", bone: "tail", rotate: 1, inertia: 1, strength: 100, damping: 0.9, ...physics }]
    })
  );
  skeleton.updateWorldTransform();
  return skeleton;
}

function frame(skeleton: Skeleton, dt = DT): void {
  skeleton.update(dt);
  skeleton.updateWorldTransform();
}

const tail = (skeleton: Skeleton) => skeleton.getBone("tail");
const angleOf = (skeleton: Skeleton) => tail(skeleton).worldRotationX;
const constraint = (skeleton: Skeleton) => skeleton.physicsConstraints[0]!;
const snapshot = (skeleton: Skeleton) => skeleton.bones.map((bone) => ({ ...bone.world }));

describe("physics constraint", () => {
  it("a step is due only when the clock moved a fixed step (30 fps simulation, 60 Hz frames; F2 cache gate)", () => {
    // Wind (a hanging bone under gravity alone is at rest and would fall asleep).
    const skeleton = rig({ fps: 30, wind: 400 });
    frame(skeleton); // the reset snap
    const due: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      skeleton.update(DT); // the clock advances; the simulation runs in the world update after
      due.push(skeleton.physicsStepDue);
      skeleton.updateWorldTransform();
    }
    expect(skeleton.physicsSettled).toBe(false);
    // Every other 60 Hz frame has a 30 fps step due (the phase depends on the reset frame).
    expect(due.filter(Boolean)).toHaveLength(3);
    due.slice(1).forEach((d, i) => expect(d).toBe(!due[i]));
  });

  it("a bone at rest with no forces stays exactly at rest", () => {
    const skeleton = rig({ x: 1, y: 1, scaleX: 1, shearX: 1 });
    const rest = snapshot(skeleton);
    for (let i = 0; i < 600; i++) frame(skeleton);
    expect(snapshot(skeleton)).toEqual(rest);
    const c = constraint(skeleton);
    expect([c.offsetX, c.offsetY, c.rotateOffset, c.scaleOffset]).toEqual([0, 0, 0, 0]);
  });

  it("gravity sags translation to gravity / strength (mass changes the speed, not the rest)", () => {
    for (const mass of [1, 3]) {
      const skeleton = rig({ rotate: 0, y: 1, gravity: 500, strength: 100, mass });
      for (let i = 0; i < 1200; i++) frame(skeleton);
      // Asleep within SETTLE_PIXELS (1e-3 px) of the rest.
      expect(constraint(skeleton).offsetY).toBeCloseTo(5, 2);
      expect(tail(skeleton).world.y).toBeCloseTo(-100 + 5, 2);
    }
  });

  it("gravity droops a horizontal bone to the torque balance and leaves a hanging one alone", () => {
    const g = 3000;
    const k = 100;
    const skeleton = rig({ gravity: g, strength: k }, { rotation: 0 });
    for (let i = 0; i < 1200; i++) frame(skeleton);
    // Equilibrium: k * a = g * cos(a) / L (bisection on the analytic balance).
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (k * mid - (g * Math.cos(mid)) / TAIL > 0) hi = mid;
      else lo = mid;
    }
    expect(constraint(skeleton).rotateOffset).toBeCloseTo(lo, 5); // asleep within 1e-3 px at the tip
    expect(angleOf(skeleton)).toBeCloseTo(lo * RAD_TO_DEG, 3); // drooped clockwise (down on the canvas)
    expect(lo * RAD_TO_DEG).toBeGreaterThan(20);

    const hanging = rig({ gravity: g, strength: k });
    for (let i = 0; i < 600; i++) frame(hanging);
    expect(Math.abs(constraint(hanging).rotateOffset)).toBeLessThan(1e-12);
  });

  it("a moving bone trails behind its motion, and the swing decays with damping", () => {
    const run = (damping: number) => {
      const skeleton = rig({ damping });
      const body = skeleton.getBone("body");
      body.pose.x = 10; // one 10 px step to the right, then hold
      frame(skeleton);
      const first = constraint(skeleton).rotateOffset;
      let peakLate = 0;
      for (let i = 1; i < 240; i++) {
        frame(skeleton);
        if (i >= 180) peakLate = Math.max(peakLate, Math.abs(constraint(skeleton).rotateOffset));
      }
      return { first, peakLate };
    };
    const damped = run(0.85);
    // Hanging tail, origin moved right: the tip lags to the left, i.e. the angle grows (clockwise).
    // Input: the angle to where the tip was, (0, 50) seen from 10 px to the right; then one
    // semi-implicit step of the spring from rest velocity: a(1 - k h^2).
    const input = Math.atan2(TAIL, -10) - Math.PI / 2;
    expect(damped.first).toBeCloseTo(input * (1 - 100 * DT * DT), 12);
    expect(damped.first).toBeGreaterThan(0.15);
    expect(damped.peakLate).toBeLessThan(0.01 * damped.first);
    const undamped = run(1);
    expect(undamped.peakLate).toBeGreaterThan(0.5 * undamped.first);
  });

  it("is deterministic: identical frame sequences give bit-identical poses", () => {
    const run = () => {
      const skeleton = rig({ x: 1, y: 1, scaleX: 0.5, shearX: 0.3, gravity: 300, wind: -40 });
      const body = skeleton.getBone("body");
      const dts = [1 / 60, 1 / 30, 1 / 144, 0.05, 1 / 60, 0.2, 1 / 90];
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        body.pose.x = 30 * Math.sin(i * 0.1);
        body.pose.rotation = 10 * Math.cos(i * 0.07);
        frame(skeleton, dts[i % dts.length]);
        const w = tail(skeleton).world;
        out.push(w.a, w.b, w.c, w.d, w.x, w.y);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("steps at a fixed rate: 30 fps and 60 fps frames give the same swing", () => {
    const run = (fps: number) => {
      const skeleton = rig();
      skeleton.getBone("body").pose.x = 8;
      frame(skeleton, 1 / fps);
      for (let i = 1; i < fps; i++) frame(skeleton, 1 / fps); // one second
      return constraint(skeleton).rotateOffset;
    };
    expect(run(30)).toBeCloseTo(run(60), 9);
  });

  it("clamps the frame time: at most 0.25 s per update and at most 4 steps per frame", () => {
    const skeleton = rig();
    skeleton.update(10);
    expect(skeleton.time).toBe(MAX_FRAME_DELTA);
    skeleton.update(-1);
    expect(skeleton.time).toBe(MAX_FRAME_DELTA);

    // A long frame advances the simulation by MAX_PHYSICS_STEPS steps, exactly like that many 60 Hz frames.
    const long = rig();
    const short = rig();
    long.getBone("body").pose.x = 6;
    short.getBone("body").pose.x = 6;
    frame(long, DT);
    frame(short, DT);
    frame(long, 0.25);
    for (let i = 0; i < MAX_PHYSICS_STEPS; i++) frame(short, DT);
    expect(constraint(long).rotateOffset).toBeCloseTo(constraint(short).rotateOffset, 12);
    expect(constraint(long).rotateVelocity).toBeCloseTo(constraint(short).rotateVelocity, 12);
  });

  it("a stalled frame feeds inertia only the motion of the time it simulates (dropped time is a teleport)", () => {
    // Both rigs move the body at the same speed (240 px/s). One stalls for 0.25 s (4 steps
    // simulated, 0.183 s dropped); the other has a 4-step frame. Same simulated time, so the stall
    // must not feed more motion than the capped frame does.
    const run = (dt: number, move: number) => {
      const skeleton = rig({ x: 1, y: 1, limit: 100000 });
      for (let i = 0; i < 5; i++) frame(skeleton);
      skeleton.getBone("body").pose.x = move;
      frame(skeleton, dt);
      const c = constraint(skeleton);
      return { offsetX: c.offsetX, angle: c.rotateOffset };
    };
    const capped = MAX_PHYSICS_STEPS * DT;
    const stalled = run(0.25, 240 * 0.25);
    const equivalent = run(capped, 240 * capped);
    expect(Math.abs(stalled.offsetX)).toBeLessThanOrEqual(Math.abs(equivalent.offsetX) + 1e-9);
    expect(stalled.offsetX).toBeCloseTo(equivalent.offsetX, 9);
    expect(Math.abs(stalled.angle)).toBeLessThanOrEqual(Math.abs(equivalent.angle) + 1e-9);
    expect(stalled.angle).toBeCloseTo(equivalent.angle, 9);
    expect(Math.abs(stalled.angle)).toBeGreaterThan(0.01);
  });

  it("a teleport told through physicsTranslate produces no impulse; an untold one is capped by `limit`", () => {
    const told = rig({ x: 1, y: 1 });
    for (let i = 0; i < 10; i++) frame(told);
    told.x += 500;
    told.y -= 200;
    told.physicsTranslate(500, -200);
    for (let i = 0; i < 60; i++) frame(told);
    const c = constraint(told);
    expect([c.offsetX, c.offsetY, c.rotateOffset]).toEqual([0, 0, 0]);
    expect(tail(told).world.x).toBe(500);

    const untold = rig({ x: 1, y: 1, limit: 600 });
    for (let i = 0; i < 10; i++) frame(untold);
    untold.x += 500;
    frame(untold);
    // The 500 px jump feeds at most limit * dt = 10 px of motion.
    expect(constraint(untold).offsetX).toBeLessThan(0);
    expect(Math.abs(constraint(untold).offsetX)).toBeLessThanOrEqual(600 * DT + 1e-9);
  });

  it("a turn told through physicsRotate produces no impulse", () => {
    const run = (tell: boolean) => {
      const skeleton = rig();
      for (let i = 0; i < 10; i++) frame(skeleton);
      const root = skeleton.getBone("root");
      root.pose.rotation = 90; // the whole rig turns a quarter about the skeleton origin
      if (tell) skeleton.physicsRotate(0, 0, 90);
      frame(skeleton);
      return constraint(skeleton).rotateOffset;
    };
    expect(Math.abs(run(true))).toBeLessThan(1e-12);
    expect(Math.abs(run(false))).toBeGreaterThan(0.2);
  });

  it("resets: a reset key or resetPhysics snaps to the animated pose on the next update", () => {
    const skeleton = rig();
    skeleton.getBone("body").pose.x = 10;
    for (let i = 0; i < 5; i++) frame(skeleton);
    expect(Math.abs(constraint(skeleton).rotateOffset)).toBeGreaterThan(0.05);
    skeleton.physicsPoses[0]!.resetRequested = true;
    frame(skeleton);
    expect(angleOf(skeleton)).toBeCloseTo(90, 12);
    expect(skeleton.physicsPoses[0]!.resetRequested).toBe(false);

    skeleton.getBone("body").pose.x = 30;
    for (let i = 0; i < 5; i++) frame(skeleton);
    skeleton.resetPhysics();
    frame(skeleton);
    expect(angleOf(skeleton)).toBeCloseTo(90, 12);
    // And it simulates again afterwards.
    skeleton.getBone("body").pose.x = 40;
    frame(skeleton);
    expect(Math.abs(constraint(skeleton).rotateOffset)).toBeGreaterThan(0.05);
  });

  it("modes: pose applies the offsets without simulating, none skips physics and snaps back afterwards", () => {
    const skeleton = rig();
    skeleton.getBone("body").pose.x = 10;
    frame(skeleton);
    frame(skeleton);
    const offset = constraint(skeleton).rotateOffset;
    skeleton.update(DT);
    skeleton.updateWorldTransform("pose");
    skeleton.update(DT);
    skeleton.updateWorldTransform("pose");
    expect(constraint(skeleton).rotateOffset).toBe(offset);
    expect(angleOf(skeleton)).toBeCloseTo(90 + offset * RAD_TO_DEG, 9);

    skeleton.update(DT);
    skeleton.updateWorldTransform("none");
    expect(angleOf(skeleton)).toBeCloseTo(90, 12);
    skeleton.getBone("body").pose.x = 200; // moved while physics was off
    frame(skeleton);
    expect(angleOf(skeleton)).toBeCloseTo(90, 12); // snapped, no impulse from the move
  });

  it("mix scales what is shown, not the simulation; mix 0 leaves the pose", () => {
    const full = rig();
    const half = rig({ mix: 0.5 });
    for (const skeleton of [full, half]) {
      skeleton.getBone("body").pose.x = 10;
      for (let i = 0; i < 20; i++) frame(skeleton);
    }
    expect(constraint(half).rotateOffset).toBe(constraint(full).rotateOffset);
    expect(angleOf(half) - 90).toBeCloseTo((angleOf(full) - 90) / 2, 9);

    const off = rig({ mix: 0 });
    off.getBone("body").pose.x = 10;
    for (let i = 0; i < 20; i++) frame(off);
    expect(angleOf(off)).toBeCloseTo(90, 12);
  });

  it("holds the bone's rotation limits (enforceLimits)", () => {
    const skeleton = rig({}, { limits: { min: -5, max: 5 } });
    skeleton.getBone("body").pose.x = 40;
    let widest = 0;
    for (let i = 0; i < 60; i++) {
      frame(skeleton);
      const delta = tail(skeleton).applied.rotation - 90;
      expect(delta).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(delta).toBeLessThanOrEqual(5 + 1e-9);
      widest = Math.max(widest, Math.abs(delta));
    }
    expect(widest).toBeCloseTo(5, 9);
  });

  it("skin-gated: inactive without its skin, and starts from the pose when the skin turns it on", () => {
    const skeleton = new Skeleton(
      testDocument({
        bones: [
          { name: "root" },
          { name: "body", parent: "root" },
          { name: "cape", parent: "body", rotation: 90, length: 40, skin: true }
        ],
        skins: { cape: { attachments: {}, bones: ["cape"], constraints: ["cape"] } },
        physics: [{ name: "cape", bone: "cape", rotate: 1, inertia: 1, strength: 50, skin: true }]
      })
    );
    frame(skeleton);
    expect(skeleton.isConstraintActive("physics", 0)).toBe(false);
    skeleton.setActiveSkins(["cape"]);
    frame(skeleton);
    skeleton.getBone("body").pose.x = 10;
    frame(skeleton);
    expect(skeleton.physicsConstraints[0]!.rotateOffset).toBeGreaterThan(0.1);
    skeleton.setActiveSkins([]);
    skeleton.getBone("body").pose.x = 300;
    frame(skeleton);
    skeleton.setActiveSkins(["cape"]);
    frame(skeleton);
    expect(skeleton.getBone("cape").worldRotationX).toBeCloseTo(90, 12);
  });

  it("a five-bone chain swings while its root moves and settles within 4 s after it stops", () => {
    const bones: BoneInput[] = [{ name: "root" }, { name: "body", parent: "root" }];
    const physics: PhysicsInput[] = [];
    for (let i = 0; i < 5; i++) {
      bones.push({ name: `cape${i}`, parent: i === 0 ? "body" : `cape${i - 1}`, x: i === 0 ? 0 : 24, rotation: i === 0 ? 90 : 0, length: 24 });
      physics.push({ name: `cape${i}`, bone: `cape${i}`, rotate: 1, inertia: 0.6, strength: 120, damping: 0.85, gravity: 400 } as PhysicsInput);
    }
    const skeleton = new Skeleton(testDocument({ bones, physics }));
    skeleton.warmUpPhysics(1);
    const rest = skeleton.bones.map((bone) => bone.worldRotationX);
    const body = skeleton.getBone("body");
    let swing = 0;
    for (let i = 0; i < 60; i++) {
      body.pose.x = 40 * Math.sin((i / 60) * 2 * Math.PI);
      frame(skeleton);
      swing = Math.max(swing, Math.abs(skeleton.getBone("cape4").worldRotationX - (rest[6] as number)));
    }
    body.pose.x = 0;
    expect(swing).toBeGreaterThan(10);
    for (let i = 0; i < 240; i++) frame(skeleton);
    skeleton.bones.forEach((bone, i) => expect(Math.abs(bone.worldRotationX - (rest[i] as number)), bone.data.name).toBeLessThan(0.05));
    for (const c of skeleton.physicsConstraints) expect(Math.abs(c.rotateVelocity)).toBeLessThan(0.01);
  });
});
