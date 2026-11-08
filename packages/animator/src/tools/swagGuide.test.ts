import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSwagContext } from "./swagGuide.js";
import { DEFAULT_BODY_RIG } from "./swagTypes.js";

/*
 * Colour-in guide (armour): the allowed area is the garment's own rest render, so a stroke the
 * resting arm covers (the flank just below a capped vest's armpit seam) still counts. The importer's
 * artworkCutEnds gate expects the art to reach margin + half a stroke there.
 */
// the capped leather domain (tools/garmentCaps.ts, ABANDONED), kept frozen for this test
const DOMAIN = "fixtures/garments/leather-caps-r13-abandoned.domain.json";
const have = existsSync(DEFAULT_BODY_RIG) && existsSync(DOMAIN);

describe("swag guide", () => {
  it("keeps the flank stroke below the armpit seam end that the resting arm covers", () => {
    expect(have, "fixtures missing").toBe(true);
    const ctx = loadSwagContext({ rigPath: DEFAULT_BODY_RIG, domainPath: DOMAIN, hides: ["tank", "tank_armhole", "tank_armhole_r"] });
    const W = ctx.width;
    // the seam-end anchors (rest): right flank (646,805) reads outward to +x, left (438,805) to -x
    for (const [x, y, dir] of [[646, 805, 1], [438, 805, -1]] as const) {
      let reach = 0;
      while (ctx.allowed[y * W + x + dir * (reach + 1)]) reach++;
      // margin 5.5 + half the 10 px stroke = 10.5; the gate accepts 5 px inside that
      expect(reach).toBeGreaterThanOrEqual(ctx.margin + ctx.strokeWidth / 2 - 5);
    }
  }, 120_000);
});
