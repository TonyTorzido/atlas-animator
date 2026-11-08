/*
 * Atlas Animator: original implementation.
 *
 * Runtime attachments, built once per document and shared by every skeleton made from it.
 *
 * - RegionAttachment: a rigid textured quad on the slot bone.
 * - MeshAttachment:   a triangle mesh. Its geometry (triangles, image UVs, bind data, weights) lives
 *                     in a MeshGeometryData object. A linked mesh is a MeshAttachment that shares
 *                     its source's geometry object and only brings its own texture path and colour,
 *                     so body and swag deform by exactly the same numbers (plan 4.5.1).
 * - PointAttachment:  a named position and direction on the slot bone (grip, tip, FX socket).
 *
 * Deform: every mesh has a "deform owner", the attachment whose deform offsets move it. A mesh and
 * a linked mesh with `inheritDeform: false` own their deform; a linked mesh that inherits deform
 * uses its source's, so keying the body torso moves every tunic linked to it. Deform owners are
 * numbered (`deformIndex`) so a skeleton can keep its per-instance offsets in flat arrays.
 *
 * Everything here is immutable after construction; per-instance state lives in the Skeleton.
 */
import { parseRgba, type Rgba } from "./color.js";
import {
  meshVertexCount,
  type AnimDocument,
  type LinkedMeshAttachmentData,
  type MeshAttachmentData,
  type PointAttachmentData,
  type ClippingAttachmentData,
  type BoundingBoxAttachmentData,
  type PathAttachmentData,
  type SequenceData,
  type RegionAttachmentData
} from "./format.js";
import { DEG_TO_RAD } from "./math.js";
import { offsetChainsFromNext, type OffsetChains } from "./skinning.js";
import { triangulateOutline } from "./opaqueOutline.js";

/** Where an attachment is defined: skins[skin].attachments[slot][name]. */
export interface AttachmentAddress {
  readonly skin: string;
  readonly slot: string;
  /** The placeholder name the attachment is stored under. */
  readonly name: string;
}

/**
 * Geometry shared by a mesh and its linked meshes.
 *
 * Unweighted: `bind` holds (x, y) per vertex in the slot bone's space; `counts`,
 * `influenceBones` and `weights` are empty.
 * Weighted: `counts[v]` influences per vertex; per influence (in vertex order) `influenceBones`
 * holds the skeleton bone index, `bind` the bind position (x, y) in that bone's space and
 * `weights` the weight.
 * In both cases a deform array has `bind.length` floats and is added onto `bind` element-wise.
 */
export interface MeshGeometryData {
  readonly vertexCount: number;
  readonly weighted: boolean;
  readonly bind: Float64Array;
  readonly counts: Uint8Array;
  readonly influenceBones: Uint16Array;
  readonly weights: Float64Array;
  readonly triangles: Uint16Array | Uint32Array;
  /** Image-space UVs (0..1 of the attachment's image), 2 per vertex. */
  readonly uvs: Float32Array;
  /** The first `hull` vertices are the outline, in order. */
  readonly hull: number;
  /** Floats in a deform array for this geometry (= bind.length). */
  readonly deformLength: number;
  /** Draw groups (format `groups`), in document order, or null for an ungrouped mesh. */
  readonly groups: readonly MeshGroupData[] | null;
  /** Embedded vertices (format `embed`), or null. */
  readonly embed: MeshEmbedData | null;
}

/**
 * Vertices posed from another mesh of the same skin: vertex `vertices[i]` lands at
 * `refWeights[3i..3i+2]` . posed source vertices `refs[3i..3i+2]` (the same evaluation contours use).
 */
export interface MeshEmbedData {
  readonly slot: string;
  readonly attachment: string;
  readonly vertices: Uint32Array;
  readonly refs: Int32Array;
  readonly refWeights: Float64Array;
  /**
   * Boundary offset vertices (format `embed.offsets`), posed after the embedded ones: vertex
   * `offsetVertices[i]` = anchor `offsetRefs[3i]` moved by `offsetDist[i]` along the miter normal of
   * prev `offsetRefs[3i+1]` -> anchor -> next `offsetRefs[3i+2]` (core/skinning.ts offsetPoint).
   */
  readonly offsetVertices: Uint32Array;
  readonly offsetRefs: Int32Array;
  readonly offsetDist: Float64Array;
  /**
   * The offset entries in walk order per boundary run (derived at load from the strip triangles:
   * the cell anchor_i -> anchor_j is triangulated (a_i, a_j, o_j), (a_i, o_j, o_i), so a triangle
   * holding two offset vertices and the anchor of one of them links that one to the other).
   */
  readonly offsetChains: OffsetChains;
  /** Scratch of the runtime's offset pass (2 floats and a flag per entry). Do not read. */
  readonly offsetScratch: Float64Array;
  readonly offsetFlags: Uint8Array;
}

/**
 * One draw group of a mesh: a triangle subset with its own compact vertex list. `vertices` maps
 * each group vertex to its mesh vertex, so a vertex on a group boundary reads the same skinned
 * position (and has the same UV) in every group that uses it.
 */
export interface MeshGroupData {
  readonly slot: string;
  /** Mesh vertex index of each group vertex. */
  readonly vertices: Uint32Array;
  /** Triangles in group vertex indices. */
  readonly triangles: Uint16Array | Uint32Array;
  /** Image UVs of the group vertices (copied from the mesh UVs). */
  readonly uvs: Float32Array;
}

/** True when a mesh draws through its groups (a plain mesh with `groups`; linked meshes draw whole). */
export function isGroupedMesh(attachment: Attachment | null | undefined): boolean {
  return attachment !== null && attachment !== undefined && attachment.type === "mesh" && attachment.linkedTo === null && attachment.geometry.groups !== null;
}

interface AttachmentBase extends AttachmentAddress {
  /** Index in AttachmentLibrary.attachments. */
  readonly id: number;
  readonly color: Readonly<Rgba>;
}

export interface RegionAttachment extends AttachmentBase {
  readonly type: "region";
  readonly path: string;
  /** Image sequence (frames are `path` + padded number), or null for a single image. */
  readonly sequence: SequenceData | null;
  /** Image size in canvas pixels. */
  readonly width: number;
  readonly height: number;
  /**
   * Corner positions in the slot bone's space, (x, y) for top-left, top-right, bottom-right,
   * bottom-left of the image.
   */
  readonly offsets: Float64Array;
  /** Image UVs of the four corners, same order. */
  readonly uvs: Float32Array;
  readonly triangles: Uint16Array;
  /** Format `opaque`: opaque outline (simple polygon), u, v pairs of the image, or null (the rectangle). */
  readonly opaque: Float32Array | null;
  /** Ear-clipped triangles of `opaque` (indices into its vertices), or null with it. */
  readonly opaqueTriangles: Uint16Array | null;
}

export interface MeshAttachment extends AttachmentBase {
  readonly type: "mesh";
  readonly path: string;
  readonly sequence: SequenceData | null;
  readonly width: number;
  readonly height: number;
  readonly geometry: MeshGeometryData;
  /** The mesh whose geometry this one shares, or null for a plain mesh. */
  readonly linkedTo: MeshAttachment | null;
  /** The attachment whose deform offsets move this mesh (itself unless it inherits deform). */
  readonly deformOwner: MeshAttachment;
  /** Index among deform owners, or -1 when this mesh uses another attachment's deform. */
  readonly deformIndex: number;
  /** The mesh embedded vertices are posed from (geometry.embed), or null. */
  readonly embedSource: MeshAttachment | null;
}

export interface PointAttachment extends AttachmentBase {
  readonly type: "point";
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

/** A clipping mask: cuts the slots after its own up to `endSlot` (null = the end of the draw order). */
export interface ClippingAttachment extends AttachmentBase {
  readonly type: "clipping";
  /** x, y pairs in the slot bone's space. */
  readonly vertices: Float64Array;
  readonly endSlot: string | null;
}

/** A hit box: never drawn; see computeBoundingBoxWorld / boundingBoxContains in core/skinning.ts. */
export interface BoundingBoxAttachment extends AttachmentBase {
  readonly type: "boundingbox";
  readonly vertices: Float64Array;
}

/** A bezier path for path constraints: 3 vertices per control point (handle in, point, handle out). Never drawn. */
export interface PathAttachment extends AttachmentBase {
  readonly type: "path";
  readonly closed: boolean;
  readonly constantSpeed: boolean;
  readonly vertexCount: number;
  /** Unweighted: x, y per vertex in the slot bone's space. Weighted: the mesh encoding (see pathAttachmentSchema). */
  readonly vertices: Float64Array;
  /** Bone names the weighted encoding indexes, or null. */
  readonly bones: readonly string[] | null;
}

export type Attachment = RegionAttachment | MeshAttachment | PointAttachment | ClippingAttachment | BoundingBoxAttachment | PathAttachment;
export type DrawableAttachment = RegionAttachment | MeshAttachment;

export function isDrawable(attachment: Attachment | null | undefined): attachment is DrawableAttachment {
  return attachment !== null && attachment !== undefined && (attachment.type === "region" || attachment.type === "mesh");
}

/** Texture path of frame `index` of a sequence (Spine: path + number zero-padded to `digits`). */
export function sequenceFramePath(path: string, sequence: SequenceData | null, index: number): string {
  if (!sequence) return path;
  const frame = Math.min(Math.max(Math.trunc(index), 0), sequence.count - 1);
  return path + String(sequence.start + frame).padStart(sequence.digits, "0");
}

/** Every texture path a drawable attachment can show (all sequence frames, or its one path). */
export function attachmentTexturePaths(attachment: DrawableAttachment): string[] {
  const sequence = attachment.sequence;
  if (!sequence) return [attachment.path];
  return Array.from({ length: sequence.count }, (_, i) => sequenceFramePath(attachment.path, sequence, i));
}

/** The parts of a document attachments are built from. */
export type AttachmentDocument = Pick<AnimDocument, "bones" | "skins">;

export class AttachmentLibrary {
  readonly attachments: readonly Attachment[];
  /** Attachments that own a deform array, indexed by `deformIndex`. */
  readonly deformOwners: readonly MeshAttachment[];
  /** Every distinct texture path a drawable attachment uses. */
  readonly texturePaths: readonly string[];
  private readonly byAddress: ReadonlyMap<string, Attachment>;

  /** `doc` must be validated (loadAnimDocument): references are assumed to resolve. */
  constructor(doc: AttachmentDocument) {
    const boneIndex = new Map(doc.bones.map((bone, i) => [bone.name, i] as const));
    const attachments: Attachment[] = [];
    const owners: MeshAttachment[] = [];
    const byAddress = new Map<string, Attachment>();
    const geometryCache = new Map<MeshAttachmentData, MeshGeometryData>();
    const geometryOf = (data: MeshAttachmentData): MeshGeometryData => {
      let geometry = geometryCache.get(data);
      if (!geometry) geometryCache.set(data, (geometry = buildMeshGeometry(data, boneIndex)));
      return geometry;
    };

    const addMesh = (address: AttachmentAddress, data: MeshAttachmentData): MeshAttachment => {
      const mesh: Mutable<MeshAttachment> = {
        ...base(address, attachments.length, data.color),
        type: "mesh",
        path: data.path,
        sequence: data.sequence ?? null,
        width: data.width,
        height: data.height,
        geometry: geometryOf(data),
        linkedTo: null,
        deformOwner: null as unknown as MeshAttachment,
        deformIndex: owners.length,
        embedSource: null
      };
      mesh.deformOwner = mesh;
      owners.push(mesh);
      attachments.push(mesh);
      byAddress.set(addressKey(address), mesh);
      return mesh;
    };

    // Plain attachments first, so linked meshes can find their (already built) source.
    const linked: [AttachmentAddress, LinkedMeshAttachmentData][] = [];
    for (const [skin, skinData] of Object.entries(doc.skins)) {
      for (const [slot, placeholders] of Object.entries(skinData.attachments)) {
        for (const [name, data] of Object.entries(placeholders)) {
          const address = { skin, slot, name };
          if (data.type === "mesh") addMesh(address, data);
          else if (data.type === "linkedMesh") linked.push([address, data]);
          else {
            const attachment =
              data.type === "region"
                ? buildRegion(address, attachments.length, data)
                : data.type === "clipping"
                  ? buildClipping(address, attachments.length, data)
                  : data.type === "boundingbox"
                    ? buildBoundingBox(address, attachments.length, data)
                    : data.type === "path"
                      ? buildPath(address, attachments.length, data)
                      : buildPoint(address, attachments.length, data);
            attachments.push(attachment);
            byAddress.set(addressKey(address), attachment);
          }
        }
      }
    }
    for (const [address, data] of linked) {
      const source = byAddress.get(addressKey({ skin: data.source.skin, slot: data.source.slot, name: data.source.attachment }));
      if (!source || source.type !== "mesh") {
        throw new Error(`linked mesh '${addressKey(address)}': source '${data.source.skin}/${data.source.slot}/${data.source.attachment}' is not a mesh`);
      }
      const mesh: Mutable<MeshAttachment> = {
        ...base(address, attachments.length, data.color),
        type: "mesh",
        path: data.path,
        sequence: data.sequence ?? null,
        width: data.width,
        height: data.height,
        geometry: source.geometry,
        linkedTo: source,
        deformOwner: source,
        deformIndex: -1,
        embedSource: null
      };
      if (!data.inheritDeform) {
        mesh.deformOwner = mesh;
        mesh.deformIndex = owners.length;
        owners.push(mesh);
      }
      attachments.push(mesh);
      byAddress.set(addressKey(address), mesh);
    }

    // Embedded vertices pose from a plain mesh of the same skin (one level: the source does not embed).
    for (const attachment of attachments) {
      if (attachment.type !== "mesh" || !attachment.geometry.embed) continue;
      const embed = attachment.geometry.embed;
      const source = byAddress.get(addressKey({ skin: attachment.skin, slot: embed.slot, name: embed.attachment }));
      if (!source || source.type !== "mesh" || source.geometry.embed) {
        throw new Error(`mesh '${addressKey(attachment)}': embed source '${attachment.skin}/${embed.slot}/${embed.attachment}' is not a mesh without its own embed`);
      }
      (attachment as Mutable<MeshAttachment>).embedSource = source;
    }

    this.attachments = attachments;
    this.deformOwners = owners;
    this.byAddress = byAddress;
    this.texturePaths = [...new Set(attachments.flatMap((a) => (isDrawable(a) ? attachmentTexturePaths(a) : [])))];
  }

  /** The attachment stored at skins[skin].attachments[slot][name]. */
  get(skin: string, slot: string, name: string): Attachment | undefined {
    return this.byAddress.get(addressKey({ skin, slot, name }));
  }
}

const libraries = new WeakMap<AttachmentDocument, AttachmentLibrary>();

/** The shared library of a document (built on first use, then cached for that document object). */
export function attachmentLibraryFor(doc: AttachmentDocument): AttachmentLibrary {
  let library = libraries.get(doc);
  if (!library) libraries.set(doc, (library = new AttachmentLibrary(doc)));
  return library;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function addressKey(address: AttachmentAddress): string {
  // Names cannot contain '/', so this key is unambiguous.
  return `${address.skin}/${address.slot}/${address.name}`;
}

function base(address: AttachmentAddress, id: number, color: string) {
  return { skin: address.skin, slot: address.slot, name: address.name, id, color: parseRgba(color) };
}

function buildRegion(address: AttachmentAddress, id: number, data: RegionAttachmentData): RegionAttachment {
  const cos = Math.cos(data.rotation * DEG_TO_RAD);
  const sin = Math.sin(data.rotation * DEG_TO_RAD);
  const hw = (data.width / 2) * data.scaleX;
  const hh = (data.height / 2) * data.scaleY;
  const corners = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
  const offsets = new Float64Array(8);
  for (let i = 0; i < 8; i += 2) {
    const u = corners[i] as number;
    const v = corners[i + 1] as number;
    offsets[i] = data.x + cos * u - sin * v;
    offsets[i + 1] = data.y + sin * u + cos * v;
  }
  return {
    ...base(address, id, data.color),
    type: "region",
    path: data.path,
    sequence: data.sequence ?? null,
    width: data.width,
    height: data.height,
    offsets,
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    triangles: new Uint16Array([0, 1, 2, 0, 2, 3]),
    ...(() => {
      const triangles = data.opaque ? triangulateOutline(data.opaque) : null;
      return triangles && data.opaque ? { opaque: Float32Array.from(data.opaque), opaqueTriangles: triangles } : { opaque: null, opaqueTriangles: null };
    })()
  };
}

function buildPoint(address: AttachmentAddress, id: number, data: PointAttachmentData): PointAttachment {
  return { ...base(address, id, data.color), type: "point", x: data.x, y: data.y, rotation: data.rotation };
}

function buildClipping(address: AttachmentAddress, id: number, data: ClippingAttachmentData): ClippingAttachment {
  return { ...base(address, id, data.color), type: "clipping", vertices: Float64Array.from(data.vertices), endSlot: data.end ?? null };
}

function buildPath(address: AttachmentAddress, id: number, data: PathAttachmentData): PathAttachment {
  return {
    ...base(address, id, data.color),
    type: "path",
    closed: data.closed,
    constantSpeed: data.constantSpeed,
    vertexCount: data.vertexCount,
    vertices: Float64Array.from(data.vertices),
    bones: data.bones ?? null
  };
}

function buildBoundingBox(address: AttachmentAddress, id: number, data: BoundingBoxAttachmentData): BoundingBoxAttachment {
  return { ...base(address, id, data.color), type: "boundingbox", vertices: Float64Array.from(data.vertices) };
}

function buildGroups(data: MeshAttachmentData): MeshGroupData[] | null {
  if (!data.groups) return null;
  return Object.entries(data.groups).map(([slot, ranges]) => {
    const local = new Map<number, number>();
    const vertices: number[] = [];
    const triangles: number[] = [];
    for (const [start, end] of ranges) {
      for (let i = start * 3; i < end * 3; i++) {
        const vertex = data.triangles[i] as number;
        let mapped = local.get(vertex);
        if (mapped === undefined) {
          local.set(vertex, (mapped = vertices.length));
          vertices.push(vertex);
        }
        triangles.push(mapped);
      }
    }
    const uvs = new Float32Array(vertices.length * 2);
    vertices.forEach((vertex, i) => {
      uvs[i * 2] = data.uvs[vertex * 2] as number;
      uvs[i * 2 + 1] = data.uvs[vertex * 2 + 1] as number;
    });
    return {
      slot,
      vertices: Uint32Array.from(vertices),
      triangles: vertices.length <= 0xffff ? Uint16Array.from(triangles) : Uint32Array.from(triangles),
      uvs
    };
  });
}

/** The one embed convention: a point [a, b, c, wa, wb] weighs its refs (wa, wb, 1 - wa - wb). */
export function embedWeights(wa: number, wb: number): [number, number, number] {
  return [wa, wb, 1 - wa - wb];
}

function buildEmbed(data: MeshAttachmentData): MeshEmbedData | null {
  const embed = data.embed;
  if (!embed) return null;
  const refs = new Int32Array(embed.vertices.length * 3);
  const refWeights = new Float64Array(refs.length);
  embed.points.forEach((point, i) => {
    const [a, b, c, wa, wb] = typeof point === "number" ? [point, point, point, 1, 0] : point;
    refs[i * 3] = a;
    refs[i * 3 + 1] = b;
    refs[i * 3 + 2] = c;
    refWeights[i * 3] = wa;
    refWeights[i * 3 + 1] = wb;
    refWeights[i * 3 + 2] = typeof point === "number" ? 0 : 1 - wa - wb;
  });
  const offsets = embed.offsets?.points ?? [];
  const offsetRefs = new Int32Array(offsets.length * 3);
  const offsetDist = new Float64Array(offsets.length);
  offsets.forEach((point, i) => {
    offsetRefs[i * 3] = point[0];
    offsetRefs[i * 3 + 1] = point[1];
    offsetRefs[i * 3 + 2] = point[2];
    offsetDist[i] = point[3];
  });
  const offsetVertices = Uint32Array.from(embed.offsets?.vertices ?? []);
  return { slot: embed.slot, attachment: embed.attachment, vertices: Uint32Array.from(embed.vertices), refs, refWeights, offsetVertices, offsetRefs, offsetDist, offsetChains: offsetChainsFromNext(offsetNextFromTriangles(data.triangles, offsetVertices, offsetRefs)), offsetScratch: new Float64Array(offsets.length * 2), offsetFlags: new Uint8Array(offsets.length) };
}

/**
 * Successor of each boundary offset entry on its run (-1 at a run end), read from the mesh's strip
 * triangles: (anchor_i, offset_j, offset_i) carries the anchor of entry i, so i -> j.
 */
export function offsetNextFromTriangles(triangles: ArrayLike<number>, offsetVertices: ArrayLike<number>, offsetRefs: ArrayLike<number>): Int32Array {
  const entryOf = new Map<number, number>();
  for (let i = 0; i < offsetVertices.length; i++) entryOf.set(offsetVertices[i] as number, i);
  const next = new Int32Array(offsetVertices.length).fill(-1);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const tri = [triangles[t] as number, triangles[t + 1] as number, triangles[t + 2] as number];
    const e = tri.map((v) => entryOf.get(v) ?? -1);
    const off = [0, 1, 2].filter((k) => (e[k] as number) >= 0);
    if (off.length !== 2) continue;
    const w = tri[3 - (off[0] as number) - (off[1] as number)] as number;
    const u = e[off[0] as number] as number;
    const v = e[off[1] as number] as number;
    if (w === offsetRefs[u * 3] && (next[u] as number) < 0) next[u] = v;
    else if (w === offsetRefs[v * 3] && (next[v] as number) < 0) next[v] = u;
  }
  return next;
}

function buildMeshGeometry(data: MeshAttachmentData, boneIndex: ReadonlyMap<string, number>): MeshGeometryData {
  const vertexCount = meshVertexCount(data);
  const embed = buildEmbed(data);
  const triangles = vertexCount <= 0xffff ? Uint16Array.from(data.triangles) : Uint32Array.from(data.triangles);
  const uvs = Float32Array.from(data.uvs);
  const groups = buildGroups(data);
  if (!data.bones) {
    return {
      vertexCount,
      weighted: false,
      bind: Float64Array.from(data.vertices),
      counts: new Uint8Array(0),
      influenceBones: new Uint16Array(0),
      weights: new Float64Array(0),
      triangles,
      uvs,
      hull: data.hull,
      deformLength: vertexCount * 2,
      groups,
      embed
    };
  }
  const table = data.bones.map((name) => {
    const index = boneIndex.get(name);
    if (index === undefined) throw new Error(`mesh '${data.path}': unknown bone '${name}'`);
    return index;
  });
  const counts = new Uint8Array(vertexCount);
  const influences: number[] = [];
  const bind: number[] = [];
  const weights: number[] = [];
  let cursor = 0;
  for (let v = 0; v < vertexCount; v++) {
    const n = data.vertices[cursor++] as number;
    counts[v] = n;
    for (let k = 0; k < n; k++) {
      influences.push(table[data.vertices[cursor] as number] as number);
      bind.push(data.vertices[cursor + 1] as number, data.vertices[cursor + 2] as number);
      weights.push(data.vertices[cursor + 3] as number);
      cursor += 4;
    }
  }
  return {
    vertexCount,
    weighted: true,
    bind: Float64Array.from(bind),
    counts,
    influenceBones: Uint16Array.from(influences),
    weights: Float64Array.from(weights),
    triangles,
    uvs,
    hull: data.hull,
    deformLength: bind.length,
    groups,
    embed
  };
}
