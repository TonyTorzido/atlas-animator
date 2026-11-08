import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "../core/format.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { bonesFromSpecs, fitHumanoid, HUMANOID_BODY, HUMANOID_REVIEW_POSES, humanoidBoneSpecs, humanoidIk } from "./humanoid.js";
import { alphaMask, isInk } from "./image.js";
import { largestComponent } from "./outline.js";
import { readPng } from "./png.js";
import { inferRoles, rigPoses } from "./rigPoses.js";
import { LIVE_TEMPLATE_PATH } from "./testFigures.js";

/*
 * The humanoid skeleton fitted to the live body template (template7-clean.png). The raster rig
 * built on it (parts, joint pieces, fades) was retired in; the canonical body is built by
 * `animator rig --canonical`. The skeleton stays the humanoid's reference for the rig-derived
 * review poses: one region slot per weighted bone of the retired rig, so the same bones deform.
 */
function humanoidSkeleton(): AnimDocumentInput {
  const image = readPng(LIVE_TEMPLATE_PATH);
  const figure = largestComponent(alphaMask(image));
  if (!figure) throw new Error("the template has no opaque pixel");
  const landmarks = fitHumanoid(figure, (x, y) => figure.data[y * figure.width + x] === 1 && isInk(image, y * figure.width + x));
  const origin = landmarks.origin;
  const bones = bonesFromSpecs(humanoidBoneSpecs(landmarks), origin);
  const sided = ["upper_arm", "forearm", "hand", "thigh", "shin", "foot"].flatMap((bone) => [`${bone}_l`, `${bone}_r`]);
  const weighted = ["head", "pelvis", "spine", "chest", "neck", ...sided];
  return {
    format: "atlas-anim@1",
    name: "humanoid-template7",
    canvas: { width: image.width, height: image.height, originX: origin.x, originY: origin.y },
    bones,
    slots: weighted.map((name) => ({ name, bone: name, attachment: name })),
    skins: { body: { attachments: Object.fromEntries(weighted.map((name) => [name, { [name]: { type: "region", path: `body/${name}`, width: 10, height: 10 } }])) } },
    ik: humanoidIk(),
    budgets: structuredClone(HUMANOID_BODY.budgets)
  } as unknown as AnimDocumentInput;
}

describe("humanoid skeleton: rig-derived review poses", () => {
  it("rig-derived review poses () cover every joint of the humanoid review set, both directions", () => {
    const doc = loadAnimDocument(humanoidSkeleton());
    const derived = rigPoses(doc);
    const clamp = (name: string, value: number) => {
      const limits = doc.bones.find((b) => b.name === name)?.limits;
      return limits ? Math.max(limits.min, Math.min(limits.max, value)) : value;
    };
    for (const pose of HUMANOID_REVIEW_POSES) {
      for (const [bone, degrees] of Object.entries(pose.rotate)) {
        if (!doc.bones.some((b) => b.name === bone)) continue;
        const wanted = clamp(bone, degrees);
        const reached = derived.some((d) => {
          const value = d.rotate[bone] ?? 0;
          return wanted >= 0 ? value >= wanted : value <= wanted;
        });
        expect(reached, `${pose.name}: ${bone} ${wanted}`).toBe(true);
      }
    }
    const { roles } = inferRoles(doc);
    expect(roles.get("upper_arm_l")).toBe("limb");
    expect(roles.get("shin_r")).toBe("limb");
    expect(roles.get("chest")).toBe("spine");
    expect(roles.get("head")).toBe("head");
  });
});
