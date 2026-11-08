/*
 * Atlas Animator editor: the Swag workshop's pure parts (no DOM; unit tested). Plan: the design notes section 3.
 *
 * Auto-mapping of dropped PNG file names to rig slots, plain-English labels and issue chips, the command batch that saves a new
 * item into one rig document (skin.add + planAttachImage per piece), and the list of skins to wear.
 */
import { isObj, listOf, objOf, slotNames, fail, type Command, type JsonObject } from "./setupModel.js";
import { importedPageFile, planAttachImage } from "./setupAttach.js";
import { boneForAddedSlot, ITEM_SLOT_MAP, itemSkinName, rigSlotsOf, type ItemIssue, type ItemSlot, type ViewId } from "./swagModel.js";
import type { SaveImage } from "./rigSave.js";
import { placeholderOf, pieceLocalPoint, piecePixelAt, type Transfer } from "./swagTransfer.js";

export const SLOT_LABELS: Readonly<Record<ItemSlot, string>> = {
  chest: "Chest",
  pants: "Pants",
  boots: "Boots",
  gloves: "Gloves",
  chain: "Chain",
  cape: "Cape",
  helmet: "Helmet",
  hair: "Hair",
  face: "Face",
  mask: "Mask",
  weapon: "Weapon"
};

export const VIEW_LABELS: Readonly<Record<ViewId, string>> = { turned: "Side" };

// ---------------------------------------------------------------------------------------------------------- labels

const GROUP_PREFIX = new Set(["shirt", "pants", "boots", "gloves"]);

/** `shirt_upper_arm_near` -> `Upper arm (near side)`; `gloves_hand_far_back` -> `Hand, back (far side)`. */
export function partLabel(rigSlot: string): string {
  const words = rigSlot.split("_");
  if (words.length > 1 && GROUP_PREFIX.has(words[0]!)) words.shift();
  let back = false;
  if (words[words.length - 1] === "back" && words.length > 1) {
    back = true;
    words.pop();
  }
  const side = words[words.length - 1] === "near" || words[words.length - 1] === "far" ? (words.pop() as string) : null;
  let text = words.join(" ");
  if (back) text += ", back";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return side ? `${text} (${side} side)` : text;
}

// ---------------------------------------------------------------------------------------------------------- mapping

/** A file name as a piece stem: no folders, no .png, lower case, words joined with underscores. */
export function pieceStem(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file)
    .replace(/\.png$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_");
}

export interface PieceMapping {
  /** stem -> rig slot */
  mapped: Record<string, string>;
  unmatched: string[];
}

/** Matches piece stems to the rig slots of an item slot: the exact slot name, the name without its group word (`torso`), or either behind the item slot's name. */
export function mapPieces(slot: ItemSlot, stems: readonly string[], taken: ReadonlySet<string> = new Set()): PieceMapping {
  const candidates = rigSlotsOf(slot);
  const used = new Set(taken);
  const mapped: Record<string, string> = {};
  const unmatched: string[] = [];
  const short = (c: string): string => {
    const w = c.split("_");
    return w.length > 1 && GROUP_PREFIX.has(w[0]!) ? w.slice(1).join("_") : c;
  };
  for (const stem of stems) {
    const bare = stem.startsWith(`${slot}_`) ? stem.slice(slot.length + 1) : stem;
    const hit = [stem, bare].flatMap((s) => [candidates.find((c) => c === s), candidates.find((c) => short(c) === s)]).find((c): c is string => !!c && !used.has(c));
    if (hit) {
      mapped[stem] = hit;
      used.add(hit);
    } else unmatched.push(stem);
  }
  return { mapped, unmatched };
}

/** The pieces an item of `slot` still needs (required rig slots not yet covered). */
export const stillNeeded = (slot: ItemSlot, covered: Iterable<string>): string[] => {
  const have = new Set(covered);
  return ITEM_SLOT_MAP[slot].required.filter((n) => !have.has(n));
};

// ------------------------------------------------------------------------------------------------------------ chips

export interface Chip {
  tone: "ok" | "warn" | "bad";
  text: string;
}

const num = (s: string, re: RegExp): string => re.exec(s)?.[1] ?? "";

/** One plain-English chip per check result. */
export function issueChip(i: ItemIssue): Chip {
  const view = VIEW_LABELS[i.view].toLowerCase();
  const part = i.slot ? partLabel(i.slot).toLowerCase() : "piece";
  switch (i.kind) {
    case "name":
      return { tone: "bad", text: "The item name needs a slot and an id, like chest.red-jerkin" };
    case "missing piece":
      return { tone: "bad", text: i.slot ? `The ${view} view is missing the ${part}` : `The ${view} view does not have this item yet` };
    case "no rig slot":
      return { tone: "warn", text: `The ${view} rig has no ${part} slot yet` };
    case "wrong side":
      return { tone: "bad", text: `The ${part} is on the wrong side (${view})` };
    case "stray piece":
      return { tone: "warn", text: `The ${part} does not belong to this kind of item (${view})` };
    case "placeholder":
      return { tone: "bad", text: `The ${part} art has the wrong name for this rig (${view})` };
    case "hides":
      return { tone: "warn", text: i.message.includes("must not") ? `It should not hide the ${part} (${view})` : `It should hide the ${part} (${view})` };
    case "pivot drift":
      return { tone: "warn", text: `The ${part} sits ${num(i.message, /is (\d+) px/)} px off its pivot (${view})` };
    case "size": {
      const pct = Number(num(i.message, /is (\d+)% of/));
      return { tone: "warn", text: `The ${part} is ${pct > 100 ? "too big" : "too small"} (${pct}% of the original, ${view})` };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- wearing

/** `chest.jacket_b` -> `Jacket B (chest)`. */
export function itemTitle(skin: string): string {
  const dot = skin.indexOf(".");
  const slot = dot < 0 ? "" : skin.slice(0, dot);
  const name = (dot < 0 ? skin : skin.slice(dot + 1)).replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const label = (SLOT_LABELS as Readonly<Record<string, string>>)[slot];
  return label ? `${name} (${label.toLowerCase()})` : name;
}

/** The status line after the worn skins change: what is worn in plain words, not the skin names. */
export function wearingText(active: readonly string[]): string {
  const items = active.filter((n) => n.includes("."));
  return items.length ? `Wearing ${items.map(itemTitle).join(", ")}` : "Showing the base outfit (nothing worn)";
}

/**
 * The skins to wear when the person has `worn` items on: one per item slot (the newest wins), only those the open rig has.
 * The base skin is added by the host.
 */
export function wearList(worn: readonly string[], have: ReadonlySet<string>): string[] {
  const bySlot = new Map<string, string>();
  for (const name of worn) if (have.has(name)) bySlot.set(name.slice(0, name.indexOf(".")), name);
  return [...bySlot.values()];
}

// ---------------------------------------------------------------------------------------------------------- saving


/** A pixel of a piece's own PNG (top-left origin, y down). */
export interface PiecePixel {
  x: number;
  y: number;
}

export interface PieceSave {
  rigSlot: string;
  width: number;
  height: number;
  /** `data:image/png;base64,...` */
  png: string;
  x: number;
  y: number;
  rotation: number;
  /** Uniform size (1 = as drawn). */
  scale?: number;
  /** Weapon pieces: the pixel the hand holds (becomes the `grip` point) and the pixel the blade or head ends at (`tip`). */
  grip?: PiecePixel;
  tip?: PiecePixel;
}

/** The region offset (x, y) that puts the piece's grip pixel on the bone origin: the weapon bone's origin is the grip by definition. */
export function alignGrip(p: { width: number; height: number; rotation: number; scale?: number }, grip: PiecePixel): { x: number; y: number } {
  const o = pieceLocalPoint({ ...p, x: 0, y: 0 }, grip.x, grip.y);
  return { x: Math.round(-o.x * 100) / 100 + 0, y: Math.round(-o.y * 100) / 100 + 0 };
}

/** The placeholder name an item piece must carry: what the slot shows in setup, else the base skin's first one, else the slot's own name. */
export const placeholderFor = placeholderOf;

export interface ItemBatch {
  skin: string;
  commands: Command[];
  images: SaveImage[];
}

/** The command batch (and atlas images) that adds item `slot.item` with `pieces` to the rig document `raw`. */
export function buildItemBatch(raw: JsonObject, o: { slot: ItemSlot; item: string; rigName: string; pieces: readonly PieceSave[]; /** Edit an existing item: its skin is removed first and added again from `pieces`. */ replace?: boolean; /** Mesh / weight transfers by rig slot (swagTransfer.planTransfer, or the /api/swag/import answer): a piece with one becomes a linked or own mesh instead of a region. */ transfers?: Readonly<Record<string, Pick<Transfer, "attachment">>> }): ItemBatch {
  const skin = itemSkinName(o.slot, o.item);
  const had = isObj(objOf(raw["skins"])[skin]);
  if (had && !o.replace) fail(`the rig already has an item called ${skin}`);
  if (had) raw = { ...raw, skins: skinsWithout(raw, skin) as JsonObject };
  if (!o.pieces.length) fail("add at least one PNG piece");
  const owned = new Set(rigSlotsOf(o.slot));
  const hides = ITEM_SLOT_MAP[o.slot].hides;
  const existing = new Set(slotNames(raw));
  const bones = new Set(listOf(raw["bones"]).map((b) => String(b["name"])));
  const atlas = objOf(raw["atlas"]);
  const pages: string[] = Array.isArray(atlas["pages"]) ? [...(atlas["pages"] as string[])] : [];
  const commands: Command[] = [...(had ? [{ op: "skin.remove", name: skin } as Command] : []), { op: "skin.add", name: skin, ...(hides.length ? { hides: [...hides] } : {}) }];
  const adds: Command[] = [];
  const images: SaveImage[] = [];
  const seen = new Set<string>();
  for (const p of o.pieces) {
    if (!owned.has(p.rigSlot)) fail(`${p.rigSlot} is not a ${o.slot} slot`);
    if (seen.has(p.rigSlot)) fail(`two pieces for ${p.rigSlot}`);
    seen.add(p.rigSlot);
    const has = existing.has(p.rigSlot);
    const bone = has ? undefined : boneForAddedSlot(p.rigSlot);
    if (!has && (!bone || !bones.has(bone))) fail(`the rig has no ${p.rigSlot} slot and no bone to put it on`);
    const name = has ? placeholderFor(raw, p.rigSlot) : p.rigSlot;
    const plan = planAttachImage(raw, { skin, slot: has ? p.rigSlot : null, ...(bone ? { bone } : {}), name, imported: { rigName: o.rigName }, width: p.width, height: p.height, setDefault: !has });
    const page = importedPageFile(o.rigName, `${o.item}-${p.rigSlot}`);
    if (!pages.includes(page)) pages.push(page);
    for (const c of plan.commands) {
      if (c.op === "doc.set") continue;
      if (c.op === "attachment.add") {
        const a = c["attachment"] as Record<string, unknown>;
        const t = o.transfers?.[p.rigSlot]?.attachment;
        if (t) adds.push({ ...c, attachment: { ...t, path: a["path"] } });
        else adds.push({ ...c, attachment: { ...a, ...(p.x ? { x: p.x } : {}), ...(p.y ? { y: p.y } : {}), ...(p.rotation ? { rotation: p.rotation } : {}), ...(p.scale && p.scale !== 1 ? { scaleX: p.scale, scaleY: p.scale } : {}) } });
      } else adds.push(c);
    }
    images.push({ file: page, path: plan.path, png: p.png });
    if (o.slot === "weapon") {
      for (const [pname, px] of [["grip", p.grip], ["tip", p.tip]] as const) {
        if (!px) continue;
        const at = pieceLocalPoint(p, px.x, px.y);
        adds.push({ op: "attachment.add", skin, slot: p.rigSlot, name: pname, attachment: { type: "point", x: Math.round(at.x * 100) / 100 + 0, y: Math.round(at.y * 100) / 100 + 0, rotation: 0 } } as Command);
      }
    }
  }
  commands.push({ op: "doc.set", atlas: { pages, scale: Number(atlas["scale"] ?? 1) } }, ...adds);
  return { skin, commands, images };
}

/** The skins of `raw` without `skin` (what /api/skins is sent to delete an item). */
export function skinsWithout(raw: JsonObject, skin: string): Record<string, unknown> {
  const { [skin]: _gone, ...rest } = objOf(raw["skins"]);
  return rest;
}

/** Lower-case item id from what the person typed: `Red Jerkin!` -> `red-jerkin`. */
export function itemIdFrom(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The item list narrowed by a search (name, slot or part words) and a slot filter ("" = every slot), in the list's own order. */
export function filterItems<T extends { name: string; item: string; slot: string }>(items: readonly T[], query: string, slot: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => (!slot || i.slot === slot) && words.every((w) => i.name.toLowerCase().includes(w) || i.item.toLowerCase().includes(w) || ((SLOT_LABELS as Record<string, string>)[i.slot] ?? "").toLowerCase().includes(w)));
}

export { boneForAddedSlot, pieceLocalPoint, piecePixelAt };
