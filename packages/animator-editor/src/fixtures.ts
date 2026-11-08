/*
 * Atlas Animator editor: original implementation.
 *
 * The rigs and clips the editor opens, as repo-relative paths. Every outfit is a full rig document
 * of the same template (template7 shoulder + legs: identical bones, pose limits, IK and clips);
 * the garment is baked into the body skin, so switching outfit swaps the document and its atlas
 * while the clip being edited stays. The dev server serves these read-only under `/repo/`.
 */

export interface OutfitFixture {
  id: string;
  label: string;
  document: string;
  atlas: string;
  /** Adds the in-memory stand-in weapon (standInWeapon.ts) to the loaded document. */
  standInWeapon?: boolean;
}

const PLAYER = "packages/animator/rigs/player";
/**
 * The pro cut-out bodies with drawn grip hands, weapon bone and axe (copies of the player-rig-kit branch rigs). Editor-only
 * defaults, as in the Spine export: double_axe in the weapon slot (grip wrap on the weapon bone), grip_fingers / grip_back on the
 * near hand, and an empty non-looping user_pose clip.
 */
const KIT = "packages/animator/rigs/kit-body-cutout";
/** The straight-front pro rig (copy of the player-rig-kit kit-body-front0). */
const KIT_FRONT = "packages/animator/rigs/kit-body-front0";

/**
 * The canonical stock player rig (tank top, black pants), three views of one template: identical
 * bones, limits and IK. "Turned L" is the live walk / gather rig, "Turned R" its mirrored twin
 * (the client draws the right side as the flipped left), "Front" the straight idle rig.
 */
export const ALL_OUTFITS: OutfitFixture[] = [
  { id: "pro-front", label: "Straight front (pro)", document: `${KIT_FRONT}/kit-body-front0.anim.json`, atlas: `${KIT_FRONT}/kit-body-front0.atlas.json` },
  { id: "pro-turned", label: "Side (pro)", document: `${KIT}/kit-body-cutout.anim.json`, atlas: `${KIT}/kit-body-cutout.atlas.json` },
  { id: "turned-l", label: "Turned L", document: `${PLAYER}/front-turn15-faceA.anim.json`, atlas: `${PLAYER}/front-turn15-faceA.atlas.json` },
  { id: "turned-r", label: "Turned R", document: `${PLAYER}/front-turn15-faceA-mirin.anim.json`, atlas: `${PLAYER}/front-turn15-faceA-mirin.atlas.json` },
  { id: "turned-l-axe", label: "Turned L + axe", document: `${PLAYER}/front-turn15-faceA.anim.json`, atlas: `${PLAYER}/front-turn15-faceA.atlas.json`, standInWeapon: true },
  { id: "front", label: "Front", document: `${PLAYER}/front-turn00-faceA.anim.json`, atlas: `${PLAYER}/front-turn00-faceA.atlas.json` }
];

// front view retired 2026-10-25: the straight-front rigs stay on disk but are not reachable from the UI or defaults.
export const RETIRED_OUTFIT_IDS: readonly string[] = ["pro-front", "front"];

/** The rigs the editor offers (the straight-front ones are retired). */
export const OUTFITS: OutfitFixture[] = ALL_OUTFITS.filter((o) => !RETIRED_OUTFIT_IDS.includes(o.id));

/** The default player rig: Player v2 (the stock rig folder packages/animator/rigs/player-v2, found by discoverRigs like any editor rig). */
export const DEFAULT_OUTFIT = "player-v2";
/** The old kit-body-cutout rig ("Side (pro)"): still offered under Old rigs, and what the editor opens when Player v2 is not listed (no dev server). */
export const FALLBACK_OUTFIT = "pro-turned";

/** The rig the editor opens when nothing else is asked for: Player v2 once it is listed, else the old side rig. */
export function defaultOutfitId(): string {
  return OUTFITS.some((o) => o.id === DEFAULT_OUTFIT) ? DEFAULT_OUTFIT : FALLBACK_OUTFIT;
}

/** A rig the editor discovered on the server (made with New rig): the same shape the server lists. */
export interface DiscoveredRig {
  id: string;
  label: string;
  document: string;
  atlas: string;
  template?: string;
}

/** Ids of the discovered rigs (not the hand-built fixtures). */
export const DISCOVERED_IDS = new Set<string>();

/** Adds discovered rigs to the lists the editor offers (idempotent; a fixture id is never replaced). Returns the ones that were new. */
export function registerDiscoveredRigs(rigs: readonly DiscoveredRig[]): OutfitFixture[] {
  const added: OutfitFixture[] = [];
  for (const r of rigs) {
    if (ALL_OUTFITS.some((o) => o.id === r.id)) continue;
    const fixture: OutfitFixture = { id: r.id, label: r.label, document: r.document, atlas: r.atlas };
    ALL_OUTFITS.push(fixture);
    OUTFITS.push(fixture);
    DISCOVERED_IDS.add(r.id);
    added.push(fixture);
  }
  return added;
}

/** Fetches the server's rig list and registers it. Quiet when there is no dev server (the fixtures stay). */
export async function discoverRigs(): Promise<OutfitFixture[]> {
  try {
    const r = await fetch("/api/rigs");
    if (!r.ok) return [];
    const j = (await r.json()) as { rigs?: DiscoveredRig[] };
    return registerDiscoveredRigs(Array.isArray(j.rigs) ? j.rigs : []);
  } catch {
    return [];
  }
}

/** A stored or requested outfit id as one the editor still offers: a retired or unknown id falls back to the default player rig. */
export function liveOutfitId(id: string | null | undefined): string {
  return id && OUTFITS.some((o) => o.id === id) ? id : defaultOutfitId();
}

/** Clip sources outside the rig documents. The old ones (emote_bling, walk-front-chibi) are keyed on the previous bone names and garble the pro rigs. */
export const CLIP_FIXTURES: readonly { file: string; label: string }[] = [];

/** Where the editor's Save writes clip files (repo-relative). */
export const SAVE_DIR = "packages/animator-editor/clips";
