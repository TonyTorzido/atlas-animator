/*
 * Atlas Animator: the editor clip id -> game clip id map (PL-03). The data is `packages/animator/clipMap.json`, shared by the
 * editor's clip catalogue (animator-editor gameClips.ts), the Publish validator (cli/validatePublish.ts) and, later, the sheet
 * renderer and the client's manifest reader. An editor clip without a row is not in the game yet.
 */
import { z } from "zod";
import raw from "../clipMap.json" with { type: "json" };

export const CLIP_MAP_FORMAT = "atlas-clip-map@1";

const gameClipSchema = z
  .object({
    /** The client's clip id (stockArmour.ts StockClipId). */
    id: z.string().regex(/^[A-Za-z0-9_]+$/),
    side: z.enum(["front", "L", "R"]),
    /** The right side is the left side's sheet flipped. */
    flip: z.boolean(),
    /** Held frames of the sheet at `fps`. */
    frames: z.number().int().positive()
  })
  .strict();

export const clipMapSchema = z
  .object({
    format: z.literal(CLIP_MAP_FORMAT),
    note: z.string().optional(),
    fps: z.number().int().positive(),
    clips: z.record(
      z.string().regex(/^[A-Za-z0-9_]+$/),
      z.object({ source: z.string(), game: z.array(gameClipSchema).min(1) }).strict()
    ),
    /** Game clip ids no editor clip feeds yet, with the reason. */
    gameOnly: z.record(z.string(), z.string()).default({})
  })
  .strict()
  .superRefine((map, ctx) => {
    const seen = new Set<string>();
    for (const [editor, row] of Object.entries(map.clips)) {
      for (const g of row.game) {
        if (seen.has(g.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", editor], message: `game clip '${g.id}' is mapped twice` });
        seen.add(g.id);
      }
    }
    for (const id of Object.keys(map.gameOnly)) if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gameOnly", id], message: `'${id}' is mapped and listed as game-only` });
  });

export type ClipMap = z.output<typeof clipMapSchema>;
export type GameClipRef = z.output<typeof gameClipSchema>;

export const CLIP_MAP: ClipMap = clipMapSchema.parse(raw);

/** The game clips an editor clip feeds (empty when it is not in the game yet). */
export function gameClipsFor(editorId: string, map: ClipMap = CLIP_MAP): readonly GameClipRef[] {
  return map.clips[editorId]?.game ?? [];
}

/** Every editor clip id that has a row. */
export function mappedEditorClips(map: ClipMap = CLIP_MAP): string[] {
  return Object.keys(map.clips).sort();
}

/** Every game clip id: mapped ones plus game-only ones. */
export function allGameClipIds(map: ClipMap = CLIP_MAP): string[] {
  return [...Object.values(map.clips).flatMap((r) => r.game.map((g) => g.id)), ...Object.keys(map.gameOnly)].sort();
}
