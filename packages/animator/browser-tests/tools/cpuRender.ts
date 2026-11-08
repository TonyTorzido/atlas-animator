/*
 * Atlas Animator: original implementation.
 *
 * Renders a rig's setup pose with the CPU review rasteriser (softRender) on a transparent canvas,
 * canvas size and origin as the document says, scale 1:
 *   tsx browser-tests/tools/cpuRender.ts <doc.anim.json> <atlas.json> <out.png>
 * The browser tests compare it with the Pixi page (the fox misregistration).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { encodePng, readPng } from "../../src/tools/png.js";
import { poseSkeleton } from "../../src/tools/review.js";
import { softRender } from "../../src/tools/softRender.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";

const [docPath, atlasPath, out] = process.argv.slice(2) as [string, string, string];
const doc = loadAnimDocument(JSON.parse(readFileSync(docPath, "utf8")));
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
const pages = new Map(pack.pages.map((page) => [page.file, readPng(join(dirname(atlasPath), page.file))]));
const skin = Object.keys(doc.skins)[0] ?? "body";
const image = softRender(poseSkeleton(doc, [skin], null), texturesFromAtlas(pack, pages), { width: doc.canvas.width, height: doc.canvas.height }).image;
writeFileSync(out, encodePng(image));
