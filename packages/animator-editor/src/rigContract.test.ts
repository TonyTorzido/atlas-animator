import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACT_SLOTS, contractJson, contractStatus, planCreateMissing, planSeedPlayer, validateContract } from "./rigContract.js";
import { runBatch, type JsonObject } from "./setupModel.js";
import { ITEM_SLOT_MAP, ITEM_SLOTS } from "./swagModel.js";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const kit = JSON.parse(readFileSync(resolve(here, "../../animator/rigs/kit-body-cutout/kit-body-cutout.anim.json"), "utf8")) as JsonObject;
const blank = (): JsonObject => ({ format: "atlas-anim@1", name: "b", canvas: { width: 1086, height: 1448, originX: 542, originY: 960 }, bones: [{ name: "root", x: 0, y: 0 }], slots: [], skins: { default: { attachments: {} } }, animations: {}, atlas: { pages: ["b.empty.png"], scale: 1 } });

describe("rig contract", () => {
  it("covers every slot of ITEM_SLOT_MAP with a bone and a v2 name", () => {
    const all = ITEM_SLOTS.flatMap((s) => [...ITEM_SLOT_MAP[s].existing, ...ITEM_SLOT_MAP[s].added]);
    expect(CONTRACT_SLOTS.map((s) => s.slot).sort()).toEqual([...all].sort());
    expect(CONTRACT_SLOTS.find((s) => s.slot === "shirt_sleeve_near")).toMatchObject({ v2: "chest_sleeve_near", bone: "upper_arm_near", tier: "A" });
    expect(CONTRACT_SLOTS.find((s) => s.slot === "boots_foot_far")).toMatchObject({ v2: "boot_far", bone: "foot_far", onDemand: true });
  });
  it("kit-body-cutout has nothing missing", () => {
    const st = contractStatus(kit);
    expect(st.missingBones).toEqual([]);
    expect(st.missingSlots).toEqual([]);
    expect(st.missingPoints).toEqual([]);
    expect(st.missing).toBe(0);
    expect(st.points.map((p) => p.state)).toEqual(["bone", "bone"]);
  });
  it("a blank rig lists everything and Create missing fixes it in one batch", () => {
    const raw = blank();
    const st = contractStatus(raw);
    expect(st.missing).toBeGreaterThan(40);
    const plan = planCreateMissing(raw, { onDemand: true });
    const out = runBatch(structuredClone(raw), plan.commands).doc as JsonObject;
    const after = contractStatus(out);
    expect(after.missing).toBe(0);
    expect(after.onDemandSlots).toEqual([]);
    expect(after.points.map((p) => p.state)).toEqual(["point", "point"]);
    expect(() => planCreateMissing(out)).toThrow();
  });
  it("the player seed is wearable and its contract file validates", () => {
    const out = runBatch(structuredClone(blank()), planSeedPlayer(blank())).doc as JsonObject;
    expect(contractStatus(out).missing).toBe(0);
    expect(validateContract(contractJson())).toEqual([]);
    expect(validateContract({ format: "x" })).not.toEqual([]);
  });
});

import { alignGrip, buildItemBatch, pieceLocalPoint, piecePixelAt } from "./swagWorkshopModel.js";

describe("weapon grip registration", () => {
  const piece = { width: 40, height: 200, x: 0, y: 0, rotation: 0, scale: 1 };
  it("aligns the grip pixel onto the bone origin, turned and scaled", () => {
    for (const rot of [0, 30, -90, 24.8]) {
      for (const scale of [1, 0.5]) {
        const p = { ...piece, rotation: rot, scale };
        const at = alignGrip(p, { x: 20, y: 150 });
        const g = pieceLocalPoint({ ...p, ...at }, 20, 150);
        expect(Math.hypot(g.x, g.y)).toBeLessThan(0.02);
        const back = piecePixelAt({ ...p, ...at }, g.x, g.y);
        expect(Math.hypot(back.x - 20, back.y - 150)).toBeLessThan(0.01);
      }
    }
  });
  it("a weapon item writes grip and tip points whose grip lands within 2 px of the weapon bone", () => {
    const p = { ...piece, rotation: 12 };
    const at = alignGrip(p, { x: 20, y: 150 });
    const b = buildItemBatch(kit, { slot: "weapon", item: "qa-sword", rigName: "kit-body-cutout", pieces: [{ rigSlot: "weapon", png: "data:image/png;base64,AAAA", ...p, ...at, grip: { x: 20, y: 150 }, tip: { x: 20, y: 5 } }] });
    const pts = b.commands.filter((c) => c["op"] === "attachment.add" && (c["attachment"] as { type: string }).type === "point");
    expect(pts.map((c) => c["name"])).toEqual(["grip", "tip"]);
    const grip = pts[0]!["attachment"] as { x: number; y: number };
    expect(Math.hypot(grip.x, grip.y)).toBeLessThan(2);
    const tip = pts[1]!["attachment"] as { x: number; y: number };
    expect(Math.hypot(tip.x, tip.y)).toBeGreaterThan(100);
  });
});
