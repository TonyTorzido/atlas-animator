import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCommands } from "./commands.js";
import { diffDocuments, formatDiff } from "./diff.js";
import type { JsonObject } from "./jsonPatch.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url), "utf8")) as JsonObject;
const after = (commands: Record<string, unknown>[]) => applyCommands(fixture, commands as never).doc;

describe("semantic diff", () => {
  it("names the bone, clip and time of a moved key", () => {
    const changes = diffDocuments(fixture, after([{ op: "key.move", clip: "idle", bone: "chest", timeline: "rotate", time: 1.2, to: 1.3 }]));
    expect(changes).toEqual([{ area: "key", subject: "clip idle: bone chest rotate", kind: "moved", detail: "key 1.2s -> 1.3s" }]);
    expect(formatDiff(changes)).toBe("clip idle: bone chest rotate: moved key 1.2s -> 1.3s");
  });

  it("reports identical documents as no changes", () => {
    expect(formatDiff(diffDocuments(fixture, structuredClone(fixture)))).toBe("no changes");
  });

  it("covers bones, slots, draw order, skins, attachments, constraints, events and clips", () => {
    const text = formatDiff(
      diffDocuments(
        fixture,
        after([
          { op: "bone.set", name: "chest", rotation: 4 },
          { op: "bone.add", name: "aim", parent: "root" },
          { op: "slot.order", name: "head", before: "torso" },
          { op: "slot.color", name: "torso", color: "ff0000ff" },
          { op: "skin.hide", name: "tunic", hides: ["head"] },
          { op: "attachment.move-vertices", skin: "body", slot: "torso", name: "torso", vertices: [0], dx: 1, dy: 0 },
          { op: "constraint.add", kind: "ik", constraint: { name: "look", bones: ["head"], target: "aim" } },
          { op: "event.set", name: "hit", int: 3 },
          { op: "clip.add", name: "jump", duration: 0.5 },
          { op: "clip.duration", name: "attack", duration: 1.0 },
          { op: "key.set", clip: "idle", bone: "chest", timeline: "rotate", time: 1.2, value: 6 },
          { op: "key.delete", clip: "walk", bone: "hips", timeline: "translate", time: 0 },
          { op: "event.key", clip: "idle", time: 0.5, name: "step" }
        ])
      )
    );
    for (const expected of [
      "bone chest: changed rotation (none) -> 4",
      "bone aim: added",
      "slot torso: changed color (none) -> \"ff0000ff\"",
      "draw order: reordered base torso tunic head -> base head torso tunic",
      "skin tunic: changed hides (none) -> [\"head\"]",
      "attachment body/torso/torso: changed positions/weights changed",
      "ik look: added",
      "event hit: changed int",
      "clip jump: added duration 0.5s",
      "clip attack: changed duration 0.9 -> 1",
      "clip idle: bone chest rotate: changed key at 1.2s: value 4 -> 6",
      "clip walk: bone hips translate: removed key at 0s",
      "clip idle: events: added key at 0.5s {\"name\":\"step\"}"
    ]) {
      expect(text).toContain(expected);
    }
  });
});
