import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { createImage } from "../tools/image.js";
import { writePng } from "../tools/png.js";
import { main } from "./animator.js";
import { exportSpine } from "./exportSpine.js";
import { importSpineClips } from "./importSpine.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = join(__dirname, "..", "..", "fixtures", "rigs", "three-part.anim.json");

/** The varied test clip: bezier / stepped / linear, mixed per-axis curves, a weapon that rotates and moves, IK mix + bend, events. */
const TEST_CLIP = {
  duration: 1,
  loop: false,
  bones: {
    hips: {
      rotate: [
        { time: 0, value: -6, curve: [0.42, 0, 0.58, 1] },
        { time: 0.4, value: 12, curve: "stepped" },
        { time: 0.7, value: -3, curve: [0.1, 1.4, 0.7, 0.9] },
        { time: 1, value: 5 }
      ]
    },
    head: {
      translate: [
        { time: 0, x: 0, y: 0, curve: { x: "stepped", y: [0.3, 0, 0.6, 1] } },
        { time: 0.5, x: 6, y: -4 },
        { time: 1, x: 2, y: 3 }
      ],
      shear: [
        { time: 0, x: 0, y: 0 },
        { time: 1, x: 8, y: -5 }
      ]
    },
    chest: {
      scale: [
        { time: 0, x: 1, y: 1, curve: [0.25, 0.1, 0.75, 0.9] },
        { time: 0.6, x: 1.2, y: 0.9 },
        { time: 1, x: 1, y: 1 }
      ]
    },
    target: {
      translate: [
        { time: 0, x: 0, y: 0, curve: [0.4, 0, 0.6, 1] },
        { time: 0.5, x: -30, y: 25, curve: "linear" },
        { time: 1, x: 10, y: 10 }
      ]
    },
    weapon: {
      rotate: [
        { time: 0, value: 0, curve: [0.42, 0, 0.58, 1] },
        { time: 0.45, value: 70 },
        { time: 1, value: -25 }
      ],
      translate: [
        { time: 0, x: 0, y: 0 },
        { time: 1, x: 5, y: -7 }
      ]
    }
  },
  ik: {
    arm_ik: [
      { time: 0, mix: 1, bendPositive: true, curve: [0.3, 0, 0.7, 1] },
      { time: 0.5, mix: 0.4, softness: 3, bendPositive: false, curve: "stepped" },
      { time: 0.8, mix: 0.9, bendPositive: false },
      { time: 1, mix: 1, bendPositive: true }
    ]
  },
  events: [
    { time: 0.3, name: "hit", int: 5 },
    { time: 0.6, name: "step", string: "left", float: 1.5 }
  ]
};

/** three-part plus a weapon (with a grip the exporter can find), an IK arm and a target, a page PNG, and the clip. */
function workspace(withClip = true) {
  const dir = mkdtempSync(join(tmpdir(), "animator-spine-import-"));
  dirs.push(dir);
  const rig = join(dir, "rig");
  mkdirSync(rig);
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, any>;
  raw.name = "rig";
  raw.bones.push(
    { name: "weapon", parent: "head", x: 12, y: 4, rotation: 25, length: 50 },
    { name: "weapon_tip", parent: "weapon", x: 60, y: 0 },
    { name: "arm_a", parent: "chest", x: 20, y: 10, length: 40 },
    { name: "arm_b", parent: "arm_a", x: 40, length: 40 },
    { name: "target", parent: "root", x: 70, y: -60 }
  );
  raw.slots.push({ name: "weapon", bone: "weapon", attachment: "weapon" });
  raw.skins.body.attachments.weapon = { weapon: { type: "region", path: "body/weapon", x: 30, y: 0, rotation: 90, width: 120, height: 60 } };
  raw.ik = [{ name: "arm_ik", bones: ["arm_a", "arm_b"], target: "target", bendPositive: true, mix: 1 }];
  raw.animations = {
    ...raw.animations,
    ...(withClip ? { test: TEST_CLIP } : {})
  };
  writeFileSync(join(rig, "rig.anim.json"), JSON.stringify(raw, null, 1));

  // Page: coloured blocks; the weapon image is a haft (8 px wide) with a dark leather wrap.
  const page = createImage(256, 320);
  const regions: Record<string, { x: number; y: number; width: number; height: number }> = {
    "body/base": { x: 0, y: 0, width: 120, height: 40 },
    "body/torso": { x: 128, y: 0, width: 60, height: 120 },
    "body/head": { x: 192, y: 0, width: 50, height: 50 },
    "swag/tunic/torso": { x: 0, y: 48, width: 60, height: 120 },
    "body/weapon": { x: 64, y: 176, width: 60, height: 120 }
  };
  for (const [path, r] of Object.entries(regions)) {
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        let rgba: number[] = [180, 120, 80, 255];
        if (path === "body/weapon") {
          const haft = x >= 26 && x < 34;
          rgba = haft ? (y >= 40 && y < 72 ? [40, 30, 20, 255] : [200, 190, 170, 255]) : [0, 0, 0, 0];
        }
        page.data.set(rgba, ((r.y + y) * 256 + r.x + x) * 4);
      }
    }
  }
  writePng(join(rig, "rig.atlas.png"), page);
  writeFileSync(join(rig, "rig.atlas.json"), JSON.stringify({ format: "atlas-pack@1", scale: 1, pages: [{ file: "rig.atlas.png", width: 256, height: 320, regions }] }));
  return { dir, rig, doc: join(rig, "rig.anim.json") };
}

function sampleWorlds(docPath: string, clip: string): number[][] {
  const doc = loadAnimDocument(JSON.parse(readFileSync(docPath, "utf8")), { source: docPath });
  const c = doc.animations[clip];
  if (!c) throw new Error(`no clip ${clip}`);
  const fps = c.fps ?? 30;
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(Object.keys(doc.skins).slice(0, 1));
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, clip);
  const out: number[][] = [];
  const steps = Math.round(c.duration * fps);
  for (let k = 0; k <= steps; k++) {
    if (k > 0) {
      state.update(1 / fps);
      skeleton.update(1 / fps);
    }
    state.apply(skeleton);
    skeleton.updateWorldTransform();
    out.push(skeleton.bones.flatMap((b) => [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y]));
  }
  return out;
}

describe("import-spine-clips", () => {
  it("round-trips a varied clip through export-spine: bone world transforms match at every frame", () => {
    const { dir, doc } = workspace(true);
    const exportDir = join(dir, "spine");
    const exported = exportSpine({ document: doc, outDir: exportDir, clips: ["test"], noAtlas: true });
    expect(exported.warnings.join("\n")).not.toMatch(/events are not exported/);
    const spineJson = JSON.parse(readFileSync(exported.json, "utf8"));
    expect(spineJson.events).toBeTruthy();
    expect(spineJson.animations.test.events).toHaveLength(2);

    // Import into a rig that has no 'test' clip, then compare with the original document.
    const target = workspace(false);
    const result = importSpineClips({ spine: exported.json, rig: target.rig, clips: ["test"] });
    expect(result.clips[0]).toMatchObject({ name: "test", replaced: false, duration: 1, ik: 1, events: 2 });
    expect(result.backup && existsSync(result.backup)).toBe(true);

    const before = sampleWorlds(doc, "test");
    const after = sampleWorlds(target.doc, "test");
    expect(after).toHaveLength(before.length);
    const doc0 = loadAnimDocument(JSON.parse(readFileSync(doc, "utf8")), { source: doc });
    const names = doc0.bones.map((b) => b.name);
    const weapon = names.indexOf("weapon");
    const spineBones = spineJson.bones as any[];
    const spineWeapon = spineBones.find((b) => b.name === "weapon");
    const rigWeapon = doc0.bones[weapon]!;
    const rad = (rigWeapon.rotation * Math.PI) / 180;
    const dx = (spineWeapon.x ?? 0) - rigWeapon.x;
    const dy = -(spineWeapon.y ?? 0) - rigWeapon.y;
    const grip = { x: Math.cos(rad) * dx + Math.sin(rad) * dy, y: -Math.sin(rad) * dx + Math.cos(rad) * dy };
    expect(Math.hypot(grip.x, grip.y)).toBeGreaterThan(1);
    // The exporter baked per-frame translate keys for the rotating weapon.
    expect(spineJson.animations.test.bones.weapon.translate.length).toBeGreaterThan(30);

    // 1. editor -> Spine -> editor: every bone, the weapon's own origin included, matches at every frame.
    let worst = 0;
    before.forEach((frame, k) => frame.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - ((after[k] as number[])[i] as number))))));
    expect(worst).toBeLessThan(2e-3);

    // 2. the exported Spine pose vs this runtime's pose. A rig with the Spine setup (weapon on the grip, its children compensated)
    // plus the exported clip imported without any grip correction plays the Spine data as Spine would; a point p of the weapon
    // is at W(t) * p in the runtime and at W2(t) * (p - grip) in Spine.
    const spineRigRaw = JSON.parse(readFileSync(doc, "utf8"));
    for (const b of spineRigRaw.bones) {
      const sb = spineBones.find((x) => x.name === b.name);
      if (sb && (b.name === "weapon" || b.parent === "weapon")) {
        b.x = sb.x ?? 0;
        b.y = -(sb.y ?? 0);
      }
    }
    delete spineRigRaw.animations.test;
    const spineRig = workspace(false);
    writeFileSync(spineRig.doc, JSON.stringify(spineRigRaw, null, 1));
    importSpineClips({ spine: exported.json, rig: spineRig.rig, clips: ["test"] });
    const spinePose = sampleWorlds(spineRig.doc, "test");
    let worstSpine = 0;
    before.forEach((frame, k) => {
      const sp = spinePose[k] as number[];
      const at = (arr: number[], b: number) => arr.slice(b * 6, b * 6 + 6) as [number, number, number, number, number, number];
      names.forEach((_, b) => {
        if (b === weapon) return;
        at(frame, b).forEach((v, i) => (worstSpine = Math.max(worstSpine, Math.abs(v - (at(sp, b)[i] as number)))));
      });
      for (const [px, py] of [[0, 0], [40, 10], [-15, 30], [grip.x, grip.y]] as const) {
        const [a, b, c, d, x, y] = at(frame, weapon);
        const [a2, b2, c2, d2, x2, y2] = at(sp, weapon);
        worstSpine = Math.max(worstSpine, Math.abs(a * px + b * py + x - (a2 * (px - grip.x) + b2 * (py - grip.y) + x2)), Math.abs(c * px + d * py + y - (c2 * (px - grip.x) + d2 * (py - grip.y) + y2)));
      }
    });
    expect(worstSpine).toBeLessThan(2e-3);
    expect(worst).toBeLessThan(2e-3);

    const imported = JSON.parse(readFileSync(target.doc, "utf8"));
    expect(imported.animations.test.events).toEqual(TEST_CLIP.events);
    expect(imported.animations.test.ik.arm_ik.map((k: any) => [k.time, k.bendPositive])).toEqual([
      [0, true],
      [0.5, false],
      [0.8, false],
      [1, true]
    ]);
    expect(imported.animations.test.ik.arm_ik[1].curve).toBe("stepped");
    // The weapon pivots about the grip in Spine: the importer said it baked translate keys.
    expect(result.warnings.join("\n")).toMatch(/weapon rotation pivots about the grip/);
  });

  it("never touches the setup pose, bones, slots or skins, and keeps an existing clip's slots, loop and fps", () => {
    const { dir, doc } = workspace(true);
    const exported = exportSpine({ document: doc, outDir: join(dir, "spine"), clips: ["test"], noAtlas: true });
    const target = workspace(true);
    const original = JSON.parse(readFileSync(target.doc, "utf8"));
    // Give the existing clip a slot key, a loop flag and an fps; the Spine data replaces its bones only.
    original.animations.test = { ...original.animations.test, loop: true, fps: 24, slots: { head: { attachment: [{ time: 0, name: "head" }] } } };
    writeFileSync(target.doc, JSON.stringify(original, null, 1));
    const dry = importSpineClips({ spine: exported.json, rig: target.rig, dryRun: true });
    expect(dry.backup).toBeNull();
    expect(readFileSync(target.doc, "utf8")).toBe(JSON.stringify(original, null, 1));
    const result = importSpineClips({ spine: exported.json, rig: target.rig, clips: ["test"] });
    expect(result.clips[0]?.replaced).toBe(true);
    const after = JSON.parse(readFileSync(target.doc, "utf8"));
    for (const key of ["bones", "slots", "skins", "ik", "canvas", "events"]) expect(after[key]).toEqual(original[key]);
    expect(after.animations.test.loop).toBe(true);
    expect(after.animations.test.fps).toBe(24);
    expect(after.animations.test.slots).toEqual(original.animations.test.slots);
    expect(after.animations.idle).toEqual(original.animations.idle);
  });

  it("imports a hand-made Spine 4.3 file: stepped curve, per-axis timelines, IK mix key, events, dropped slot timelines", () => {
    const { dir, rig, doc } = workspace(false);
    const spine = {
      skeleton: { spine: "4.3.26" },
      bones: [{ name: "root" }],
      events: { hit: { int: 1 }, footstep: { audio: "step.ogg" } },
      animations: {
        hand: {
          bones: {
            hips: {
              rotate: [{ time: 0, value: 10, curve: "stepped" }, { time: 0.5, value: -20 }, { time: 1, value: 0 }],
              translatex: [{ time: 0, value: 0 }, { time: 1, value: 10 }]
            },
            head: { translate: [{ time: 0, x: 0, y: 0, curve: [0.2, 0, 0.8, 10, 0.2, 0, 0.8, 5] }, { time: 1, x: 10, y: 5 }] },
            ghost: { rotate: [{ time: 0, value: 1 }] }
          },
          ik: {
            arm_ik: [{ time: 0, bendPositive: false }, { time: 0.5, mix: 0.25, softness: 2, curve: "stepped" }, { time: 1 }]
          },
          slots: { head: { attachment: [{ time: 0, name: "head" }] } },
          drawOrder: [{ time: 0.2, offsets: [{ slot: "head", offset: 1 }] }],
          events: [{ time: 0.25, name: "hit" }, { time: 0.5, name: "footstep" }]
        }
      }
    };
    const spinePath = join(dir, "hand.json");
    writeFileSync(spinePath, JSON.stringify(spine));
    const result = importSpineClips({ spine: spinePath, rig, loop: ["hand"] });
    const text = result.warnings.join("\n");
    expect(text).toMatch(/bone 'ghost' is not in the rig/);
    expect(text).toMatch(/1 slot timeline\(s\) and 1 draw-order key\(s\) dropped/);

    const clip = JSON.parse(readFileSync(doc, "utf8")).animations.hand;
    expect(clip.loop).toBe(true);
    expect(clip.duration).toBe(1);
    expect(clip.bones.hips.rotate).toEqual([{ time: 0, value: -10, curve: "stepped" }, { time: 0.5, value: 20 }, { time: 1, value: 0 }]);
    expect(clip.bones.hips.translate).toEqual([{ time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 0 }]);
    expect(clip.bones.head.translate).toEqual([{ time: 0, x: 0, y: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, x: 10, y: -5 }]);
    expect(clip.ik.arm_ik).toEqual([
      { time: 0, mix: 1, softness: 0, bendPositive: true, stretch: false, compress: false },
      { time: 0.5, mix: 0.25, softness: 2, bendPositive: false, stretch: false, compress: false, curve: "stepped" },
      { time: 1, mix: 1, softness: 0, bendPositive: false, stretch: false, compress: false }
    ]);
    expect(clip.events).toEqual([{ time: 0.25, name: "hit" }, { time: 0.5, name: "footstep" }]);
    expect(JSON.parse(readFileSync(doc, "utf8")).events.footstep.audio).toBe("step.ogg");
    expect(clip.slots).toBeUndefined();
    expect(clip.drawOrder).toBeUndefined();
  });

  it("is registered as a CLI command", async () => {
    const { dir, rig, doc } = workspace(false);
    const spinePath = join(dir, "s.json");
    writeFileSync(spinePath, JSON.stringify({ skeleton: { spine: "4.3.26" }, animations: { a: { bones: { hips: { rotate: [{ time: 0, value: 1 }, { time: 0.5, value: 2 }] } } } } }));
    const write = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await main(["import-spine-clips", spinePath, "--rig", rig, "--dry-run"])).toBe(0);
      expect(JSON.parse(readFileSync(doc, "utf8")).animations.a).toBeUndefined();
      expect(await main(["import-spine-clips", spinePath, "--rig", rig])).toBe(0);
      expect(JSON.parse(readFileSync(doc, "utf8")).animations.a.duration).toBe(0.5);
      expect(await main(["import-spine-clips"])).toBe(2);
    } finally {
      process.stdout.write = write;
      process.stderr.write = err;
    }
  });
});

