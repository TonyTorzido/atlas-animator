/*
 * Atlas Animator: original implementation.
 *
 * `atlas-pack@1`: the region table of prepacked atlas pages (`<name>.atlas.json` next to the page
 * PNGs). It says where each texture path's image sits on which page. The runtime does not draw
 * from these pages directly: the dynamic atlas copies each image it needs out of them, scaled to
 * display resolution (src/pixi/dynamicAtlas.ts). The phase 4 packer writes these files; tests use
 * hand-made ones.
 */
import { z } from "zod";
import { texturePathSchema } from "./format.js";

export const ATLAS_PACK_FORMAT_ID = "atlas-pack@1";

const pixels = () => z.number().int().nonnegative();

export const atlasPackSchema = z
  .object({
    format: z.literal(ATLAS_PACK_FORMAT_ID),
    /** Page pixels per canvas pixel. */
    scale: z.number().finite().positive().max(1),
    pages: z
      .array(
        z
          .object({
            file: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.png$/, "must be a .png file name"),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            /** texture path -> rectangle on this page, in page pixels. */
            regions: z.record(
              texturePathSchema,
              z.object({ x: pixels(), y: pixels(), width: z.number().int().positive(), height: z.number().int().positive() }).strict()
            )
          })
          .strict()
      )
      .min(1)
  })
  .strict()
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.pages.forEach((page, p) => {
      for (const [path, rect] of Object.entries(page.regions)) {
        if (seen.has(path)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", p, "regions", path], message: `'${path}' is on more than one page` });
        }
        seen.add(path);
        if (rect.x + rect.width > page.width || rect.y + rect.height > page.height) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", p, "regions", path], message: "region extends past the page" });
        }
      }
    });
  });

export type AtlasPack = z.output<typeof atlasPackSchema>;
