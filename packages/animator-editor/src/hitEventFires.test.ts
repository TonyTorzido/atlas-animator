import { describe, expect, it } from "vitest";
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { emptyClip, frameTime, parseClip } from "./clipModel.js";
import { setEvent, withEventDefs } from "./eventModel.js";

function docWith(clip: unknown) {
  return withEventDefs(loadAnimDocument({ format: "atlas-anim@1", name: "t", canvas: { width: 10, height: 10, originX: 0, originY: 0 }, bones: [{ name: "root" }], events: { hit: {} }, animations: { c: clip as never } }));
}

/** Frames (steps of 1/30 s) on which each event fired. */
function firedOnFrames(clip: unknown, frames = 12): { name: string; frame: number }[] {
  const doc = docWith(clip);
  const sk = new Skeleton(doc);
  const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
  let frame = 0;
  const out: { name: string; frame: number }[] = [];
  state.addListener({ event: (_e, ev) => out.push({ name: ev.name, frame }) });
  state.setAnimation(0, "c", { loop: false });
  for (frame = 1; frame <= frames; frame++) {
    state.update(1 / 30);
    state.apply(sk);
  }
  return out;
}

describe("an editor-written hit fires on its contact frame", () => {
  it("a hit at frame 6 fires when the clock steps 5/30 -> 6/30, not one frame later", () => {
    const base = emptyClip(1);
    const clip = setEvent(base, frameTime(base, 6), "hit");
    expect(clip.events[0]!.time).toBe(6 / 30);
    expect(firedOnFrames(clip)).toEqual([{ name: "hit", frame: 6 }]);
  });
  it("an old rig file's 5-decimal hit (0.2 is exact, 0.16667 is not) fires on its frame after loading", () => {
    const raw = { duration: 1, loop: false, fps: 30, events: [{ time: 0.16667, name: "hit" }] };
    expect(firedOnFrames(parseClip(raw))).toEqual([{ name: "hit", frame: 5 }]);
  });
});
