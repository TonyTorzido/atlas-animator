/*
 * Atlas Animator editor: original implementation.
 *
 * The rig's skins as Spine skins (the `skins` array of a Spine skeleton JSON), pure and DOM free. The mapping of one
 * attachment is the one the CLI exporter (packages/animator/src/cli/exportSpine.ts) applies to every skin of a
 * document: y flipped, region/mesh/point attachments, texture names `slot/attachment` (the first use of a texture path
 * names it, every skin reuses that name), the first skin written as "default". Skin bones and skin constraints become
 * the Spine skin's `bones` / `ik` / `transform` lists. Linked meshes export as Spine 4.3 `linkedmesh` (`source`, `slot`, `skin`, `timelines`).
 */
import type { AnimDocument } from "@atlas-animator/core/core";

type Json = Record<string, unknown>;

const num = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const neg = (v: number): number => num(-v);

export interface SpineSkinsResult {
  skins: Json[];
  /** Texture path -> Spine attachment path (image name) used by the skins. */
  images: Record<string, string>;
  warnings: string[];
}

/** Spine skin name of a skin: the first (base) skin is "default". */
export const spineSkinName = (names: readonly string[], name: string): string => (names[0] === name ? "default" : name);

export function skinsToSpine(doc: Pick<AnimDocument, "bones" | "skins" | "ik" | "transform">): SpineSkinsResult {
  const warnings: string[] = [];
  const names = Object.keys(doc.skins);
  const images: Record<string, string> = {};
  const imageName = (path: string, slot: string, attachment: string): string => (images[path] ??= `${slot}/${attachment}`);
  const boneIndex = new Map(doc.bones.map((b, i) => [b.name, i] as const));
  const ikNames = new Set(doc.ik.map((c) => c.name));
  const transformNames = new Set(doc.transform.map((c) => c.name));

  const skins = Object.entries(doc.skins).map(([skinName, skin]) => {
    const attachments: Record<string, Record<string, Json>> = {};
    for (const [slot, byName] of Object.entries(skin.attachments)) {
      for (const [name, a] of Object.entries(byName)) {
        let out: Json | null = null;
        if (a.type === "region") {
          out = { name, path: imageName(a.path, slot, name) };
          if (a.x) out.x = num(a.x);
          if (a.y) out.y = neg(a.y);
          if (a.rotation) out.rotation = neg(a.rotation);
          if (a.scaleX < 0 || a.scaleY < 0) warnings.push(`region ${skinName}/${slot}/${name} is mirrored (negative scale); the mirror is not baked here`);
          if (Math.abs(a.scaleX) !== 1) out.scaleX = num(Math.abs(a.scaleX));
          if (Math.abs(a.scaleY) !== 1) out.scaleY = num(Math.abs(a.scaleY));
          out.width = num(a.width);
          out.height = num(a.height);
        } else if (a.type === "mesh") {
          if (a.groups || a.embed) warnings.push(`mesh ${skinName}/${slot}/${name}: draw groups / embedded vertices are not exported`);
          const vertices: number[] = [];
          if (!a.bones) {
            for (let i = 0; i < a.vertices.length; i += 2) vertices.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
          } else {
            const table = a.bones.map((n) => {
              const index = boneIndex.get(n);
              if (index === undefined) throw new Error(`mesh ${skinName}/${slot}/${name}: unknown bone '${n}'`);
              return index;
            });
            let i = 0;
            while (i < a.vertices.length) {
              const n = a.vertices[i++] as number;
              vertices.push(n);
              const influences: number[][] = [];
              for (let k = 0; k < n; k++, i += 4) {
                influences.push([table[a.vertices[i] as number] as number, num(a.vertices[i + 1] as number), neg(a.vertices[i + 2] as number), num(a.vertices[i + 3] as number)]);
              }
              influences.sort((p, q) => (p[0] as number) - (q[0] as number));
              for (const influence of influences) vertices.push(...influence);
            }
          }
          out = { name, type: "mesh", path: imageName(a.path, slot, name), uvs: a.uvs.map(num), triangles: a.triangles, vertices, hull: a.hull };
          if (a.edges) out.edges = a.edges.map((v) => v * 2);
          out.width = num(a.width);
          out.height = num(a.height);
        } else if (a.type === "point") {
          out = { type: "point", x: num(a.x), y: neg(a.y), rotation: neg(a.rotation) };
        } else if (a.type === "clipping" || a.type === "boundingbox") {
          const flipped: number[] = [];
          for (let i = 0; i < a.vertices.length; i += 2) flipped.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
          out = { name, type: a.type, vertexCount: flipped.length / 2, vertices: flipped };
          if (a.type === "clipping" && a.end !== undefined) out.end = a.end;
        } else if (a.type === "path") {
          if (a.bones) warnings.push(`path ${skinName}/${slot}/${name}: weighted paths are not exported in a skin file`);
          else {
            const flipped: number[] = [];
            for (let i = 0; i < a.vertices.length; i += 2) flipped.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
            out = { name, type: "path", closed: a.closed, constantSpeed: a.constantSpeed, lengths: [], vertexCount: a.vertexCount, vertices: flipped };
          }
        } else {
          if (doc.skins[a.source.skin]?.attachments[a.source.slot]?.[a.source.attachment]?.type !== "mesh") {
            warnings.push(`linked mesh ${skinName}/${slot}/${name}: source ${a.source.skin}/${a.source.slot}/${a.source.attachment} is not a mesh; not exported`);
          } else {
            out = { name, type: "linkedmesh", path: imageName(a.path, slot, name), skin: spineSkinName(names, a.source.skin), source: a.source.attachment, width: num(a.width), height: num(a.height) };
            if (a.source.slot !== slot) out.slot = a.source.slot;
            if (a.inheritDeform === false) out.timelines = false;
          }
        }
        if (out) {
          if (a.type !== "point" && a.color !== "ffffffff") out.color = a.color;
          if ((a.type === "region" || a.type === "mesh" || a.type === "linkedMesh") && a.sequence) out.sequence = { count: a.sequence.count, start: a.sequence.start, digits: a.sequence.digits, setup: a.sequence.setup };
          (attachments[slot] ??= {})[name] = out;
        }
      }
    }
    const result: Json = { name: spineSkinName(names, skinName), attachments };
    if (skin.bones.length) result.bones = [...skin.bones];
    const ik = skin.constraints.filter((c) => ikNames.has(c));
    const transform = skin.constraints.filter((c) => transformNames.has(c));
    if (ik.length) result.ik = ik;
    if (transform.length) result.transform = transform;
    if (skin.hides.length) warnings.push(`skin ${skinName} hides slots (${skin.hides.join(", ")}); Spine skins have no hide list`);
    return result;
  });
  return { skins, images, warnings };
}
