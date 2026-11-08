/*
 * Atlas Animator: original implementation.
 *
 * Cross-reference rules of `atlas-anim@1` that a per-field schema cannot express: names resolve,
 * bones are listed parents-first, keys are sorted and inside their clip, deform data fits its
 * mesh, draw-order changes stay inside the slot list. Every issue carries the document path of
 * the offending value so a loader error points straight at it. Phase adds mesh groups,
 * contours, coverage regions and driven grids.
 */
import type {
  AnimDocument,
  AttachmentData,
  ClipData,
  MeshAttachmentData
} from "./format.js";
import { springStability } from "./physicsConstraint.js";
import { resolveSetupDrawOrder } from "./drawOrder.js";
import { meshDeformLength, meshVertexCount, type ContourData, type TriangleRanges } from "./format.js";

export type IssuePath = readonly (string | number)[];

/**
 * "error": the document cannot be used. "warning": the document loads and the runtime has a
 * defined fallback, typical of a rig that is still being edited (plan 4.4, loader severities).
 */
export type IssueSeverity = "error" | "warning";

export interface FormatIssue {
  path: IssuePath;
  message: string;
  severity: IssueSeverity;
}

/** Returns every cross-reference problem in a structurally valid document (empty = clean). */
export function findReferenceIssues(doc: AnimDocument): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const report: Report = (path, message, severity = "error") => issues.push({ path, message, severity });
  const index = buildIndex(doc, report);

  checkBones(doc, report);
  checkSlots(doc, index, report);
  checkSkins(doc, index, report);
  checkConstraints(doc, index, report);
  checkDriven(doc, index, report);
  checkDrivenGrids(doc, report, index);
  checkPoseLimits(doc, report, index);
  for (const [name, clip] of Object.entries(doc.animations)) checkClip(name, clip, doc, index, report);
  if (doc.atlas) reportDuplicates(doc.atlas.pages, ["atlas", "pages"], "atlas page", report);
  return issues;
}

type Report = (path: IssuePath, message: string, severity?: IssueSeverity) => void;

interface DocumentIndex {
  bones: Map<string, number>;
  slots: Map<string, number>;
  ik: Set<string>;
  transform: Set<string>;
  path: Set<string>;
  physics: Set<string>;
  /**
   * Unanchored slot -> position among the unanchored slots in setup draw order (the list that
   * draw-order offsets permute, see AnchoredDrawOrder).
   */
  drawPosition: Map<string, number>;
  /** slot -> every placeholder name any skin defines for it. */
  placeholders: Map<string, Set<string>>;
  /** Slots with drawAfter or drawBefore (they have no draw position of their own). */
  anchored: Set<string>;
}

function buildIndex(doc: AnimDocument, report: Report): DocumentIndex {
  const bones = new Map<string, number>();
  doc.bones.forEach((bone, i) => {
    if (bones.has(bone.name)) report(["bones", i, "name"], `duplicate bone name '${bone.name}'`);
    else bones.set(bone.name, i);
  });
  const slots = new Map<string, number>();
  doc.slots.forEach((slot, i) => {
    if (slots.has(slot.name)) report(["slots", i, "name"], `duplicate slot name '${slot.name}'`);
    else slots.set(slot.name, i);
  });

  // Constraint names share one namespace because skins list them by name.
  const constraintNames = new Set<string>();
  const collect = (kind: "ik" | "transform" | "path" | "physics"): Set<string> => {
    const names = new Set<string>();
    doc[kind].forEach((constraint, i) => {
      if (constraintNames.has(constraint.name)) {
        report([kind, i, "name"], `duplicate constraint name '${constraint.name}' (ik, transform, path and physics share one namespace)`);
      }
      constraintNames.add(constraint.name);
      names.add(constraint.name);
    });
    return names;
  };
  const ik = collect("ik");
  const transform = collect("transform");
  const path = collect("path");
  const physics = collect("physics");

  const placeholders = new Map<string, Set<string>>();
  for (const skin of Object.values(doc.skins)) {
    for (const [slot, attachments] of Object.entries(skin.attachments)) {
      let names = placeholders.get(slot);
      if (!names) placeholders.set(slot, (names = new Set()));
      for (const name of Object.keys(attachments)) names.add(name);
    }
  }
  const anchored = new Set(doc.slots.filter((slot) => slot.drawAfter !== undefined || slot.drawBefore !== undefined).map((slot) => slot.name));
  const drawPosition = new Map<string, number>();
  for (const slot of doc.drawOrder ?? doc.slots.map((s) => s.name)) {
    if (slots.has(slot) && !anchored.has(slot) && !drawPosition.has(slot)) drawPosition.set(slot, drawPosition.size);
  }
  for (const slot of doc.slots) {
    if (!anchored.has(slot.name) && !drawPosition.has(slot.name)) drawPosition.set(slot.name, drawPosition.size);
  }
  return { bones, slots, ik, transform, path, physics, drawPosition, placeholders, anchored };
}

function checkBones(doc: AnimDocument, report: Report): void {
  const seen = new Map<string, { index: number; skin: boolean }>();
  doc.bones.forEach((bone, i) => {
    if (bone.parent !== undefined) {
      const parent = seen.get(bone.parent);
      if (!parent) {
        const later = doc.bones.some((other, j) => j > i && other.name === bone.parent);
        report(
          ["bones", i, "parent"],
          later
            ? `parent '${bone.parent}' must be listed before '${bone.name}' (bones are parents-first)`
            : `unknown parent bone '${bone.parent}'`
        );
      } else if (parent.skin && !bone.skin) {
        report(["bones", i, "skin"], `'${bone.name}' must be a skin bone because its parent '${bone.parent}' is one`);
      }
    }
    if (!seen.has(bone.name)) seen.set(bone.name, { index: i, skin: bone.skin });
  });
}

function checkSlots(doc: AnimDocument, index: DocumentIndex, report: Report): void {
  const anchorOf = new Map(doc.slots.map((slot) => [slot.name, slot.drawAfter ?? slot.drawBefore] as const));
  doc.slots.forEach((slot, i) => {
    if (!index.bones.has(slot.bone)) report(["slots", i, "bone"], `unknown bone '${slot.bone}'`);
    const anchor = slot.drawAfter ?? slot.drawBefore;
    if (anchor !== undefined) {
      const field = slot.drawAfter !== undefined ? "drawAfter" : "drawBefore";
      if (anchor === slot.name) report(["slots", i, field], `slot '${slot.name}' cannot be anchored to itself`);
      else if (!index.slots.has(anchor)) report(["slots", i, field], `unknown slot '${anchor}'`);
      else {
        // Follow the anchor chain; reaching this slot again is a cycle.
        const seen = new Set<string>([slot.name]);
        for (let next: string | undefined = anchor; next !== undefined; next = anchorOf.get(next)) {
          if (next === slot.name) {
            report(["slots", i, field], `anchor chain from '${slot.name}' loops back to it (${[...seen, next].join(" -> ")})`);
            break;
          }
          if (seen.has(next)) break; // a cycle further along, reported on its own slots
          seen.add(next);
        }
      }
    }
    if (slot.attachment !== null && !index.placeholders.get(slot.name)?.has(slot.attachment)) {
      report(
        ["slots", i, "attachment"],
        `no skin defines attachment '${slot.attachment}' for slot '${slot.name}' (nothing is drawn)`,
        "warning"
      );
    }
  });
  if (doc.drawOrder) {
    const seen = new Set<string>();
    doc.drawOrder.forEach((slot, i) => {
      if (!index.slots.has(slot)) report(["drawOrder", i], `unknown slot '${slot}'`);
      else if (seen.has(slot)) report(["drawOrder", i], `slot '${slot}' is listed twice`);
      seen.add(slot);
    });
    for (const slot of doc.slots) {
      if (!seen.has(slot.name)) {
        report(["drawOrder"], `slot '${slot.name}' is missing from the draw order (drawn last, in slot order)`, "warning");
      }
    }
    // Anchored slots are drawn at their anchors; a list position elsewhere is ignored.
    if (index.anchored.size > 0 && !issuesAreErrors(doc, index)) {
      const resolved = resolveSetupDrawOrder(doc.slots, doc.drawOrder);
      const listed = doc.drawOrder.filter((slot) => index.slots.has(slot));
      const missing = doc.slots.filter((slot) => !seen.has(slot.name)).map((slot) => slot.name);
      const written = [...listed, ...missing];
      // Compare each anchored slot's neighbour on its anchor side, so one misplaced slot is
      // reported once instead of shifting every position after it.
      const neighbour = (list: readonly string[], slot: string, after: boolean) => list[list.indexOf(slot) + (after ? -1 : 1)];
      doc.drawOrder.forEach((slot, i) => {
        if (!index.anchored.has(slot)) return;
        const data = doc.slots[index.slots.get(slot) as number];
        const after = data?.drawAfter !== undefined;
        if (neighbour(written, slot, after) !== neighbour(resolved, slot, after)) {
          const anchor = data?.drawAfter ?? data?.drawBefore;
          report(["drawOrder", i], `anchored slot '${slot}' is drawn next to its anchor '${anchor}', not at this position`, "warning");
        }
      });
    }
  }
}

/** True when the draw-order data is too broken for the anchored resolution to be meaningful. */
function issuesAreErrors(doc: AnimDocument, index: DocumentIndex): boolean {
  if (!doc.drawOrder || new Set(doc.drawOrder).size !== doc.drawOrder.length) return true;
  if (doc.drawOrder.some((slot) => !index.slots.has(slot))) return true;
  // Unknown anchors or anchor cycles are reported by checkSlots.
  const anchorOf = new Map(doc.slots.map((slot) => [slot.name, slot.drawAfter ?? slot.drawBefore] as const));
  for (const slot of index.anchored) {
    const seen = new Set<string>();
    for (let next: string | undefined = slot; next !== undefined; next = anchorOf.get(next)) {
      if (seen.has(next) || !index.slots.has(next)) return true;
      seen.add(next);
    }
  }
  return false;
}

function checkSkins(doc: AnimDocument, index: DocumentIndex, report: Report): void {
  const constraintExists = (name: string) => index.ik.has(name) || index.transform.has(name) || index.path.has(name) || index.physics.has(name);
  for (const [skinName, skin] of Object.entries(doc.skins)) {
    const base = ["skins", skinName] as const;
    for (const [slot, attachments] of Object.entries(skin.attachments)) {
      if (!index.slots.has(slot)) report([...base, "attachments", slot], `unknown slot '${slot}'`);
      for (const [name, attachment] of Object.entries(attachments)) {
        checkAttachment(attachment, [...base, "attachments", slot, name], doc, index, report);
        if (attachment.type === "clipping" && attachment.end !== undefined) {
          const endPath = [...base, "attachments", slot, name, "end"];
          if (!index.slots.has(attachment.end)) report(endPath, `unknown end slot '${attachment.end}'`);
          else {
            const from = index.drawPosition.get(slot);
            const to = index.drawPosition.get(attachment.end);
            if (from !== undefined && to !== undefined && to < from) report(endPath, `end slot '${attachment.end}' is drawn before the clipping slot '${slot}': the mask clips nothing`, "warning");
          }
        }
        if (attachment.type === "mesh" && attachment.groups) checkGroups(slot, attachment.groups, [...base, "attachments", slot, name, "groups"], doc, index, report);
        if (attachment.type === "mesh" && attachment.embed) {
          const embed = attachment.embed;
          const path = [...base, "attachments", slot, name, "embed"];
          const source = skin.attachments[embed.slot]?.[embed.attachment];
          const where = `${skinName}/${embed.slot}/${embed.attachment}`;
          if (!source) report(path, `embed source '${where}' does not exist`);
          else if (source.type !== "mesh") report(path, `embed source '${where}' is a ${source.type}; embedded vertices pose from a mesh`);
          else if (source.embed) report(path, `embed source '${where}' embeds vertices itself (one level only)`);
          else {
            const count = meshVertexCount(source);
            embed.points.forEach((point, i) => {
              const refs = typeof point === "number" ? [point] : point.slice(0, 3);
              const bad = refs.find((vertex) => vertex >= count);
              if (bad !== undefined) report([...path, "points", i], `vertex index ${bad} is out of range (mesh '${where}' has ${count} vertices)`);
            });
          }
        }
      }
    }
    for (const [slot, contours] of Object.entries(skin.contours ?? {})) {
      if (!index.slots.has(slot)) report([...base, "contours", slot], `unknown owner slot '${slot}'`);
      for (const [name, contour] of Object.entries(contours)) checkContour(skinName, contour, [...base, "contours", slot, name], doc, index, report);
    }
    if (skin.coverage) {
      for (const [name, region] of Object.entries(skin.coverage.regions)) {
        const path = [...base, "coverage", "regions", name] as const;
        const mesh = skin.attachments[region.mesh.slot]?.[region.mesh.attachment];
        if (!mesh) report([...path, "mesh"], `mesh '${skinName}/${region.mesh.slot}/${region.mesh.attachment}' does not exist`);
        else if (mesh.type !== "mesh") report([...path, "mesh"], `'${skinName}/${region.mesh.slot}/${region.mesh.attachment}' is a ${mesh.type}; coverage regions are triangles of a mesh`);
        else checkRanges(region.triangles, mesh.triangles.length / 3, [...path, "triangles"], report);
      }
      skin.coverage.covers.forEach((cover, i) => {
        const target = doc.skins[cover.skin];
        if (!target) report([...base, "coverage", "covers", i, "skin"], `unknown skin '${cover.skin}'`);
        else if (!target.coverage?.regions[cover.region]) report([...base, "coverage", "covers", i, "region"], `skin '${cover.skin}' declares no coverage region '${cover.region}'`);
      });
    }
    skin.hides.forEach((slot, i) => {
      if (!index.slots.has(slot)) report([...base, "hides", i], `unknown slot '${slot}'`);
    });
    skin.bones.forEach((bone, i) => {
      if (!index.bones.has(bone)) report([...base, "bones", i], `unknown bone '${bone}'`);
    });
    skin.constraints.forEach((name, i) => {
      if (!constraintExists(name)) report([...base, "constraints", i], `unknown constraint '${name}'`);
    });
    reportDuplicates(skin.bones, [...base, "bones"], "bone", report);
    reportDuplicates(skin.constraints, [...base, "constraints"], "constraint", report);
  }
}

function checkAttachment(
  attachment: AttachmentData,
  path: IssuePath,
  doc: AnimDocument,
  index: DocumentIndex,
  report: Report
): void {
  if ((attachment.type === "mesh" || attachment.type === "path") && attachment.bones) {
    attachment.bones.forEach((bone, i) => {
      if (!index.bones.has(bone)) report([...path, "bones", i], `unknown bone '${bone}'`);
    });
  } else if (attachment.type === "linkedMesh") {
    const { skin, slot, attachment: name } = attachment.source;
    const source = doc.skins[skin]?.attachments[slot]?.[name];
    if (!source) report([...path, "source"], `source mesh '${skin}/${slot}/${name}' does not exist`);
    else if (source.type !== "mesh") {
      report([...path, "source"], `source '${skin}/${slot}/${name}' is a ${source.type}; a linked mesh must link a mesh`);
    }
  }
}

function checkRanges(ranges: TriangleRanges, triangleCount: number, path: IssuePath, report: Report): void {
  ranges.forEach(([start, end], i) => {
    if (!(start < end) || end > triangleCount) report([...path, i], `range [${start}, ${end}) must satisfy start < end <= triangle count ${triangleCount}`);
  });
}

function checkGroups(
  owner: string,
  groups: Record<string, TriangleRanges>,
  path: IssuePath,
  doc: AnimDocument,
  index: DocumentIndex,
  report: Report
): void {
  for (const slot of Object.keys(groups)) {
    if (!index.slots.has(slot)) {
      report([...path, slot], `unknown slot '${slot}'`);
      continue;
    }
    const data = doc.slots[index.slots.get(slot) as number];
    if (slot !== owner && data && data.attachment !== null) {
      report([...path, slot], `group slot '${slot}' also shows its own attachment '${data.attachment}'; while the group draws it replaces that attachment`, "warning");
    }
  }
}

function checkContour(skin: string, contour: ContourData, path: IssuePath, doc: AnimDocument, index: DocumentIndex, report: Report): void {
  if (contour.mesh && contour.points) {
    const meshSkin = contour.mesh.skin ?? skin;
    const target = doc.skins[meshSkin]?.attachments[contour.mesh.slot]?.[contour.mesh.attachment];
    const where = `${meshSkin}/${contour.mesh.slot}/${contour.mesh.attachment}`;
    if (!target) report([...path, "mesh"], `mesh '${where}' does not exist`);
    else if (target.type !== "mesh") report([...path, "mesh"], `'${where}' is a ${target.type}; contours bind to a mesh (link swag to the body mesh instead)`);
    else {
      const count = meshVertexCount(target);
      contour.points.forEach((point, i) => {
        const refs = typeof point === "number" ? [point] : point.slice(0, 3);
        const bad = refs.find((vertex) => vertex >= count);
        if (bad !== undefined) report([...path, "points", i], `vertex index ${bad} is out of range (mesh '${where}' has ${count} vertices)`);
      });
    }
  }
  contour.bones?.forEach((bone, i) => {
    if (!index.bones.has(bone)) report([...path, "bones", i], `unknown bone '${bone}'`);
  });
  contour.visible.forEach((rule, i) => {
    if (!index.bones.has(rule.bone)) report([...path, "visible", i, "bone"], `unknown bone '${rule.bone}'`);
  });
  if (contour.owner) {
    const where = `${contour.owner.skin ?? skin}/${contour.owner.slot}/${contour.owner.attachment}`;
    if (!index.slots.has(contour.owner.slot)) report([...path, "owner", "slot"], `unknown slot '${contour.owner.slot}'`);
    else if (!doc.skins[contour.owner.skin ?? skin]?.attachments[contour.owner.slot]?.[contour.owner.attachment]) report([...path, "owner"], `owner attachment '${where}' does not exist`);
  }
}

function checkConstraints(doc: AnimDocument, index: DocumentIndex, report: Report): void {
  const parentOf = (name: string) => doc.bones[index.bones.get(name) ?? -1]?.parent;
  const isBelow = (bone: string, ancestor: string): boolean => {
    const visited = new Set<string>();
    for (let b = parentOf(bone); b !== undefined && !visited.has(b); b = parentOf(b)) {
      if (b === ancestor) return true;
      visited.add(b);
    }
    return false;
  };
  const checkBoneList = (bones: readonly string[], target: string | null, path: IssuePath) => {
    bones.forEach((bone, i) => {
      if (!index.bones.has(bone)) report([...path, "bones", i], `unknown bone '${bone}'`);
    });
    reportDuplicates(bones, [...path, "bones"], "bone", report);
    // When one constrained bone is below another, every bone between them must be constrained
    // too and listed parents-first, so the solver can walk the chain in list order and no
    // unlisted bone in the middle is left stale (see updateOrder.ts).
    bones.forEach((bone, i) => {
      const listedAncestor = bones.find((other, j) => j !== i && isBelow(bone, other));
      if (listedAncestor === undefined) return;
      const parent = parentOf(bone);
      const parentPosition = parent === undefined ? -1 : bones.indexOf(parent);
      if (parentPosition < 0) {
        report([...path, "bones", i], `'${bone}' is below '${listedAncestor}' in this constraint, so its parent '${parent}' must be listed too`);
      } else if (parentPosition > i) {
        report([...path, "bones", i], `'${bone}' must be listed after its parent '${parent}' (parents first)`);
      }
    });
    if (target === null) return;
    if (!index.bones.has(target)) report([...path, "target"], `unknown bone '${target}'`);
    else if (bones.includes(target)) report([...path, "target"], `target '${target}' is also constrained by this constraint`);
    else {
      const above = bones.find((bone) => isBelow(target, bone));
      if (above !== undefined) {
        report([...path, "target"], `target '${target}' is below constrained bone '${above}', so it would move after being read`);
      }
    }
  };

  doc.ik.forEach((ik, i) => {
    checkBoneList(ik.bones, ik.target, ["ik", i]);
    const [parent, child] = ik.bones;
    if (parent !== undefined && child !== undefined && index.bones.has(child) && parentOf(child) !== parent) {
      report(["ik", i, "bones", 1], `two-bone IK needs '${child}' to be a direct child of '${parent}'`);
    }
  });
  doc.transform.forEach((transform, i) => checkBoneList(transform.bones, transform.target, ["transform", i]));
  doc.path.forEach((constraint, i) => {
    checkBoneList(constraint.bones, null, ["path", i]);
    if (!index.slots.has(constraint.target)) report(["path", i, "target"], `unknown slot '${constraint.target}'`);
    else if (!(index.placeholders.get(constraint.target) ?? new Set<string>()).size || !Object.values(doc.skins).some((skin) => Object.values(skin.attachments[constraint.target] ?? {}).some((a) => a.type === "path"))) {
      report(["path", i, "target"], `slot '${constraint.target}' has no path attachment in any skin, so the constraint does nothing`, "warning");
    }
    const slotBone = doc.slots[index.slots.get(constraint.target) ?? -1]?.bone;
    const above = slotBone === undefined ? undefined : constraint.bones.find((bone) => bone === slotBone || isBelow(slotBone, bone));
    if (above !== undefined) report(["path", i, "target"], `the path's slot sits on '${slotBone}', which is constrained by this constraint (or below '${above}'), so the path would move after being read`);
  });
  doc.physics.forEach((physics, i) => {
    if (!index.bones.has(physics.bone)) report(["physics", i, "bone"], `unknown bone '${physics.bone}'`);
    // Spring stability for our integrator, mass and step size included (runtime contract F7; see
    // springStability): s = strength * h^2 / mass must stay below 2 (1 + damping^(60 h)).
    const { s, bound } = springStability(physics);
    if (!(s < bound)) {
      report(
        ["physics", i, "strength"],
        `strength * h^2 / mass = ${s.toPrecision(4)} (h = 1/fps) reaches the spring's stability bound 2 (1 + damping^(60 h)) = ${bound.toPrecision(4)}; the simulation is unstable (lower strength, raise mass or raise fps)`
      );
    } else if (physics.strength / physics.mass > physics.fps * physics.fps) {
      report(
        ["physics", i, "strength"],
        `strength / mass ${physics.strength / physics.mass} exceeds fps^2 (${physics.fps * physics.fps}); the spring rings at the step rate (raise fps, raise mass or lower strength)`,
        "warning"
      );
    }
    const bone = doc.bones.find((b) => b.name === physics.bone);
    if (bone && bone.length === 0 && (physics.rotate > 0 || physics.scaleX > 0 || physics.shearX > 0)) {
      report(
        ["physics", i, "bone"],
        `bone '${physics.bone}' has no length, so rotate, scaleX and shearX get no lever (only the springs act; give the bone a length)`,
        "warning"
      );
    }
  });
}

function checkDriven(doc: AnimDocument, index: DocumentIndex, report: Report): void {
  const names = new Set<string>();
  doc.driven.forEach((driven, i) => {
    const base = ["driven", i] as const;
    if (names.has(driven.name)) report([...base, "name"], `duplicate driven key set '${driven.name}'`);
    names.add(driven.name);
    if (!index.bones.has(driven.bone)) report([...base, "bone"], `unknown bone '${driven.bone}'`);
    if (driven.skin !== undefined && !(driven.skin in doc.skins)) report([...base, "skin"], `unknown skin '${driven.skin}'`);
    driven.keys.forEach((key, k) => {
      const keyPath = [...base, "keys", k] as const;
      for (const [skin, slots] of Object.entries(key.deform)) {
        for (const [slot, attachments] of Object.entries(slots)) {
          for (const [name, values] of Object.entries(attachments)) {
            checkDeformTarget(doc, skin, slot, name, [...keyPath, "deform", skin, slot, name], report, [
              { offset: values.offset, length: values.vertices.length, path: [...keyPath, "deform", skin, slot, name, "vertices"] }
            ]);
          }
        }
      }
      checkDrawOrderOffsets(key.drawOrder, [...keyPath, "drawOrder"], index, report);
      for (const [slot, name] of Object.entries(key.attachments)) {
        checkAttachmentKey(slot, name, [...keyPath, "attachments", slot], index, report);
      }
      for (const slot of Object.keys(key.alpha)) {
        if (!index.slots.has(slot)) report([...keyPath, "alpha", slot], `unknown slot '${slot}'`);
      }
    });
  });
}

function checkPoseLimits(doc: AnimDocument, report: Report, index: DocumentIndex): void {
  (doc.poseLimits ?? []).forEach((limit, i) => {
    for (const axis of ["x", "y"] as const) {
      if (!index.bones.has(limit[axis])) report(["poseLimits", i, axis], `unknown bone '${limit[axis]}'`);
    }
    (limit.plus ?? []).forEach((b, k) => {
      if (!index.bones.has(b)) report(["poseLimits", i, "plus", k], `unknown bone '${b}'`);
    });
  });
}

function checkDrivenGrids(doc: AnimDocument, report: Report, index: DocumentIndex): void {
  const names = new Set<string>();
  (doc.drivenGrids ?? []).forEach((grid, i) => {
    const base = ["drivenGrids", i] as const;
    if (names.has(grid.name)) report([...base, "name"], `duplicate driven grid '${grid.name}'`);
    names.add(grid.name);
    for (const axis of ["x", "y"] as const) {
      if (!index.bones.has(grid[axis].bone)) report([...base, axis, "bone"], `unknown bone '${grid[axis].bone}'`);
    }
    if (grid.x.bone === grid.y.bone) report([...base, "y", "bone"], `both axes are driven by '${grid.x.bone}'; a one-bone correction is a driven set`);
    if (grid.skin !== undefined && !(grid.skin in doc.skins)) report([...base, "skin"], `unknown skin '${grid.skin}'`);
    grid.keys.forEach((key, k) => {
      for (const [skin, slots] of Object.entries(key.deform)) {
        for (const [slot, attachments] of Object.entries(slots)) {
          for (const [name, values] of Object.entries(attachments)) {
            const path = [...base, "keys", k, "deform", skin, slot, name] as const;
            checkDeformTarget(doc, skin, slot, name, path, report, [{ offset: values.offset, length: values.vertices.length, path: [...path, "vertices"] }]);
          }
        }
      }
    });
  });
}

function checkClip(name: string, clip: ClipData, doc: AnimDocument, index: DocumentIndex, report: Report): void {
  const base = ["animations", name] as const;
  const checkKeys = (keys: readonly { time: number }[], path: IssuePath, strict = true) => {
    keys.forEach((key, i) => {
      if (key.time > clip.duration) {
        report([...path, i, "time"], `key time ${key.time} is after the clip duration ${clip.duration}`);
      }
      const previous = keys[i - 1];
      if (previous && (strict ? key.time <= previous.time : key.time < previous.time)) {
        report([...path, i, "time"], `keys must be sorted by ${strict ? "strictly " : ""}increasing time (${key.time} after ${previous.time})`);
      }
    });
  };

  for (const [bone, timelines] of Object.entries(clip.bones)) {
    if (!index.bones.has(bone)) report([...base, "bones", bone], `unknown bone '${bone}'`);
    for (const [property, keys] of Object.entries(timelines)) {
      if (keys) checkKeys(keys, [...base, "bones", bone, property]);
    }
  }
  for (const [slot, timelines] of Object.entries(clip.slots)) {
    if (!index.slots.has(slot)) report([...base, "slots", slot], `unknown slot '${slot}'`);
    if (timelines.color) checkKeys(timelines.color, [...base, "slots", slot, "color"]);
    if (timelines.sequence) {
      const path = [...base, "slots", slot, "sequence"] as const;
      checkKeys(timelines.sequence, path);
      const counts: number[] = [];
      for (const skin of Object.values(doc.skins)) {
        for (const a of Object.values(skin.attachments[slot] ?? {})) if ((a.type === "region" || a.type === "mesh" || a.type === "linkedMesh") && a.sequence) counts.push(a.sequence.count);
      }
      if (counts.length === 0) report(path, `slot '${slot}' has no image-sequence attachment`);
      else {
        const most = Math.max(...counts);
        timelines.sequence.forEach((key, i) => {
          if (key.index >= most) report([...path, i, "index"], `frame ${key.index} is outside the ${most} frames of the sequence`);
        });
      }
    }
    if (timelines.attachment) {
      const path = [...base, "slots", slot, "attachment"] as const;
      checkKeys(timelines.attachment, path);
      timelines.attachment.forEach((key, i) => {
        if (index.slots.has(slot)) checkAttachmentKey(slot, key.name, [...path, i, "name"], index, report);
      });
    }
  }
  for (const [kind, known] of [["ik", index.ik], ["transform", index.transform]] as const) {
    for (const [constraint, keys] of Object.entries(clip[kind])) {
      if (!known.has(constraint)) report([...base, kind, constraint], `unknown ${kind} constraint '${constraint}'`);
      checkKeys(keys, [...base, kind, constraint]);
    }
  }
  for (const [constraint, keys] of Object.entries(clip.path)) {
    if (!index.path.has(constraint)) report([...base, "path", constraint], `unknown path constraint '${constraint}'`);
    checkKeys(keys, [...base, "path", constraint]);
  }
  for (const [constraint, timelines] of Object.entries(clip.physics)) {
    if (!index.physics.has(constraint)) report([...base, "physics", constraint], `unknown physics constraint '${constraint}'`);
    if (timelines.mix) checkKeys(timelines.mix, [...base, "physics", constraint, "mix"]);
    if (timelines.reset) checkKeys(timelines.reset, [...base, "physics", constraint, "reset"]);
  }
  for (const [skin, slots] of Object.entries(clip.deform)) {
    for (const [slot, attachments] of Object.entries(slots)) {
      for (const [attachment, keys] of Object.entries(attachments)) {
        const path = [...base, "deform", skin, slot, attachment] as const;
        checkKeys(keys, path);
        checkDeformTarget(
          doc,
          skin,
          slot,
          attachment,
          path,
          report,
          keys.map((key, i) => ({ offset: key.offset, length: key.vertices.length, path: [...path, i, "vertices"] }))
        );
      }
    }
  }
  checkKeys(clip.drawOrder, [...base, "drawOrder"]);
  clip.drawOrder.forEach((key, i) => checkDrawOrderOffsets(key.offsets, [...base, "drawOrder", i, "offsets"], index, report));
  checkKeys(clip.events, [...base, "events"], false);
  clip.events.forEach((event, i) => {
    if (!(event.name in doc.events)) report([...base, "events", i, "name"], `event '${event.name}' is not declared in 'events'`);
  });
}

function checkDeformTarget(
  doc: AnimDocument,
  skin: string,
  slot: string,
  attachment: string,
  path: IssuePath,
  report: Report,
  spans: readonly { offset: number; length: number; path: IssuePath }[]
): void {
  const target = doc.skins[skin]?.attachments[slot]?.[attachment];
  if (!target) {
    report(path, `deform target '${skin}/${slot}/${attachment}' does not exist`);
    return;
  }
  let mesh: MeshAttachmentData | undefined;
  if (target.type === "mesh") mesh = target;
  else if (target.type === "linkedMesh") {
    if (target.inheritDeform) {
      const { skin: s, slot: sl, attachment: a } = target.source;
      report(path, `'${skin}/${slot}/${attachment}' inherits deform from '${s}/${sl}/${a}'; key the source mesh instead`);
      return;
    }
    const source = doc.skins[target.source.skin]?.attachments[target.source.slot]?.[target.source.attachment];
    if (source?.type === "mesh") mesh = source;
  } else {
    report(path, `deform target '${skin}/${slot}/${attachment}' is a ${target.type}; only meshes deform`);
    return;
  }
  if (!mesh) return; // a broken linked-mesh source is reported where the linked mesh is defined
  const length = meshDeformLength(mesh);
  for (const span of spans) {
    if (span.offset + span.length > length) {
      report(span.path, `deform values reach float ${span.offset + span.length} but the mesh deform has ${length} floats`);
    }
  }
}

function checkDrawOrderOffsets(
  offsets: readonly { slot: string; offset: number }[],
  path: IssuePath,
  index: DocumentIndex,
  report: Report
): void {
  const seen = new Set<string>();
  offsets.forEach((entry, i) => {
    const position = index.drawPosition.get(entry.slot);
    if (!index.slots.has(entry.slot)) report([...path, i, "slot"], `unknown slot '${entry.slot}'`);
    else if (index.anchored.has(entry.slot)) {
      report([...path, i, "slot"], `'${entry.slot}' is anchored (drawAfter/drawBefore) and moves with its anchor; this offset is ignored`, "warning");
    } else if (position !== undefined) {
      // Offsets count places among the unanchored slots (anchored slots travel with them).
      const moved = position + entry.offset;
      const last = index.drawPosition.size - 1;
      if (moved < 0 || moved > last) {
        report([...path, i, "offset"], `moves '${entry.slot}' to position ${moved} among the unanchored slots, outside 0..${last}`);
      }
    }
    if (seen.has(entry.slot)) report([...path, i, "slot"], `slot '${entry.slot}' is moved twice in one key`);
    seen.add(entry.slot);
  });
}

function checkAttachmentKey(slot: string, name: string | null, path: IssuePath, index: DocumentIndex, report: Report): void {
  if (!index.slots.has(slot)) report(path, `unknown slot '${slot}'`);
  else if (name !== null && !index.placeholders.get(slot)?.has(name)) {
    report(path, `no skin defines attachment '${name}' for slot '${slot}' (nothing is drawn)`, "warning");
  }
}

function reportDuplicates(values: readonly string[], path: IssuePath, what: string, report: Report): void {
  const seen = new Set<string>();
  values.forEach((value, i) => {
    if (seen.has(value)) report([...path, i], `duplicate ${what} '${value}'`);
    seen.add(value);
  });
}
