/*
 * Atlas Animator: original implementation.
 *
 * Outfit-aware contact-band eligibility,
 * shared by the batch validator and live authoring: a band measured between two contours gates a
 * pose only while both contours draw, judged per outfit (the body skin alone and with each other
 * skin), never with every skin active at once (a later skin would override a garment and switch its
 * bands off). Bands without a contour pair gate in the skeleton's own outfit.
 */
import type { AnimDocument } from "../core/format.js";
import type { Skeleton } from "../core/skeleton.js";
import { inContactBand, type ContactBandData } from "./contactBand.js";

/** The outfits ownership-gated bands are judged in: the body skin ("body", else the first skin) alone and with each other skin. */
export function bandOutfits(doc: Pick<AnimDocument, "skins">, bodySkin = "body"): string[][] {
  const names = Object.keys(doc.skins);
  const body = names.includes(bodySkin) ? bodySkin : names[0];
  if (body === undefined) return [[]];
  return [[body], ...names.filter((n) => n !== body).map((n) => [body, n])];
}

/**
 * True when a contour (`owner slot/name`) draws in the skeleton's current outfit and pose: visible
 * and not trimmed away entirely by the surfaces drawn over it (clothing model, the renderers' trim).
 */
export function contourDrawn(skeleton: Skeleton, ref: string): boolean {
  return skeleton.activeContours.some((c) => {
    if (`${c.slot}/${c.name}` !== ref || !skeleton.isContourVisible(c) || skeleton.contourOwnerAlpha(c) <= 0) return false;
    const runs = skeleton.contourRuns(c);
    return runs === null || runs.length > 0;
  });
}

/** A band holds the pose: inside its cells (and condition), and, with a contour pair, both contours drawn. */
export function bandEligible(skeleton: Skeleton, band: ContactBandData, drivers: Readonly<Record<string, number>>): boolean {
  if (!inContactBand(band, drivers)) return false;
  return !band.contours || (contourDrawn(skeleton, band.contours[0]) && contourDrawn(skeleton, band.contours[1]));
}
