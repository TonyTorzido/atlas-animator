import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { AnimationLibrary, KEY_TIME_EPSILON } from "./timelines.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

// Key times are written with 5 decimals: frame 4 at 30 fps is 0.13333 (before 4/30), frame 5 is 0.16667 (after 5/30).
const doc = testDocument({
  bones: [{ name: "root" }, { name: "arm", parent: "root", x: 10, length: 20 }],
  slots: [
    { name: "a", bone: "root", attachment: "one" },
    { name: "b", bone: "root", attachment: "one" }
  ],
  skins: {
    body: {
      attachments: {
        a: { one: { type: "point" }, two: { type: "point" } },
        b: { one: { type: "point" }, two: { type: "point" } }
      }
    }
  },
  events: { hit: {} },
  animations: {
    swing: {
      duration: 1,
      loop: false,
      slots: { a: { attachment: [{ time: 0.13333, name: "two" }] }, b: { attachment: [{ time: 0.16667, name: "two" }] } },
      drawOrder: [{ time: 0.16667, offsets: [{ slot: "a", offset: 1 }] }],
      events: [{ time: 0.16667, name: "hit" }]
    }
  }
});

function sampleAt(time: number) {
  const skeleton = new Skeleton(doc);
  const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
  const fired: string[] = [];
  state.setAnimation(0, "swing", { loop: false });
  state.update(time);
  state.apply(skeleton);
  skeleton.updateWorldTransform();
  void fired;
  return { shown: ["a", "b"].map((n) => skeleton.getSlot(n).placeholder), order: skeleton.drawOrder.map((s) => s.data.name) };
}

describe("stepped keys written with 5 decimals", () => {
  it("the epsilon is far below a frame", () => {
    expect(KEY_TIME_EPSILON).toBeLessThan(1 / 30 / 100);
  });
  it("a swap key at frame 4 (0.13333) shows when the runtime state is sampled at exactly 4/30", () => {
    expect(sampleAt(4 / 30).shown[0]).toBe("two");
    expect(sampleAt(3 / 30).shown[0]).toBe("one");
  });
  it("a swap and a draw order key at frame 5 (0.16667, after 5/30) show when sampled at 5/30 and not on frame 4", () => {
    const at5 = sampleAt(5 / 30);
    expect(at5.shown[1]).toBe("two");
    expect(at5.order.indexOf("a")).toBe(1);
    const at4 = sampleAt(4 / 30);
    expect(at4.shown[1]).toBe("one");
    expect(at4.order.indexOf("a")).toBe(0);
  });
  it("an event at frame 5 fires once when time steps through 4/30 -> 5/30 -> 6/30", () => {
    const skeleton = new Skeleton(doc);
    const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
    const fired: number[] = [];
    state.setAnimation(0, "swing", { loop: false });
    state.addListener({ event: () => fired.push(1) });
    for (let f = 0; f <= 7; f++) {
      state.update(f === 0 ? 0 : 1 / 30);
      state.apply(skeleton);
    }
    expect(fired.length).toBe(1);
  });
});
