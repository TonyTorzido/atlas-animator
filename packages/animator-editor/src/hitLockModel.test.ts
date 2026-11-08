import { describe, expect, it } from "vitest";
import { emptyClip, frameTime } from "./clipModel.js";
import { stepContactFrame, setEvent } from "./eventModel.js";
import { clipProfile, hitChip, hitStatuses, lengthIssue, snapHit, tickTimes } from "./hitLockModel.js";
import { GAME_CLIPS } from "./gameClips.js";

const attack = GAME_CLIPS.find((c) => c.group === "attack" && c.timing.source === "profile")!;
const profile = clipProfile(attack.id)!;
const contact = stepContactFrame(profile.style, profile.step, 30)!;

describe("server tick marks", () => {
  it("lands a tick every 50 ms", () => {
    const t = tickTimes(0.5);
    expect(t).toHaveLength(11);
    expect(t[2]).toBeCloseTo(0.1, 9);
  });
});

describe("hit lock", () => {
  const base = emptyClip(frameTime({ fps: 30 }, 30), false, 30);

  it("knows the profile of a game attack clip by its name", () => {
    expect(profile).toBeTruthy();
    expect(clipProfile("walk_not_an_attack")).toBeNull();
  });

  it("reports a hit on the contact frame as on tick and one frame late as late", () => {
    const good = setEvent(base, frameTime(base, contact), "hit");
    const goodStatus = hitStatuses(good, attack.id);
    expect(goodStatus[0]!.ok).toBe(true);
    expect(hitChip(goodStatus, null).text).toBe("Hit on tick ✓");
    const late = setEvent(base, frameTime(base, contact + 1), "hit");
    const lateStatus = hitStatuses(late, attack.id);
    expect(lateStatus[0]).toMatchObject({ ok: false, delta: 1, want: contact });
    expect(hitChip(lateStatus, null).text).toBe("Hit 1 frame late ▾");
    const early = setEvent(base, frameTime(base, contact + 2 > 29 ? 1 : 0), "hit");
    expect(hitChip(hitStatuses(early, attack.id), null).state).toBe("bad");
  });

  it("snaps a late hit onto the contact frame", () => {
    const late = setEvent(base, frameTime(base, contact + 3), "hit");
    const fixed = snapHit(late, hitStatuses(late, attack.id)[0]!);
    expect(hitStatuses(fixed, attack.id)[0]!.ok).toBe(true);
    expect(fixed.events.filter((e) => e.name === "hit")).toHaveLength(1);
  });

  it("ignores a clip with no profile and no link", () => {
    const loose = setEvent(base, 0.2, "hit");
    expect(hitStatuses(loose, "my_clip")).toEqual([]);
    expect(hitChip([], null).state).toBe("none");
  });

  it("flags a clip longer than windup + recovery", () => {
    const long = emptyClip(frameTime({ fps: 30 }, 90), false, 30);
    const issue = lengthIssue(long, attack.id);
    expect(issue).not.toBeNull();
    expect(issue!.frames).toBe(90);
    expect(hitChip([], issue).state).toBe("bad");
    expect(lengthIssue(emptyClip(frameTime({ fps: 30 }, issue!.allowedFrames), false, 30), attack.id)).toBeNull();
  });
});
