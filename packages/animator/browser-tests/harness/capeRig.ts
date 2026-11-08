/*
 * Atlas Animator: original implementation.
 *
 * The Phase 3 exit rig: the three-part fixture rig plus a cape skin, a chain of five skin bones
 * hanging from the top of the chest with one physics constraint per bone, and a weighted mesh
 * drawn behind the body. Built in code (document and texture), like the strip in main.ts, so the
 * render test owns everything it checks. Pure (no DOM), so Node tests can use it too.
 */
import type { AnimDocumentInput } from "../../src/core/format.js";
import type { RgbaImage } from "../../src/pixi/imageOps.js";

export const CAPE_LINKS = 5;
export const CAPE_LINK_LENGTH = 24;
export const CAPE_LENGTH = CAPE_LINKS * CAPE_LINK_LENGTH;
export const CAPE_WIDTH = 96;
export const CAPE_PATH = "swag/cape/back";
/** Mesh rows down the cape (every half link). */
export const CAPE_MESH_ROWS = 2 * CAPE_LINKS + 1;
const ROWS = CAPE_MESH_ROWS;

/** The cape's physics tuning (each link). */
export const CAPE_PHYSICS = { rotate: 1, inertia: 0.35, strength: 140, damping: 0.78, mass: 1, gravity: 600 } as const;

/** Half width of the cape at distance s down the chain: 34 px at the shoulders, 48 at the hem. */
export function capeHalfWidth(s: number): number {
  return 34 + (14 * s) / CAPE_LENGTH;
}

const EASE: [number, number, number, number] = [0.42, 0, 0.58, 1];

/** 4-second demo: the whole figure sways left and right for 1.25 s, then stands still. */
const DEMO_CLIP = {
  duration: 4,
  loop: false,
  bones: {
    root: {
      translate: [
        { time: 0, x: 0, y: 0, curve: EASE },
        { time: 0.35, x: -36, y: 0, curve: EASE },
        { time: 0.85, x: 36, y: 0, curve: EASE },
        { time: 1.25, x: 0, y: 0 }
      ]
    },
    chest: {
      rotate: [
        { time: 0, value: 0, curve: EASE },
        { time: 0.35, value: 8, curve: EASE },
        { time: 0.85, value: -8, curve: EASE },
        { time: 1.25, value: 0 }
      ]
    }
  }
};

/** Adds the cape (bones, slot behind the body, skin, physics) and the `cape_demo` clip to a parsed three-part document. */
export function withCape(threePart: AnimDocumentInput): AnimDocumentInput {
  const doc = structuredClone(threePart) as AnimDocumentInput & Record<string, unknown>;
  const bones = [...doc.bones];
  const names: string[] = [];
  for (let i = 0; i < CAPE_LINKS; i++) {
    const name = `cape${i}`;
    names.push(name);
    bones.push(
      i === 0
        ? // From the top of the chest (which points up), turned to hang down.
          { name, parent: "chest", x: 56, rotation: 180, length: CAPE_LINK_LENGTH, skin: true }
        : { name, parent: `cape${i - 1}`, x: CAPE_LINK_LENGTH, length: CAPE_LINK_LENGTH, skin: true }
    );
  }
  doc.bones = bones;
  doc.slots = [{ name: "cape", bone: "chest", attachment: "cape" }, ...(doc.slots ?? [])];
  if (doc.drawOrder) doc.drawOrder = ["cape", ...doc.drawOrder];
  doc.skins = { ...doc.skins, cape: { attachments: { cape: { cape: capeMesh(names) } }, bones: [names[CAPE_LINKS - 1] as string], constraints: names } };
  doc.physics = [...(doc.physics ?? []), ...names.map((name) => ({ name, bone: name, skin: true, ...CAPE_PHYSICS }))];
  doc.animations = { ...doc.animations, cape_demo: DEMO_CLIP };
  return doc;
}

/**
 * Two vertex columns (left top-to-bottom, then right bottom-to-top, so every vertex is on the
 * hull), a row every half link. Each vertex blends the two nearest link centres linearly, so the
 * cloth bends smoothly across the joints.
 */
function capeMesh(bones: string[]) {
  const rows = Array.from({ length: ROWS }, (_, r) => (r * CAPE_LENGTH) / (ROWS - 1));
  const points = [...rows.map((s) => ({ s, side: -1 })), ...[...rows].reverse().map((s) => ({ s, side: 1 }))];
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const { s, side } of points) {
    const lateral = side * capeHalfWidth(s);
    // Link-centre coordinate: 0 at the centre of link 0.
    const u = Math.min(Math.max(s / CAPE_LINK_LENGTH - 0.5, 0), CAPE_LINKS - 1);
    const j = Math.min(Math.floor(u), CAPE_LINKS - 2);
    const f = u - j;
    // Every link points the same way in the setup pose, so a link's local frame is the chain's,
    // shifted along it. Lateral +y is the cape's right edge in the link's frame.
    vertices.push(2, j, s - j * CAPE_LINK_LENGTH, lateral, 1 - f, j + 1, s - (j + 1) * CAPE_LINK_LENGTH, lateral, f);
    uvs.push((lateral + CAPE_WIDTH / 2) / CAPE_WIDTH, s / CAPE_LENGTH);
  }
  const triangles: number[] = [];
  const right = (r: number) => 2 * ROWS - 1 - r;
  for (let r = 0; r < ROWS - 1; r++) triangles.push(r, r + 1, right(r + 1), r, right(r + 1), right(r));
  return {
    type: "mesh" as const,
    path: CAPE_PATH,
    bones,
    uvs,
    triangles,
    vertices,
    hull: points.length,
    width: CAPE_WIDTH,
    height: CAPE_LENGTH
  };
}

/** Cape cloth colour (the render test probes for it). */
export const CAPE_RED: readonly [number, number, number] = [150, 34, 46];

/**
 * 96 x 120 cape texture: red cloth with darker vertical folds, a gold hem and a dark outline along
 * the trapezoid the mesh covers (texture u maps the full width, the mesh only the trapezoid).
 */
export function capeImage(): RgbaImage {
  const width = CAPE_WIDTH;
  const height = CAPE_LENGTH;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const half = capeHalfWidth(y + 0.5);
    for (let x = 0; x < width; x++) {
      const lateral = x + 0.5 - width / 2;
      const edge = Math.abs(lateral) > half - 2.5 || y < 2 || y >= height - 2;
      const hem = y >= height - 12;
      const fold = Math.floor((lateral + 48) / 12) % 2 === 1;
      const colour: readonly number[] = edge ? [36, 14, 18] : hem ? [214, 168, 70] : fold ? [124, 26, 38] : CAPE_RED;
      data.set([colour[0] as number, colour[1] as number, colour[2] as number, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
