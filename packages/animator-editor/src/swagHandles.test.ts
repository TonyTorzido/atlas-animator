import { describe, expect, it } from "vitest";
import { dragMove, dragSize, dragTurn, handleSet, hitPiece, invert, mul, pieceBone, type Mat, type Placed } from "./swagHandles.js";

const piece: Placed = { width: 40, height: 20, x: 10, y: 5, rotation: 0, scale: 1 };
const camera: Mat = { a: 0.5, b: 0, c: 0, d: 0.5, x: 100, y: 100 };
const mirrored: Mat = { a: -0.5, b: 0, c: 0, d: 0.5, x: 100, y: 100 };

describe("swag placement handles (Batch 12c)", () => {
  it("puts the centre handle on the piece centre and the size handle on its far corner", () => {
    const h = handleSet(piece, camera);
    expect(h.centre).toEqual([105, 102.5]);
    expect(h.size[0]).toBeCloseTo(100 + (10 + 20) * 0.5, 6);
    expect(h.size[1]).toBeCloseTo(100 + (5 + 10) * 0.5, 6);
    expect(h.turn[1]).toBeLessThan(h.centre[1]);
  });

  it("move writes the bone-frame offset the same as typing the numbers", () => {
    const r = dragMove(piece, camera, 10, -4, false);
    expect(r).toEqual({ x: 30, y: -3 });
    expect(dragMove(piece, camera, 10, -4, true)).toEqual({ x: 30, y: 5 });
    const inv = invert(mul(camera, { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }))!;
    expect(inv.a).toBeCloseTo(2, 9);
  });

  it("turn follows the pointer, snaps to 15 degrees with Shift and flips for a mirrored picture", () => {
    const c: [number, number] = [105, 102.5];
    const a0 = -90;
    const r = dragTurn(piece, camera, c, a0, c[0] + 10, c[1], false);
    expect(r).toBeCloseTo(90, 2);
    expect(dragTurn(piece, camera, c, a0, c[0] + 10, c[1] - 10 * Math.tan((17 * Math.PI) / 180) * -1, true) % 15).toBeCloseTo(0, 6);
    expect(dragTurn(piece, mirrored, c, a0, c[0] + 10, c[1], false)).toBeCloseTo(-90, 2);
  });

  it("size scales with the pointer distance, clamps, and snaps to 10 percent with Shift", () => {
    const c: [number, number] = [0, 0];
    expect(dragSize(piece, c, 10, 25, 0, false)).toBe(2.5);
    expect(dragSize(piece, c, 10, 100, 0, false)).toBe(4);
    expect(dragSize(piece, c, 10, 0.1, 0, false)).toBe(0.1);
    expect(dragSize(piece, c, 10, 13.4, 0, true)).toBe(1.3);
  });

  it("hit-tests a press on the piece", () => {
    expect(hitPiece(piece, camera, 105, 102.5)).toBe(true);
    expect(hitPiece(piece, camera, 400, 400)).toBe(false);
  });

  it("finds the bone a piece rides: the slot's own bone, else the one a new slot would get", () => {
    const raw = { slots: [{ name: "torso", bone: "chest" }] };
    expect(pieceBone(raw, "torso")).toBe("chest");
    expect(pieceBone(raw, "helmet")).toBe("head");
    expect(pieceBone(raw, "nonsense")).toBeNull();
  });
});
