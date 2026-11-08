import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { arrowTarget, ALL_FILTERS, buildRows, boneColor, flagsOf, INHERIT_FLAGS, inheritToggle, modeFor, SelectionHistory, stepRow, toggledFor, planSplitBone, planChildBone } from "./outlinerModel.js";
import { runBatch, setupSkeleton, type JsonObject } from "./setupModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const raw = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const load = () => {
  const parsed = parseAnimDocument(raw());
  if (!parsed.ok) throw new Error("rig did not parse");
  return parsed.document;
};
const opts = { filters: ALL_FILTERS, toggled: new Set<string>(), search: "" };

describe("rows", () => {
  it("lists bones in hierarchy order with slots under their bone and bones open, slots closed by default", () => {
    const d = load();
    const rows = buildRows(d, opts);
    expect(rows[0]!.kind).toBe("bone");
    expect(rows[0]!.depth).toBe(0);
    const slotRow = rows.find((r) => r.kind === "slot");
    expect(slotRow).toBeTruthy();
    expect(slotRow!.open).toBe(false);
    expect(rows.some((r) => r.kind === "attachment")).toBe(false);
    // a slot sits directly under its bone's depth + 1
    const owner = rows.find((r) => r.kind === "bone" && r.name === slotRow!.bone)!;
    expect(slotRow!.depth).toBe(owner.depth + 1);
  });

  it("opens a slot to show its attachments, and a search forces matches open and keeps their ancestors", () => {
    const d = load();
    const s = d.slots.find((x) => Object.values(d.skins).some((k) => Object.keys(k.attachments[x.name] ?? {}).length))!;
    const opened = buildRows(d, { ...opts, toggled: new Set([`s:${s.name}`]) });
    expect(opened.some((r) => r.kind === "attachment" && r.slot === s.name)).toBe(true);
    const found = buildRows(d, { ...opts, search: s.name });
    expect(found.some((r) => r.id === `s:${s.name}`)).toBe(true);
    expect(found.some((r) => r.id === `b:${s.bone}`)).toBe(true);
    expect(found.length).toBeLessThan(buildRows(d, opts).length);
  });

  it("drops a kind when its filter is off", () => {
    const d = load();
    expect(buildRows(d, { ...opts, filters: { ...ALL_FILTERS, slots: false } }).some((r) => r.kind === "slot")).toBe(false);
    expect(buildRows(d, { ...opts, filters: { ...ALL_FILTERS, bones: false } }).some((r) => r.kind === "bone")).toBe(false);
    expect(buildRows(d, { ...opts, filters: { ...ALL_FILTERS, constraints: false } }).some((r) => r.kind === "constraint" || r.id === "g:constraints")).toBe(false);
  });

  it("adds counted Skins and Draw order sections, closed until opened", () => {
    const d = load();
    const closed = buildRows(d, opts);
    const skins = closed.find((r) => r.id === "g:skins")!;
    const draw = closed.find((r) => r.id === "g:draw")!;
    expect(skins.badges[0]).toBe(String(Object.keys(d.skins).length));
    expect(draw.badges[0]).toBe(String(d.slots.length));
    expect(closed.some((r) => r.kind === "skin" || r.kind === "draw")).toBe(false);
    const open = buildRows(d, { ...opts, toggled: new Set(["g:skins", "g:draw"]) });
    expect(open.filter((r) => r.kind === "draw").length).toBe(d.slots.length);
    expect(open.filter((r) => r.kind === "skin").length).toBe(Object.keys(d.skins).length);
  });

  it("badges IK chains and lists constraints in a group", () => {
    const d = load();
    const rows = buildRows(d, opts);
    if (d.ik.length) {
      expect(rows.find((r) => r.id === `b:${d.ik[0]!.bones[0]}`)!.badges).toContain("IK");
      expect(rows.some((r) => r.kind === "constraint" && r.name === d.ik[0]!.name)).toBe(true);
    }
  });

  it("expand all / collapse all produce toggles against the defaults", () => {
    const d = load();
    const all = buildRows(d, { ...opts, toggled: new Set(toggledFor(d, true)) });
    expect(all.some((r) => r.kind === "attachment")).toBe(true);
    const none = buildRows(d, { ...opts, toggled: new Set(toggledFor(d, false)) });
    expect(none.filter((r) => r.kind === "bone").length).toBe(1);
  });
});

describe("keyboard model", () => {
  it("steps up and down, clamped, and left/right collapse, expand or move", () => {
    const rows = buildRows(load(), opts);
    expect(stepRow(rows, rows[0]!.id, -1)).toBe(rows[0]!.id);
    expect(stepRow(rows, rows[0]!.id, 1)).toBe(rows[1]!.id);
    const parent = rows.find((r) => r.kind === "bone" && r.hasChildren && r.open)!;
    expect(arrowTarget(rows, parent.id, "left")).toEqual({ toggle: true, to: parent.id });
    const child = rows.find((r) => r.parent === parent.id && !(r.hasChildren && r.open))!;
    expect(arrowTarget(rows, child.id, "left").to).toBe(parent.id);
    expect(arrowTarget(rows, parent.id, "right").to).toBe(rows[rows.indexOf(parent) + 1]!.id);
  });
});

describe("selection history", () => {
  it("goes back and forward, skipping gone ids and dropping the forward branch on a new pick", () => {
    const h = new SelectionHistory();
    for (const id of ["a", "b", "c"]) h.push(id);
    expect(h.canBack()).toBe(true);
    expect(h.move(-1, () => true)).toBe("b");
    expect(h.move(-1, (i) => i !== "a")).toBeNull();
    expect(h.move(1, () => true)).toBe("c");
    h.move(-1, () => true);
    h.push("d");
    expect(h.canForward()).toBe(false);
  });
});

describe("inherit flags", () => {
  it("maps every engine mode to flags and back", () => {
    for (const mode of Object.keys(INHERIT_FLAGS)) expect(modeFor(flagsOf(mode))).toBe(mode);
  });
  it("disables a checkbox whose result the engine has no mode for, with a reason", () => {
    const normal = inheritToggle("normal", "reflection");
    expect(normal.next).toBeNull();
    expect(normal.reason).toMatch(/no inherit mode/);
    expect(inheritToggle("normal", "scale").next).toBe("noScale");
    expect(inheritToggle("noScale", "reflection").next).toBe("noScaleOrReflection");
    expect(inheritToggle("noScaleOrReflection", "rotation").next).toBe("onlyTranslation");
    expect(inheritToggle("onlyTranslation", "scale").next).toBe("noRotation");
  });
});

describe("colour", () => {
  it("uses the bone colour or the role colour", () => {
    expect(boneColor({ color: "FF0000ff" })).toBe("ff0000");
    expect(boneColor({ role: "limb" })).toBe("7fd1ff");
  });
});

describe("split and new bone plans", () => {
  const worldOf = (r: JsonObject, name: string) => {
    const b = setupSkeleton(r).getBone(name);
    return { x: b.world.x, y: b.world.y };
  };
  it("splits a bone in two, keeps every child where it was and stays a valid rig", () => {
    const r = raw();
    const bones = r["bones"] as JsonObject[];
    const parent = bones.find((b) => Number(b["length"]) > 10 && bones.some((c) => c["parent"] === b["name"]))!;
    const name = String(parent["name"]);
    const kids = bones.filter((b) => b["parent"] === name).map((b) => String(b["name"]));
    const before = kids.map((k) => worldOf(r, k));
    const plan = planSplitBone(r, name, 0.4);
    const out = runBatch(r, plan.commands).doc;
    expect(parseAnimDocument(out).ok).toBe(true);
    const after = (out["bones"] as JsonObject[]).find((b) => b["name"] === name)!;
    const second = (out["bones"] as JsonObject[]).find((b) => b["name"] === plan.bone)!;
    expect(Number(after["length"]) + Number(second["length"])).toBeCloseTo(Number(parent["length"]), 3);
    expect(second["parent"]).toBe(name);
    kids.forEach((k, i) => {
      expect((out["bones"] as JsonObject[]).find((b) => b["name"] === k)!["parent"]).toBe(plan.bone);
      const w = worldOf(out, k);
      expect(w.x).toBeCloseTo(before[i]!.x, 1);
      expect(w.y).toBeCloseTo(before[i]!.y, 1);
    });
  });
  it("refuses a zero-length bone and a split at the very end", () => {
    const r = raw();
    const bones = r["bones"] as JsonObject[];
    const zero = bones.find((b) => Number(b["length"] ?? 0) === 0)!;
    expect(() => planSplitBone(r, String(zero["name"]), 0.5)).toThrow();
    const some = bones.find((b) => Number(b["length"]) > 0)!;
    expect(() => planSplitBone(r, String(some["name"]), 0.99)).toThrow();
  });
  it("adds a child bone at the parent's tip", () => {
    const r = raw();
    const b = setupSkeleton(r).getBone("forearm_near");
    const plan = planChildBone(r, "forearm_near", { x: b.world.x, y: b.world.y, angleDeg: b.worldRotationX, length: b.data.length }, 30);
    const out = runBatch(r, plan.commands).doc;
    expect(parseAnimDocument(out).ok).toBe(true);
    const tip = b.localToWorld(b.data.length, 0, { x: 0, y: 0 });
    const w = worldOf(out, plan.bone);
    expect(w.x).toBeCloseTo(tip.x, 1);
    expect(w.y).toBeCloseTo(tip.y, 1);
  });
});

describe("mesh rows", () => {
  // A synthetic doc: the first slot gets a weighted mesh (two bones of its table used, one unused) and an unweighted one.
  const meshDoc = () => {
    const d = load() as unknown as { slots: { name: string; bone: string }[]; bones: { name: string }[]; skins: Record<string, { attachments: Record<string, Record<string, unknown>> }>; };
    const slot = d.slots[0]!;
    const [b0, b1, b2] = [d.bones[0]!.name, d.bones[1]!.name, d.bones[2]!.name];
    const skin = Object.keys(d.skins)[0]!;
    const atts = (d.skins[skin]!.attachments[slot.name] ??= {});
    // vertex 0: one influence (table 0); vertex 1: two influences (table 0 and 2). Table 1 is unused.
    atts["sleeve"] = { type: "mesh", path: "x", uvs: [0, 0, 1, 1], triangles: [], hull: 2, bones: [b0, b1, b2], vertices: [1, 0, 0, 0, 1, 2, 0, 0, 0, 0.5, 2, 0, 0, 0.5] };
    atts["flat"] = { type: "mesh", path: "x", uvs: [0, 0, 1, 1], triangles: [], hull: 2, vertices: [0, 0, 1, 1] };
    const clip = { deform: { [skin]: { [slot.name]: { sleeve: [{ time: 0, vertices: [0, 0] }] } } } };
    return { d: d as unknown as ReturnType<typeof load>, slot: slot.name, skin, clip, bones: [b0, b1, b2] as string[] };
  };

  it("a mesh attachment gets mesh and weight-count info; an unweighted mesh has no weight count", () => {
    const { d, slot, bones } = meshDoc();
    const rows = buildRows(d, { ...opts, toggled: new Set([`s:${slot}`]) });
    const sleeve = rows.find((r) => r.id === `a:${slot}/sleeve`)!;
    expect(sleeve.mesh).toBe(true);
    expect(sleeve.weightBones).toBe(2);
    expect(sleeve.hasChildren).toBe(true);
    expect(sleeve.open).toBe(false);
    const flat = rows.find((r) => r.id === `a:${slot}/flat`)!;
    expect(flat.mesh).toBe(true);
    expect(flat.weightBones).toBeUndefined();
    expect(flat.hasChildren).toBe(false);
    expect(rows.some((r) => r.kind === "weight")).toBe(false);
    const open = buildRows(d, { ...opts, toggled: new Set([`s:${slot}`, `a:${slot}/sleeve`]) });
    const weights = open.filter((r) => r.kind === "weight");
    expect(weights.map((r) => r.name)).toEqual([bones[0], bones[2]]);
    expect(weights[0]).toMatchObject({ slot, attachment: "sleeve", id: `w:${slot}/sleeve/${bones[0]}`, parent: `a:${slot}/sleeve` });
    expect(weights[0]!.depth).toBe(sleeve.depth + 1);
  });

  it("the deform dot needs a clip with keys on that mesh", () => {
    const { d, slot, skin, clip } = meshDoc();
    const t = { ...opts, toggled: new Set([`s:${slot}`]) };
    const at = (c?: { deform?: unknown } | null) => buildRows(d, { ...t, ...(c !== undefined ? { clip: c } : {}) });
    expect(at(clip).find((r) => r.id === `a:${slot}/sleeve`)!.deformKeyed).toBe(true);
    expect(at(clip).find((r) => r.id === `a:${slot}/flat`)!.deformKeyed).toBeUndefined();
    expect(at(clip).find((r) => r.id === `s:${slot}`)!.deformKeyed).toBe(true);
    expect(at(null).some((r) => r.deformKeyed)).toBe(false);
    expect(at().some((r) => r.deformKeyed)).toBe(false);
    expect(at({}).some((r) => r.deformKeyed)).toBe(false);
    expect(at({ deform: { [skin]: { [slot]: { sleeve: [] } } } }).some((r) => r.deformKeyed)).toBe(false);
  });

  it("the Meshes filter keeps only mesh attachments with their slots and bones", () => {
    const { d, slot } = meshDoc();
    const rows = buildRows(d, { ...opts, filters: { ...ALL_FILTERS, meshes: true } });
    expect(rows.filter((r) => r.kind === "attachment").every((r) => r.mesh)).toBe(true);
    expect(rows.some((r) => r.id === "g:constraints" || r.kind === "constraint")).toBe(false);
    const slots = rows.filter((r) => r.kind === "slot");
    expect(slots.map((r) => r.name)).toContain(slot);
    expect(slots.every((r) => !r.open && r.hasChildren)).toBe(true);
    expect(slots.length).toBeLessThan(d.slots.length);
    const open = buildRows(d, { ...opts, toggled: new Set(slots.map((r) => r.id)), filters: { ...ALL_FILTERS, meshes: true } });
    expect(open.filter((r) => r.kind === "attachment" && r.slot === slot).map((r) => r.name).sort()).toContain("sleeve");
    expect(open.filter((r) => r.kind === "attachment").every((r) => r.mesh)).toBe(true);
    expect(rows.length).toBeLessThan(buildRows(d, opts).length);
  });

  it("a search by weight bone name opens the mesh and shows that bone", () => {
    const { d, slot, bones } = meshDoc();
    const rows = buildRows(d, { ...opts, search: bones[2]! });
    expect(rows.some((r) => r.id === `w:${slot}/sleeve/${bones[2]}`)).toBe(true);
    expect(rows.some((r) => r.id === `w:${slot}/sleeve/${bones[0]}`)).toBe(false);
  });

  it("expand all can open a weighted mesh", () => {
    const { d, slot } = meshDoc();
    expect(toggledFor(d, true)).toContain(`a:${slot}/sleeve`);
  });
});
