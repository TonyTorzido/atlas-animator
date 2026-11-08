import { describe, expect, it } from "vitest";
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { emptyClip, frameTime, heldTime } from "./clipModel.js";
import { setAttachmentKey } from "./slotModel.js";

describe("an editor-written swap shows on its own frame", () => {
  it("a swap keyed on frames 4 and 5 is shown at heldTime / frame / fps (what the editor and the render CLI sample)", () => {
    let clip = emptyClip(1);
    clip = setAttachmentKey(clip, "s", frameTime(clip, 4), "two");
    clip = setAttachmentKey(clip, "s", frameTime(clip, 5), "three");
    const doc = loadAnimDocument({
      format: "atlas-anim@1",
      name: "t",
      canvas: { width: 10, height: 10, originX: 0, originY: 0 },
      bones: [{ name: "root" }],
      slots: [{ name: "s", bone: "root", attachment: "one" }],
      skins: { body: { attachments: { s: { one: { type: "point" }, two: { type: "point" }, three: { type: "point" } } } } },
      animations: { c: clip }
    });
    const shownAt = (t: number) => {
      const sk = new Skeleton(doc);
      const st = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
      st.setAnimation(0, "c", { loop: false });
      st.update(t);
      st.apply(sk);
      return sk.getSlot("s").placeholder;
    };
    expect(frameTime(clip, 4)).toBe(4 / 30);
    expect(frameTime(clip, 5)).toBe(5 / 30);
    for (const [frame, want] of [[3, "one"], [4, "two"], [5, "three"], [6, "three"]] as const) {
      expect(shownAt(heldTime(clip, frame / 30)), `held frame ${frame}`).toBe(want);
      expect(shownAt(frame / 30), `exact ${frame}/30`).toBe(want);
    }
  });
});
