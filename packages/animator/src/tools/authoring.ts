/*
 * Atlas Animator: original implementation.
 *
 * Authoring metadata (from the review): the document's optional `authoring`
 * block states what inference can only guess.
 *
 * - chains: ids, ordered bones (each the skeleton parent of the next), the chain each one branches
 *   from (`parent`: the branch boundary), symmetry groups, per-chain bend cap and range;
 * - domains: per mesh, the bones allowed to influence it, transition widths per joint and radius
 *   overrides per bone;
 * - connections between two chains: `welded` (the default joint rule), `overlap` (no influence
 *   crosses between them, even at a shared joint) or `membrane` (vertices between them blend
 *   across them anywhere: a wing membrane between finger bones);
 * - joints: declared slot pairs the validator's "joint opened" contact rule judges (besides the
 *   pairs derived from welded and overlap connections, `authoringJoints`);
 * - probes: validation poses beyond rotation (scale, translate, squash/stretch deform states,
 *   attachment changes, travelling waves along a chain, relative motion between two chains).
 *
 * When the block is absent, inference (rigPoses.inferRoles) stays a suggestion; when present,
 * review poses use these chains and probes, `weights.auto` honours domains and connections inside
 * its solve, and `validateAuthoring` checks the block against the skeleton and the weights.
 */
import type { AnimDocument, AuthoringData } from "../core/format.js";
import type { RigJoint } from "./validate.js";
import type { ReviewPose } from "./review.js";
import type { BoneRole, RigChain } from "./rigPoses.js";

export interface AuthoringIssue {
  severity: "error" | "warning";
  message: string;
}

type Chain = NonNullable<AuthoringData["chains"]>[number];

/** Bones that move something: listed by a weighted mesh or owning a slot with an attachment. */
export function deformingBones(doc: AnimDocument): Set<string> {
  const out = new Set<string>();
  const slotBone = new Map(doc.slots.map((slot) => [slot.name, slot.bone]));
  for (const skin of Object.values(doc.skins)) {
    for (const [slot, attachments] of Object.entries(skin.attachments)) {
      for (const attachment of Object.values(attachments)) {
        const bones = (attachment as { bones?: string[] }).bones;
        if (bones && bones.length > 0) for (const bone of bones) out.add(bone);
        else {
          const bone = slotBone.get(slot);
          if (bone) out.add(bone);
        }
      }
    }
  }
  return out;
}

/** Bones of an authoring chain id, or of a single bone named directly. */
export function chainBones(doc: AnimDocument, idOrBone: string): string[] {
  const chain = doc.authoring?.chains?.find((c) => c.id === idOrBone);
  if (chain) return [...chain.bones];
  return doc.bones.some((b) => b.name === idOrBone) ? [idOrBone] : [];
}

/** The domain declared for a mesh address, if any (an omitted skin or attachment matches any). */
export function domainFor(doc: AnimDocument, address: { skin: string; slot: string; name: string }): NonNullable<AuthoringData["domains"]>[number] | undefined {
  return doc.authoring?.domains?.find((d) => d.slot === address.slot && (d.skin === undefined || d.skin === address.skin) && (d.attachment === undefined || d.attachment === address.name));
}

/** Explicit chains as review chains (twins from symmetry groups, paired in listed order). */
export function authoringChains(doc: AnimDocument): RigChain[] | null {
  const chains = doc.authoring?.chains;
  if (!chains || chains.length === 0) return null;
  const out: RigChain[] = chains.map((chain) => ({ role: (chain.role ?? "limb") as BoneRole, path: [...chain.bones], members: [...chain.bones], id: chain.id }));
  const groups = new Map<string, number[]>();
  chains.forEach((chain, i) => {
    if (chain.symmetry) groups.set(chain.symmetry, [...(groups.get(chain.symmetry) ?? []), i]);
  });
  for (const members of groups.values()) {
    for (let k = 0; k + 1 < members.length; k += 2) {
      (out[members[k] as number] as RigChain).twin = members[k + 1] as number;
      (out[members[k + 1] as number] as RigChain).twin = members[k] as number;
    }
  }
  return out;
}

/** Validation probes expanded into review poses (see the file comment). */
export function authoringProbes(doc: AnimDocument): ReviewPose[] {
  const poses: ReviewPose[] = [];
  for (const probe of doc.authoring?.probes ?? []) {
    const bones = probeBones(doc, probe);
    const amount = "amount" in probe ? probe.amount : undefined;
    const all = <T>(value: (bone: string, k: number) => T) => Object.fromEntries(bones.map((b, k) => [b, value(b, k)]));
    switch (probe.kind) {
      case "rotate":
        poses.push({ name: `${probe.name} max`, rotate: all(() => amount ?? 15) }, { name: `${probe.name} min`, rotate: all(() => -(amount ?? 15)) });
        break;
      case "scale":
        poses.push({ name: probe.name, rotate: {}, scale: all(() => ({ x: probe.x ?? amount ?? 1.2, y: probe.y ?? amount ?? 1.2 })) });
        break;
      case "translate":
        poses.push({ name: `${probe.name} +`, rotate: {}, translate: all(() => ({ x: probe.x ?? 0, y: probe.y ?? 0 })) }, { name: `${probe.name} -`, rotate: {}, translate: all(() => ({ x: -(probe.x ?? 0), y: -(probe.y ?? 0) })) });
        break;
      case "deform": {
        // Squash and stretch at constant area: x by f, y by 1/f, then the reverse.
        const f = amount ?? 1.3;
        poses.push({ name: `${probe.name} squash`, rotate: {}, scale: all(() => ({ x: f, y: 1 / f })) }, { name: `${probe.name} stretch`, rotate: {}, scale: all(() => ({ x: 1 / f, y: f })) });
        break;
      }
      case "attachment":
        poses.push({ name: probe.name, rotate: {}, attachments: { [probe.slot]: probe.attachment ?? null } });
        break;
      case "wave": {
        // A travelling wave: bone k at amount * sin(2 pi (cycles k / n - t / steps)), t = 0..steps-1.
        const steps = probe.steps ?? 8;
        const cycles = probe.cycles ?? 1;
        const n = Math.max(1, bones.length);
        for (let t = 0; t < steps; t++) poses.push({ name: `${probe.name} t${t}`, rotate: all((_, k) => round((amount ?? 20) * Math.sin(2 * Math.PI * ((cycles * k) / n - t / steps)))) });
        break;
      }
      case "relative": {
        // Two chains against each other: each alone, then in opposition both ways.
        const [a, b] = probe.chains.map((id) => chainBones(doc, id)) as [string[], string[]];
        const set = (list: readonly string[], v: number) => Object.fromEntries(list.map((bone) => [bone, v]));
        const d = amount ?? 20;
        poses.push(
          { name: `${probe.name} a alone`, rotate: set(a, d) },
          { name: `${probe.name} b alone`, rotate: set(b, d) },
          { name: `${probe.name} apart`, rotate: { ...set(a, d), ...set(b, -d) } },
          { name: `${probe.name} together`, rotate: { ...set(a, -d), ...set(b, d) } }
        );
        break;
      }
    }
  }
  return poses;
}

type Probe = NonNullable<AuthoringData["probes"]>[number];

/** The bones a bone-targeted probe moves (its bones, else its chain's); none for attachment/relative. */
function probeBones(doc: AnimDocument, probe: Probe): string[] {
  if (probe.kind === "attachment" || probe.kind === "relative") return [];
  return probe.bones ?? (probe.chain ? chainBones(doc, probe.chain) : []);
}

/**
 * The joints the validator's contact rule judges, from the authoring block: the declared `joints`,
 * then every pair of distinct slots across a welded or overlap connection (a slot is on a chain when
 * its bone, or a bone of its domain, is in the chain; membrane connections blend instead and are
 * not contact joints). Empty without an authoring block.
 */
export function authoringJoints(doc: AnimDocument): RigJoint[] {
  const block = doc.authoring;
  if (!block) return [];
  const out: RigJoint[] = (block.joints ?? []).map((j) => ({ parent: j.parent, child: j.child, ...(j.pivotBone === undefined ? {} : { pivotBone: j.pivotBone }), ...(j.radius === undefined ? {} : { radius: j.radius }) }));
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const seen = new Set(out.map((j) => pairKey(j.parent, j.child)));
  const slotsOn = (bones: readonly string[]) =>
    doc.slots
      .filter((slot) => bones.includes(slot.bone) || (block.domains ?? []).some((d) => d.slot === slot.name && d.bones.some((b) => bones.includes(b))))
      .map((slot) => slot.name);
  for (const connection of block.connections ?? []) {
    if (connection.kind === "membrane") continue;
    const [a, b] = connection.between.map((id) => slotsOn(chainBones(doc, id))) as [string[], string[]];
    for (const parent of a) {
      for (const child of b) {
        const key = pairKey(parent, child);
        if (parent === child || seen.has(key)) continue;
        seen.add(key);
        out.push({ parent, child });
      }
    }
  }
  return out;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Weighted meshes of the document: address, bone table and per-vertex bone indices. */
function weightedMeshes(doc: AnimDocument): { where: string; skin: string; slot: string; name: string; bones: string[]; vertices: number[][] }[] {
  const out: { where: string; skin: string; slot: string; name: string; bones: string[]; vertices: number[][] }[] = [];
  for (const [skin, data] of Object.entries(doc.skins)) {
    for (const [slot, attachments] of Object.entries(data.attachments)) {
      for (const [name, attachment] of Object.entries(attachments)) {
        const mesh = attachment as { type?: string; bones?: string[]; vertices?: number[] };
        if (mesh.type !== "mesh" || !mesh.bones || mesh.bones.length === 0 || !Array.isArray(mesh.vertices)) continue;
        // Weighted encoding: per vertex n, then n groups of (influence, x, y, weight).
        const vertices: number[][] = [];
        for (let at = 0; at < mesh.vertices.length; ) {
          const count = mesh.vertices[at] as number;
          const influences: number[] = [];
          for (let k = 0; k < count; k++) if ((mesh.vertices[at + 1 + k * 4 + 3] as number) > 0) influences.push(mesh.vertices[at + 1 + k * 4] as number);
          vertices.push(influences);
          at += 1 + count * 4;
        }
        out.push({ where: `${skin}/${slot}/${name}`, skin, slot, name, bones: mesh.bones, vertices });
      }
    }
  }
  return out;
}

/** Checks the authoring block against the skeleton, the slots and the weights. */
export function validateAuthoring(doc: AnimDocument): AuthoringIssue[] {
  const block = doc.authoring;
  if (!block) return [];
  const issues: AuthoringIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const warn = (message: string) => issues.push({ severity: "warning", message });
  const parentOf = new Map(doc.bones.map((b) => [b.name, b.parent]));
  const known = (bone: string) => parentOf.has(bone);
  const chains = block.chains ?? [];
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  const ancestors = (bone: string) => {
    const out: string[] = [];
    for (let at = parentOf.get(bone); at !== undefined; at = parentOf.get(at)) out.push(at);
    return out;
  };
  for (const chain of chains) {
    if (ids.has(chain.id)) error(`chain '${chain.id}' is declared twice`);
    ids.add(chain.id);
    chain.bones.forEach((bone, k) => {
      if (!known(bone)) return error(`chain '${chain.id}': no bone '${bone}'`);
      const other = owner.get(bone);
      if (other !== undefined) error(`bone '${bone}' is in chains '${other}' and '${chain.id}': a bone belongs to one chain`);
      owner.set(bone, chain.id);
      if (k > 0 && parentOf.get(bone) !== chain.bones[k - 1]) error(`chain '${chain.id}' is not ordered: '${bone}' is not a child of '${chain.bones[k - 1]}'`);
    });
  }
  const byId = new Map(chains.map((c) => [c.id, c]));
  for (const chain of chains) {
    if (chain.parent === undefined) continue;
    const parent = byId.get(chain.parent);
    if (!parent) {
      error(`chain '${chain.id}': parent chain '${chain.parent}' is not declared`);
      continue;
    }
    // Branch boundary: the chain's first bone hangs (through non-chain bones at most) from a bone of the parent chain.
    const first = chain.bones[0] as string;
    const up = ancestors(first);
    const hub = up.find((b) => owner.has(b));
    if (hub === undefined || owner.get(hub) !== parent.id) error(`chain '${chain.id}' branches from '${chain.parent}' but its first bone '${first}' hangs from ${hub ? `'${hub}' of chain '${owner.get(hub)}'` : "no chain"}`);
  }
  const symmetry = new Map<string, Chain[]>();
  for (const chain of chains) if (chain.symmetry) symmetry.set(chain.symmetry, [...(symmetry.get(chain.symmetry) ?? []), chain]);
  for (const [group, members] of symmetry) {
    if (members.length < 2) warn(`symmetry group '${group}' has one chain`);
    // Twins pair in listed order; an odd member has no twin and is never mirrored.
    else if (members.length % 2 === 1) warn(`symmetry group '${group}' has ${members.length} chains (odd): '${(members[members.length - 1] as Chain).id}' has no twin`);
    const counts = new Set(members.map((c) => c.bones.length));
    if (counts.size > 1) error(`symmetry group '${group}': chains have different bone counts (${members.map((c) => `${c.id} ${c.bones.length}`).join(", ")})`);
  }
  // Declared chains replace inference for their bones; an uncovered deforming bone is posed only by
  // an inferred fallback chain, so it is reported.
  if (chains.length > 0) {
    const unchained = [...deformingBones(doc)].filter((bone) => !owner.has(bone)).sort();
    if (unchained.length > 0) warn(`deforming bone(s) outside every declared chain (posed only by inferred fallback chains; declare them): ${unchained.map((b) => `'${b}'`).join(", ")}`);
  }

  // Domains: references, and the weights stay inside them.
  const meshes = weightedMeshes(doc);
  for (const domain of block.domains ?? []) {
    if (!doc.slots.some((s) => s.name === domain.slot)) error(`domain '${domain.id}': no slot '${domain.slot}'`);
    for (const bone of domain.bones) if (!known(bone)) error(`domain '${domain.id}': no bone '${bone}'`);
    for (const t of domain.transitions ?? []) for (const bone of t.bones) if (!domain.bones.includes(bone)) error(`domain '${domain.id}': transition bone '${bone}' is not an allowed influence`);
    for (const bone of Object.keys(domain.radius ?? {})) if (!domain.bones.includes(bone)) error(`domain '${domain.id}': radius for '${bone}', which is not an allowed influence`);
    const allowed = new Set(domain.bones);
    for (const mesh of meshes) {
      if (domainFor(doc, mesh) !== domain) continue;
      const outside = new Map<string, number>();
      for (const v of mesh.vertices) for (const index of v) {
        const bone = mesh.bones[index];
        if (bone !== undefined && !allowed.has(bone)) outside.set(bone, (outside.get(bone) ?? 0) + 1);
      }
      for (const [bone, count] of outside) error(`domain '${domain.id}': ${mesh.where} has ${count} influence(s) from '${bone}', outside the domain`);
    }
  }

  // Connections: references; overlap forbids any vertex weighted from both sides.
  for (const connection of block.connections ?? []) {
    const [a, b] = connection.between.map((id) => chainBones(doc, id)) as [string[], string[]];
    connection.between.forEach((id, k) => {
      if ((k === 0 ? a : b).length === 0) error(`connection ${connection.between.join(" - ")}: '${id}' is no chain or bone`);
    });
    if (connection.kind === "overlap" && a.length > 0 && b.length > 0) {
      for (const mesh of meshes) {
        let crossing = 0;
        for (const v of mesh.vertices) {
          const names = v.map((index) => mesh.bones[index]);
          if (names.some((n) => n !== undefined && a.includes(n)) && names.some((n) => n !== undefined && b.includes(n))) crossing++;
        }
        if (crossing > 0) error(`connection ${connection.between.join(" - ")} is overlap, but ${crossing} vertex(es) of ${mesh.where} are weighted from both`);
      }
    }
  }

  // Joints: slot and pivot references.
  for (const joint of block.joints ?? []) {
    for (const slot of [joint.parent, joint.child]) if (!doc.slots.some((s) => s.name === slot)) error(`joint ${joint.parent} - ${joint.child}: no slot '${slot}'`);
    if (joint.pivotBone !== undefined && !known(joint.pivotBone)) error(`joint ${joint.parent} - ${joint.child}: no pivot bone '${joint.pivotBone}'`);
    if ((joint.pivotBone === undefined) !== (joint.radius === undefined)) warn(`joint ${joint.parent} - ${joint.child}: a ball-and-socket joint needs both pivotBone and radius`);
  }

  // Probes: references and the shape each kind needs.
  for (const probe of block.probes ?? []) {
    const where = `probe '${probe.name}'`;
    if (probe.kind === "attachment") {
      if (!doc.slots.some((s) => s.name === probe.slot)) error(`${where}: no slot '${probe.slot}'`);
      continue;
    }
    if (probe.kind === "relative") {
      for (const id of probe.chains) if (chainBones(doc, id).length === 0) error(`${where}: no chain '${id}'`);
      continue;
    }
    for (const bone of probe.bones ?? []) if (!known(bone)) error(`${where}: no bone '${bone}'`);
    if (probe.chain !== undefined && chainBones(doc, probe.chain).length === 0) error(`${where}: no chain '${probe.chain}'`);
    const bones = probeBones(doc, probe);
    if (bones.length === 0) error(`${where}: a ${probe.kind} probe needs bones or a chain`);
    if (probe.kind === "wave" && bones.length < 3) error(`${where}: a travelling wave needs a chain of three or more bones`);
  }
  return issues;
}
