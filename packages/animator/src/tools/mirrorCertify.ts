/*
 * Atlas Animator: original implementation.
 *
 * Certification helpers for the mirrored body:
 * the half baseline's companion carries the projected poses (the validator prefers companion poses),
 * geometry findings are compared per pose and per triangle (not by totals), the skin-alone weld
 * document, and the whole-body vertex budget against the per-dressed-character figure.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GeometryFinding } from "./validateGeometry.js";

/** Plan: submitted vertices per complete dressed character. */
export const DRESSED_CHARACTER_VERTICES = 2500;
/** The probe tunic's vertex budget: declared before judging (part b), re-declared on the measured cost (part c). */
export const TUNIC_VERTEX_BUDGET = { declared: 260, redeclared: 280 } as const;

/** The half companion for a baseline run on `poses`: the validator evaluates companion poses first, so they must be these. */
export function companionWithPoses<T extends Record<string, any>>(companion: T, poses: readonly unknown[]): T & { poses: unknown[] } {
  return { ...companion, poses: [...poses] };
}

const parseId = (f: GeometryFinding): { mesh: string; t: number } | null => {
  const m = /^[^/]+\/(.+)\/t(\d+)$/.exec(f.id);
  return m ? { mesh: m[1] as string, t: Number(m[2]) } : null;
};

/**
 * Error findings of the merged rig against the half baseline on the same (projected) poses, matched
 * per pose and per triangle. A merged triangle t < leftTriangles[mesh] is the half's t; t beyond is
 * its mirror (no half counterpart on a left projection). inherited: the half fails there too;
 * introduced: the merge fails where the half passes; resolved: the half fails, the merge passes.
 */
export function compareFindings(merged: readonly GeometryFinding[], half: readonly GeometryFinding[], leftTriangles: Readonly<Record<string, number>>, poses?: ReadonlySet<string>) {
  // Only the shared pose set is comparable (clip samples differ between the half and the merged rig).
  const errs = (list: readonly GeometryFinding[]) => list.filter((f) => f.severity === "error" && (!poses || poses.has(f.pose)));
  const key = (pose: string, mesh: string, t: number, kind: string) => `${pose}|${mesh}|${t}|${kind}`;
  const halfKeys = new Set<string>();
  for (const f of errs(half)) {
    const p = parseId(f);
    if (p) halfKeys.add(key(f.pose, p.mesh, p.t, f.kind));
  }
  const inherited: string[] = [];
  const introduced: string[] = [];
  const right: string[] = [];
  const mergedKeys = new Set<string>();
  for (const f of errs(merged)) {
    const p = parseId(f);
    if (!p) continue;
    const T = leftTriangles[p.mesh] ?? Infinity;
    if (p.t >= T) {
      right.push(`${f.id}@${f.pose}`);
      continue;
    }
    const k = key(f.pose, p.mesh, p.t, f.kind);
    mergedKeys.add(k);
    (halfKeys.has(k) ? inherited : introduced).push(`${f.id}@${f.pose}`);
  }
  const resolved = [...halfKeys].filter((k) => !mergedKeys.has(k));
  return { inherited: inherited.length, introduced: introduced.length, rightSide: right.length, resolved: resolved.length, introducedFirst: introduced.slice(0, 20), resolvedFirst: resolved.slice(0, 20) };
}

/** A document showing only one mesh's slots (its own slot and its draw-group slots), no strokes: the weld raster judged on the skin alone. */
export function skinAloneDoc(doc: Record<string, any>, slot: string, attachment: string): Record<string, any> {
  const out = structuredClone(doc);
  const att = Object.values(out.skins as Record<string, any>).find((s) => s.attachments?.[slot]?.[attachment])?.attachments[slot][attachment];
  const keep = new Set<string>([slot, ...Object.keys(att?.groups ?? {})]);
  for (const s of out.slots as any[]) if (!keep.has(s.name)) s.attachment = null;
  for (const s of Object.values(out.skins as Record<string, any>)) {
    delete s.contours;
    delete s.contourContacts;
  }
  delete out.contactBands;
  return out;
}

/** Submitted vertices of every drawable attachment (mesh: its vertex count; region: 4), and the whole-body budget re-derived against the dressed-character figure. */
export function bodyBudget(doc: Record<string, any>, halfBudget: { skin: number; garment: number } | undefined, skinKey: string, centreVertices: number) {
  const meshes: Record<string, number> = {};
  let regions = 0;
  for (const [skinName, s] of Object.entries(doc.skins as Record<string, any>)) {
    for (const [slot, atts] of Object.entries((s.attachments ?? {}) as Record<string, Record<string, any>>)) {
      for (const [name, a] of Object.entries(atts)) {
        if (a.type === "region" || a.type === undefined) regions += 4;
        else if (a.type === "mesh") meshes[`${skinName}:${slot}/${name}`] = (a.uvs as number[]).length / 2;
      }
    }
  }
  const total = Object.values(meshes).reduce((s, n) => s + n, 0) + regions;
  const skinVerts = Object.entries(meshes).find(([k]) => k.endsWith(`:${skinKey}`))?.[1] ?? 0;
  const garments = total - regions - skinVerts;
  // Whole upper body: two halves share the welded centre vertices.
  const derived = halfBudget ? { skin: 2 * halfBudget.skin - centreVertices, garment: 2 * halfBudget.garment } : null;
  const dressedUpper = total + TUNIC_VERTEX_BUDGET.redeclared + 8;
  return {
    perDressedCharacter: DRESSED_CHARACTER_VERTICES,
    halfDeclared: halfBudget ?? null,
    wholeUpperBodyDerived: derived,
    submitted: { meshes, regionVertices: regions, skin: skinVerts, garments, total },
    withinDerived: derived ? skinVerts <= derived.skin && garments <= derived.garment : null,
    tunic: { declared: TUNIC_VERTEX_BUDGET.declared, redeclared: TUNIC_VERTEX_BUDGET.redeclared },
    pauldrons: 8,
    dressedUpperBody: dressedUpper,
    remainingForLegsAndHair: DRESSED_CHARACTER_VERTICES - dressedUpper,
    within: dressedUpper <= DRESSED_CHARACTER_VERTICES
  };
}
