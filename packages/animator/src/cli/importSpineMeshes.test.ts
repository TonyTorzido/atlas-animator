import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { main } from "./animator.js";
import { exportSpine } from "./exportSpine.js";
import { convertSpineDeform, convertSpineMesh, importSpineMeshes } from "./importSpineMeshes.js";

const RIG_DIR = resolve(import.meta.dirname, "../../fixtures/test-rigs/player-kit");
const RIGS = ["front-turn00-faceA", "front-turn15-faceA"];
const MESH = { skin: "body", slot: "torso", attachment: "skin" };

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-mesh-import-test-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Raw = { skins: Record<string, { attachments: Record<string, Record<string, Record<string, any>>> }>; animations: Record<string, any> };

describe("convertSpineMesh / convertSpineDeform", () => {
  it("reads an unweighted mesh: y flipped, edges / 2, hull and topology kept", () => {
    const out = convertSpineMesh({ type: "mesh", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [1, -2, 3, -4, 5, -6], hull: 3, edges: [0, 2, 2, 4, 4, 0] }, []);
    expect(out).toEqual({ uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3, vertices: [1, 2, 3, 4, 5, 6], edges: [0, 1, 1, 2, 2, 0] });
  });

  it("reads a weighted mesh: the bone table holds the used bone indices ascending, y flipped", () => {
    const spineBones = ["root", "a", "b", "c"];
    const out = convertSpineMesh({ uvs: [0, 0, 1, 0], triangles: [], hull: 2, vertices: [2, 1, 4, -5, 0.25, 3, 6, -7, 0.75, 1, 3, 8, -9, 1] }, spineBones) as Record<string, unknown>;
    expect(out.bones).toEqual(["a", "c"]);
    expect(out.vertices).toEqual([2, 0, 4, 5, 0.25, 1, 6, 7, 0.75, 1, 1, 8, 9, 1]);
  });

  it("deform: y of every odd float flips, offsets and curves carry over", () => {
    const warnings: string[] = [];
    const keys = convertSpineDeform(
      [
        { time: 0, offset: 1, vertices: [1, 2, 3], curve: [0.25, 0, 0.75, 1] },
        { time: 1, vertices: [4, 5] }
      ],
      6,
      (m) => warnings.push(m),
      "t"
    );
    expect(keys).toEqual([
      { time: 0, offset: 1, vertices: [-1, 2, -3], curve: [0.25, 0, 0.75, 1] },
      { time: 1, vertices: [4, -5] }
    ]);
    expect(convertSpineDeform([{ time: 0, vertices: [1, 2, 3] }], 2, (m) => warnings.push(m), "t")).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe.each(RIGS)("Spine mesh import round trip on %s", (rig) => {
  const original = join(RIG_DIR, `${rig}.anim.json`);

  /** The rig with a deform clip on a weighted mesh and two linked meshes. */
  function prepared(): string {
    const raw = JSON.parse(readFileSync(original, "utf8")) as Raw;
    let state = 7;
    const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 12;
    raw.animations["deformtest"] = {
      duration: 1,
      bones: { pelvis: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 25 }] } },
      deform: {
        [MESH.skin]: {
          [MESH.slot]: {
            [MESH.attachment]: [
              { time: 0, offset: 31, vertices: Array.from({ length: 24 }, next) },
              { time: 0.6, offset: 0, vertices: Array.from({ length: 200 }, next), curve: [0.3, 0.1, 0.7, 0.9] },
              { time: 1, offset: 100, vertices: Array.from({ length: 40 }, next) }
            ]
          }
        }
      }
    };
    const torso = raw.skins["body"]!.attachments["torso"]!;
    const parent = torso["skin"]!;
    const link = (extra: object) => ({ type: "linkedMesh", path: parent.path, source: { ...MESH }, width: parent.width, height: parent.height, ...extra });
    torso["shared"] = link({});
    torso["own"] = link({ inheritDeform: false });
    // Batch 9: a linked mesh in another slot (Spine 4.3 `source` + `slot`) and a linked mesh with its own deform timeline.
    const other = Object.keys(raw.skins["body"]!.attachments).find((s) => s !== MESH.slot)!;
    raw.skins["body"]!.attachments[other]!["cross"] = link({});
    raw.animations["deformtest"].deform[MESH.skin][MESH.slot]["own"] = [
      { time: 0, offset: 0, vertices: Array.from({ length: 30 }, next) },
      { time: 1, offset: 10, vertices: Array.from({ length: 30 }, next) }
    ];
    const path = join(tempDir(), `${rig}.anim.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }

  /** The prepared rig with every weighted mesh replaced by zeros and the linked-mesh flags swapped. */
  function damaged(source: string): string {
    const raw = JSON.parse(readFileSync(source, "utf8")) as Raw;
    for (const bySlot of Object.values(raw.skins)) {
      for (const byAtt of Object.values(bySlot.attachments)) {
        for (const a of Object.values(byAtt)) {
          if (a.type !== "mesh") continue;
          delete a.bones;
          a.vertices = new Array(a.uvs.length).fill(0);
        }
      }
    }
    const torso = raw.skins["body"]!.attachments["torso"]!;
    torso["shared"]!.inheritDeform = false;
    torso["own"]!.inheritDeform = true;
    const other = Object.keys(raw.skins["body"]!.attachments).find((s) => s !== "torso")!;
    raw.skins["body"]!.attachments[other]!["cross"]!.source = { skin: "body", slot: other, attachment: "nowhere" };
    delete raw.animations["deformtest"].deform["body"]["torso"]["own"];
    const path = join(tempDir(), `${rig}.anim.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }

  const exported = () => {
    const source = prepared();
    const result = exportSpine({ document: source, outDir: tempDir(), atlas: join(RIG_DIR, `${rig}.atlas.json`), noAtlas: true });
    return { source, spine: result.json };
  };

  it("restores meshes, weights, linked meshes and deform: world vertices within 1e-3 at 5 frames per clip", () => {
    const { source, spine } = exported();
    const target = damaged(source);
    const result = importSpineMeshes({ spine, merge: target });
    expect(result.meshes.length).toBe(5);
    const other = Object.keys((JSON.parse(readFileSync(source, "utf8")) as Raw).skins["body"]!.attachments).find((s) => s !== "torso")!;
    expect(result.linked.sort()).toEqual([`body/${other}/cross`, "body/torso/own", "body/torso/shared"].sort());
    expect(result.deform).toContain(`clip 'deformtest' body/torso/skin`);
    expect(result.deform).toContain(`clip 'deformtest' body/torso/own`);
    expect(result.warnings.filter((w) => /skipped|dropped/.test(w))).toEqual([]);

    const a = loadAnimDocument(JSON.parse(readFileSync(source, "utf8")), { source });
    const b = loadAnimDocument(JSON.parse(readFileSync(target, "utf8")), { source: target });

    // Weights semantically equal: per vertex the same bone -> (x, y, weight) set, whatever the table and influence order.
    for (const [skin, s] of Object.entries(a.skins)) {
      for (const [slot, byAtt] of Object.entries(s.attachments)) {
        for (const [name, m] of Object.entries(byAtt)) {
          const other = b.skins[skin]!.attachments[slot]![name]!;
          expect(other.type).toBe(m.type);
          if (m.type === "linkedMesh" && other.type === "linkedMesh") {
            expect(other.source).toEqual(m.source);
            expect(other.inheritDeform).toBe(m.inheritDeform);
          }
          if (m.type !== "mesh" || other.type !== "mesh") continue;
          expect(other.hull).toBe(m.hull);
          expect(other.triangles).toEqual(m.triangles);
          expect(other.edges).toEqual(m.edges);
          expect(other.uvs.length).toBe(m.uvs.length);
          other.uvs.forEach((v, i) => expect(Math.abs(v - (m.uvs[i] as number))).toBeLessThan(1e-5));
          const rows = (mesh: typeof m) => {
            if (!mesh.bones) return mesh.vertices.map((v) => [v]);
            const out: Record<string, number[]>[] = [];
            for (let i = 0; i < mesh.vertices.length; ) {
              const n = mesh.vertices[i++] as number;
              const row: Record<string, number[]> = {};
              for (let k = 0; k < n; k++, i += 4) row[mesh.bones[mesh.vertices[i] as number] as string] = [mesh.vertices[i + 1] as number, mesh.vertices[i + 2] as number, mesh.vertices[i + 3] as number];
              out.push(row);
            }
            return out;
          };
          expect(Boolean(other.bones)).toBe(Boolean(m.bones));
          const ra = rows(m);
          const rb = rows(other);
          expect(rb.length).toBe(ra.length);
          ra.forEach((row, v) => {
            if (Array.isArray(row)) {
              row.forEach((x, i) => expect(Math.abs(x - ((rb[v] as number[])[i] as number))).toBeLessThan(1e-5));
              return;
            }
            const got = rb[v] as Record<string, number[]>;
            expect(Object.keys(got).sort()).toEqual(Object.keys(row).sort());
            for (const [bone, vals] of Object.entries(row)) vals.forEach((x, i) => expect(Math.abs(x - (got[bone]![i] as number))).toBeLessThan(1e-5));
          });
        }
      }
    }

    // World vertices of every slot, 5 frames per clip.
    const names = Object.keys(a.animations).filter((n) => n !== "review");
    expect(names).toContain("deformtest");
    let compared = 0;
    for (const clip of names) {
      const sk = [new Skeleton(a), new Skeleton(b)];
      for (const s of sk) s.setActiveSkins(["body"]);
      const states = [new AnimationState(new AnimationStateData(a)), new AnimationState(new AnimationStateData(b))];
      for (const st of states) st.setAnimation(0, clip);
      const duration = a.animations[clip]!.duration;
      let elapsed = 0;
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const to = f * duration;
        const dt = to - elapsed;
        elapsed = to;
        sk.forEach((s, i) => {
          if (dt > 0) {
            states[i]!.update(dt);
            s.update(dt);
          }
          states[i]!.apply(s);
          s.updateWorldTransform();
        });
        for (const slot of a.slots) {
          const va = new Float64Array(2000);
          const vb = new Float64Array(2000);
          const ca = sk[0]!.computeSlotWorldVertices(sk[0]!.getSlot(slot.name), va);
          const cb = sk[1]!.computeSlotWorldVertices(sk[1]!.getSlot(slot.name), vb);
          expect(cb).toBe(ca);
          for (let i = 0; i < ca * 2; i++) expect(Math.abs((va[i] as number) - (vb[i] as number))).toBeLessThan(1e-3);
          compared += ca;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it("backs up the target first and touches nothing else (bones, slots, other clips)", () => {
    const { source, spine } = exported();
    const target = damaged(source);
    const before = JSON.parse(readFileSync(target, "utf8")) as Raw & { bones: unknown; slots: unknown };
    const text = readFileSync(target, "utf8");
    const result = importSpineMeshes({ spine, merge: target });
    expect(result.backup && existsSync(result.backup)).toBe(true);
    expect(readFileSync(result.backup as string, "utf8")).toBe(text);
    const after = JSON.parse(readFileSync(target, "utf8")) as Raw & { bones: unknown; slots: unknown };
    expect(after.bones).toEqual(before.bones);
    expect(after.slots).toEqual(before.slots);
    for (const clip of Object.keys(before.animations)) {
      if (clip === "deformtest") continue;
      expect({ ...after.animations[clip], deform: undefined }).toEqual({ ...before.animations[clip], deform: undefined });
    }
  });

  it("drops stale deform on a changed mesh and honours --dry-run via the CLI", async () => {
    const { source, spine } = exported();
    const target = damaged(source);
    const raw = JSON.parse(readFileSync(target, "utf8")) as Raw;
    raw.animations["walk_in_place"].deform = { body: { arms: {} } };
    // A stale key set on another weighted mesh that the Spine clip does not carry.
    const slotWithMesh = Object.entries(raw.skins["body"]!.attachments).find(([s, byAtt]) => s !== "torso" && Object.values(byAtt).some((a) => a.type === "mesh"));
    expect(slotWithMesh).toBeDefined();
    const [otherSlot, byAtt] = slotWithMesh!;
    const otherName = Object.keys(byAtt).find((n) => byAtt[n]!.type === "mesh")!;
    raw.animations["walk_in_place"].deform = { body: { [otherSlot]: { [otherName]: [{ time: 0, vertices: [1, 2] }] } } };
    writeFileSync(target, JSON.stringify(raw));
    const dry = importSpineMeshes({ spine, merge: target, dryRun: true });
    expect(dry.backup).toBeNull();
    expect(dry.warnings.some((w) => w.includes("old deform keys were dropped"))).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).animations.walk_in_place.deform.body[otherSlot]).toBeDefined();
    const copy = join(tempDir(), "copy.anim.json");
    copyFileSync(target, copy);
    expect(await main(["import-spine", spine, "--merge", copy])).toBe(0);
    const merged = JSON.parse(readFileSync(copy, "utf8")) as Raw;
    expect(merged.animations["walk_in_place"].deform?.body?.[otherSlot]?.[otherName]).toBeUndefined();
    expect(merged.animations["deformtest"].deform.body.torso.skin.length).toBe(3);
  });
});
