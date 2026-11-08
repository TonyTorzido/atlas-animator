/*
 * Atlas Animator: original implementation.
 *
 * The importer's hook into the swag checks (cli/garmentImport.ts `--swag-checks`): loads the guide
 * data for the rig and domain the importer is running on and checks the art. Kept out of the importer
 * so the importer only calls one function.
 */
import { loadSwagContext } from "./swagGuide.js";
import { runSwagChecks, type SwagChecksReport } from "./swagChecks.js";
import { distInside } from "./garmentImport.js";
import type { MutableImage, RgbaImage } from "./image.js";

export function swagImportChecks(rigPath: string, domainPath: string, hides: readonly string[], art: RgbaImage): SwagChecksReport {
  return runSwagChecks(art, loadSwagContext({ rigPath, domainPath, hides }));
}

/** The body ink colour the importer's ink detector knows (tools/garmentImport.ts defaultInk). */
const IMPORTER_INK: [number, number, number] = [53, 15, 2];

/**
 * The importer removes the art's silhouette ink by recognising the body's red-brown ink family, then
 * draws its own stroke from the domain (the engine owns the outline). Swag art may use any dark
 * outline hue, which that detector would miss and the engine stroke would double. So the copy of the
 * art handed to the importer has its outline pixels (opaque pixels within 12 px of the silhouette
 * edge that are clearly darker than the item's fill) set to the ink colour the importer strips. The
 * art file itself is never changed; the checks run on the original.
 */
export function normaliseOutlineInk(art: RgbaImage, contrast = 30): MutableImage {
  const { width: w, height: h } = art;
  const op = new Uint8Array(w * h);
  for (let i = 0; i < op.length; i++) op[i] = (art.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
  const d = distInside(op, w, h);
  const lum = (i: number) => 0.2126 * (art.data[i * 4] as number) + 0.7152 * (art.data[i * 4 + 1] as number) + 0.0722 * (art.data[i * 4 + 2] as number);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < op.length; i++) if (op[i] && (d[i] as number) > 14) { sum += lum(i); n++; }
  const fill = n ? sum / n : 255;
  const out: MutableImage = { width: w, height: h, data: new Uint8Array(art.data) };
  for (let i = 0; i < op.length; i++) {
    if (op[i] && (d[i] as number) <= 12 && lum(i) <= fill - contrast) out.data.set(IMPORTER_INK, i * 4);
  }
  return out;
}
