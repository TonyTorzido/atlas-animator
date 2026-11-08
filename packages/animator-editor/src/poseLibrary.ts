/*
 * Atlas Animator editor: the pose library panel (Library tab), upgraded to a grid of rendered thumbnails.
 *
 * It replaces the old list in `#posepanel` (main.ts keeps the data functions and skips its own rendering once `data-v2` is set):
 *   - every saved pose is drawn on the current rig, off-screen at a small size, and cached (key = rig, pose, pose contents);
 *   - save the current pose, whole body or only the selected bones, with a name and tags (guard, wind-up, follow-through, contact, idle);
 *   - double-click a card, or drag it onto the canvas, to apply it; the buttons apply it mirrored or to the selected bones only;
 *   - a blend slider applies it partly (50% = halfway between the pose as it is now and the library pose);
 *   - search and tag filters narrow the grid.
 * Applying keys the pose at the playhead when auto key is on, otherwise it stays an unkeyed edit like a gizmo drag. Maths: poseLibraryModel.ts.
 */
import { AnimationLibrary, AnimationState, AnimationStateData } from "@atlas-animator/core/core";
import { RenderTexture } from "pixi.js";
import { emptyClip, type PoseCopy } from "./clipModel.js";
import type { EditorHost } from "./host.js";
import { makeMirrorRig } from "./mirrorModel.js";
import { blendPoseCopy, effectiveTags, filterPoses, mirrorPoseCopy, normalizeTags, onlyBones, poseHash, POSE_TAGS } from "./poseLibraryModel.js";
import { applyPoseRecord, INCLUDE_LABEL, parsePose, POSE_NAME, poseSummary, scopeDefaults, type PoseInclude, type PoseRecord, type PoseScope } from "./poseModel.js";
import { apiError, confirmDialog, showToast } from "./persistUi.js";

const MIME = "application/x-atlas-pose";
const THUMB_W = 200;
const THUMB_H = 320;
const THUMB_SCALE = 0.25;
const TEMP_CLIP = "__pose_thumb";

type Entry = { pose: PoseRecord };
const SCOPE_TIP: Record<PoseScope, string> = {
  selected: "Save only the selected bones (rotate, move, scale and shear). Nothing else is captured.",
  character: "Save the whole character pose: every bone, shear, attachment swaps, slot colours and draw order.",
  full: "Save the full animated state: character pose plus the root bone, constraint mixes and deforms."
};
const INCLUDE_TIP: Record<keyof PoseInclude, string> = {
  root: "Include the root bone's own offsets (moving the whole character)",
  shear: "Include each bone's shear",
  mixes: "Include IK and transform constraint mixes",
  slots: "Include attachment swaps and slot colours",
  drawOrder: "Include the draw order",
  deforms: "Include the deform of meshes keyed at the playhead"
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { title?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

export interface PoseLibraryApi {
  refresh(): Promise<void>;
  apply(name: string, mode?: { mirrored?: boolean; selectedOnly?: boolean; blend?: number }): boolean;
  thumbs(): { rendered: number; cached: number };
  settled(): Promise<void>;
}

export function installPoseLibrary(host: EditorHost): PoseLibraryApi | null {
  const box = document.getElementById("posepanel");
  const view = document.getElementById("view");
  if (!box || !view) return null;
  box.dataset.v2 = "1";
  const canvasView: HTMLElement = view;

  let poses: Entry[] = [];
  let query = "";
  const filterTags = new Set<string>();
  let selected = "";
  let blend = 100;
  let showOther = false;
  let saveScope: PoseScope = "character";
  let include: PoseInclude = scopeDefaults("character");
  let deletedNames: string[] = [];
  /** The last replace or delete in this session (what "Undo" brings back). */
  let lastChange: { name: string; kind: "replaced" | "deleted" } | null = null;
  const saveTags = new Set<string>();
  const cache = new Map<string, string>();
  let rendered = 0;
  let queue: { key: string; pose: PoseRecord }[] = [];
  let pumping = false;
  const idleWaiters: (() => void)[] = [];

  const rigId = (): string => host.rig?.outfit.id ?? "none";
  const keyOf = (p: PoseRecord): string => `${rigId()}|${p.name}|${poseHash(p)}`;

  // ---- thumbnails ----
  let target: RenderTexture | null = null;

  /** Draws the character alone, posed like `pose`, into the small target; returns a PNG data URL. */
  function renderThumb(pose: PoseRecord): string {
    const { skeleton, character, doc, app, world } = host;
    if (!skeleton || !character || !doc) return "";
    target ??= RenderTexture.create({ width: THUMB_W, height: THUMB_H, resolution: 1 });
    const clip = applyPoseRecord(emptyClip(1, false, 30), pose, 0, { knownBones: new Set(doc.bones.map((b) => b.name)), knownSlots: new Set(doc.slots.map((s) => s.name)) }).clip;
    const saved = { x: world.x, y: world.y, sx: world.scale.x, sy: world.scale.y };
    const hiddenWorld = world.children.filter((c) => c !== character && c.visible);
    const hiddenStage = app.stage.children.filter((c) => c !== world && c.visible);
    for (const c of [...hiddenWorld, ...hiddenStage]) c.visible = false;
    const alpha = character.alpha;
    character.alpha = 1;
    doc.animations[TEMP_CLIP] = clip;
    try {
      const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
      skeleton.setToSetupPose();
      state.setAnimation(0, TEMP_CLIP, { loop: false });
      state.update(0);
      state.apply(skeleton);
      character.update();
      world.scale.set(THUMB_SCALE);
      const ground = (skeleton.findBone("root")?.world.y ?? 0) + 70;
      world.position.set(THUMB_W / 2, THUMB_H - 14 - ground * THUMB_SCALE);
      app.renderer.render({ container: app.stage, target, clear: true, clearColor: [0, 0, 0, 0] });
      return (app.renderer.extract.canvas(target) as unknown as HTMLCanvasElement).toDataURL("image/png");
    } finally {
      delete doc.animations[TEMP_CLIP];
      for (const c of [...hiddenWorld, ...hiddenStage]) c.visible = true;
      character.alpha = alpha;
      world.position.set(saved.x, saved.y);
      world.scale.set(saved.sx, saved.sy);
      host.restorePose();
    }
  }

  function thumbFor(p: PoseRecord, sync = false): string | undefined {
    const key = keyOf(p);
    const have = cache.get(key);
    if (have !== undefined || !sync) return have;
    const url = renderThumb(p);
    cache.set(key, url);
    rendered++;
    return url;
  }

  function schedule(entries: Entry[]): void {
    const want = entries.filter((e) => !cache.has(keyOf(e.pose)) && !queue.some((q) => q.key === keyOf(e.pose)));
    queue.push(...want.map((e) => ({ key: keyOf(e.pose), pose: e.pose })));
    if (!pumping && queue.length) {
      pumping = true;
      requestAnimationFrame(pump);
    }
  }

  function pump(): void {
    if (host.playing) {
      requestAnimationFrame(pump);
      return;
    }
    for (let n = 0; n < 3 && queue.length; n++) {
      const job = queue.shift()!;
      if (cache.has(job.key)) continue;
      const url = renderThumb(job.pose);
      cache.set(job.key, url);
      rendered++;
      const img = grid.querySelector<HTMLImageElement>(`img[data-key="${CSS.escape(job.key)}"]`);
      if (img) {
        img.src = url;
        img.classList.add("ready");
      }
    }
    if (queue.length) requestAnimationFrame(pump);
    else {
      pumping = false;
      for (const w of idleWaiters.splice(0)) w();
    }
  }

  // ---- data ----
  async function refresh(): Promise<void> {
    try {
      const names = (await fetch("/api/poses").then((r) => r.json())) as string[];
      const loaded = await Promise.all(
        names.map(async (n) => {
          const raw = (await fetch(`/repo/packages/animator-editor/poses/${n}.pose.json?v=${Date.now()}`).then((r) => r.json())) as unknown;
          return { pose: parsePose(raw) };
        })
      );
      poses = loaded.sort((a, b) => Number(!!b.pose.builtin) - Number(!!a.pose.builtin) || a.pose.name.localeCompare(b.pose.name));
    } catch (error) {
      host.status(`Pose library unavailable: ${error instanceof Error ? error.message : String(error)}`, "bad");
    }
    try {
      const hist = (await fetch("/api/pose-history").then((r) => r.json())) as { deleted?: string[] };
      deletedNames = hist.deleted ?? [];
    } catch {
      deletedNames = [];
    }
    paintGrid();
  }

  // ---- versions () ----
  async function versionsOf(name: string): Promise<{ id: string; time: string }[]> {
    const r = (await fetch(`/api/pose-history?name=${encodeURIComponent(name)}`).then((x) => x.json())) as { versions?: { id: string; time: string }[] };
    return r.versions ?? [];
  }

  /** Puts the newest kept version of a pose back (the one a replace or delete set aside). */
  async function restoreLatest(name: string): Promise<boolean> {
    const versions = await versionsOf(name);
    const newest = versions[0];
    if (!newest) {
      host.status(`No earlier version of pose ${name} is kept`, "bad");
      return false;
    }
    const res = await fetch("/api/pose-history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, id: newest.id }) }).catch(() => null);
    if (!res?.ok) {
      const message = res ? await apiError(res) : "the editor server is not answering";
      host.status(`Pose ${name} not restored: ${message}`, "bad");
      return false;
    }
    host.status(`Restored the previous version of pose ${name} (${newest.time.slice(0, 19).replace("T", " ")}); the version it replaced is kept too`, "ok");
    showToast(`Restored the previous version of pose ${name}`, "ok");
    lastChange = null;
    selected = name;
    await refresh();
    return true;
  }
  function apply(name: string, mode: { mirrored?: boolean; selectedOnly?: boolean; blend?: number } = {}): boolean {
    const entry = poses.find((p) => p.pose.name === name);
    const doc = host.doc;
    if (!entry || !doc) {
      host.status(`No pose named ${name}`, "bad");
      return false;
    }
    const k = (mode.blend ?? blend) / 100;
    const mirrored = !!mode.mirrored;
    const only = mode.selectedOnly ? host.selectedBones() : null;
    if (only && !only.length) {
      host.status("Select bones first, then apply the pose to them", "bad");
      return false;
    }
    const known = new Set(doc.bones.map((b) => b.name));
    const constraints = new Set([...doc.ik.map((c) => c.name), ...doc.transform.map((c) => c.name)]);
    let bones: PoseCopy = entry.pose.bones;
    if (mirrored) bones = mirrorPoseCopy(makeMirrorRig(doc.bones), bones);
    if (only) bones = onlyBones(bones, only);
    bones = Object.fromEntries(Object.entries(bones).filter(([b]) => known.has(b)));
    if (!Object.keys(bones).length) {
      host.status("Nothing to apply: the pose has no bones for this selection", "bad");
      return false;
    }
    if (k < 1) bones = blendPoseCopy(host.poseOffsets(), bones, k);
    const label = `${entry.pose.name}${mirrored ? " mirrored" : ""}${only ? ` on ${only.length} bone${only.length === 1 ? "" : "s"}` : ""}${k < 1 ? ` at ${Math.round(k * 100)}%` : ""}`;
    if (host.autoKey) {
      // Swaps and draw order are all-or-nothing: they come with a whole, unmirrored pose that is mostly applied.
      const withSwaps = !mirrored && !only && k >= 0.5;
      const r = applyPoseRecord(host.clip, { ...entry.pose, bones }, host.time, {
        bones: true,
        attachments: withSwaps,
        order: withSwaps,
        mixes: withSwaps,
        colors: withSwaps,
        deform: withSwaps,
        knownBones: known,
        knownSlots: new Set(doc.slots.map((s) => s.name)),
        knownConstraints: constraints
      });
      const more = [r.extras.mixes ? `${r.extras.mixes} mixes` : "", r.extras.colors ? `${r.extras.colors} colours` : "", r.extras.deforms ? `${r.extras.deforms} deforms` : ""].filter(Boolean).join(", ");
      host.commit(r.clip, `Applied pose ${label} (${r.bones} bones${r.slots ? `, ${r.slots} swaps` : ""}${more ? `, ${more}` : ""}${r.skipped.length ? `; skipped ${r.skipped.length}` : ""})`);
    } else {
      host.previewOffsets(bones);
      host.status(`Posed ${label} without keys (auto key is off): press Set Key to keep it`, "ok");
    }
    return true;
  }

  // ---- panel ----
  const search = el("input", { id: "poseq", type: "search", placeholder: "Search poses", title: "Search by name, note or tag" });
  const tagBar = el("div", { id: "posetags", className: "ptags" });
  const grid = el("div", { id: "posegrid", className: "pgrid" });
  const bar = el("div", { id: "poseactions", className: "pbar" });
  const blendInput = el("input", { id: "poseblend", type: "range", min: "0", max: "100", value: "100", title: "How much of the pose to apply: 100% is the whole pose, 50% is halfway from the pose as it is now" });
  const blendLabel = el("span", { id: "poseblendval", className: "pval", textContent: "100%" });
  const saveName = el("input", { id: "posename", type: "text", placeholder: "pose_name", title: "Letters, digits, _ and - (up to 48 characters)" });
  const saveTagBar = el("div", { id: "posesavetags", className: "ptags" });
  const scopeBtns = {
    selected: el("button", { id: "posescope-sel", textContent: "Selected bones", title: SCOPE_TIP.selected }),
    character: el("button", { id: "posescope-body", textContent: "Character pose", title: SCOPE_TIP.character }),
    full: el("button", { id: "posescope-full", textContent: "Full animated state", title: SCOPE_TIP.full })
  };
  const includeBoxes = {} as Record<keyof PoseInclude, HTMLInputElement>;
  const includeRow = el("div", { id: "poseinclude", className: "pinclude" });
  for (const key of Object.keys(INCLUDE_LABEL) as (keyof PoseInclude)[]) {
    const box = el("input", { type: "checkbox", id: `poseinc-${key}`, title: INCLUDE_TIP[key] });
    box.addEventListener("change", () => (include = { ...include, [key]: box.checked }));
    includeBoxes[key] = box;
    const lab = el("label", { className: "label", title: INCLUDE_TIP[key] });
    lab.append(box, ` ${INCLUDE_LABEL[key]}`);
    includeRow.append(lab);
  }
  const saveBtn = el("button", { id: "savepose", className: "primary", textContent: "Save new", title: "Save the pose at the playhead to the library as a new pose with this name. A name that is already used asks before replacing" });
  const replaceBtn = el("button", { id: "posereplace", textContent: "Replace selected", title: "Replace the selected library pose with the pose at the playhead (the old version is kept and can be restored)" });
  const undoBtn = el("button", { id: "poseundo", textContent: "Undo replace", title: "Put back the pose version that the last replace or delete set aside", hidden: true });
  const deletedSel = el("select", { id: "posedeleted", title: "Poses deleted earlier; pick one to restore" });
  const restoreDeletedBtn = el("button", { id: "poserestoredeleted", textContent: "Restore deleted", title: "Restore the picked deleted pose from its kept version" });
  const deletedRow = el("div", { id: "posedeletedrow", className: "row", hidden: true }, deletedSel, restoreDeletedBtn);
  const otherToggle = el("label", { className: "label", title: "The built-in poses are made per pro rig; show the other rig's too" });
  const otherBox = el("input", { type: "checkbox" });
  otherToggle.append(otherBox, " other rigs");

  const chip = (tag: string, on: boolean, click: () => void): HTMLButtonElement => {
    const b = el("button", { type: "button", className: `ptag${on ? " on" : ""}`, textContent: tag, title: `Tag: ${tag}` });
    b.addEventListener("click", click);
    return b;
  };

  function paintTags(): void {
    tagBar.replaceChildren(
      chip("all", filterTags.size === 0, () => (filterTags.clear(), paintTags(), paintGrid())),
      ...POSE_TAGS.map((t) =>
        chip(t, filterTags.has(t), () => {
          if (!filterTags.delete(t)) filterTags.add(t);
          paintTags();
          paintGrid();
        })
      )
    );
    saveTagBar.replaceChildren(
      ...POSE_TAGS.map((t) =>
        chip(t, saveTags.has(t), () => {
          if (!saveTags.delete(t)) saveTags.add(t);
          paintTags();
        })
      )
    );
    for (const [k, b] of Object.entries(scopeBtns)) b.classList.toggle("on", saveScope === k);
    for (const [k, b] of Object.entries(includeBoxes)) b.checked = include[k as keyof PoseInclude];
    replaceBtn.disabled = !poses.find((p) => p.pose.name === selected && !p.pose.builtin);
    undoBtn.hidden = !lastChange;
    if (lastChange) undoBtn.textContent = lastChange.kind === "deleted" ? `Undo delete (${lastChange.name})` : `Undo replace (${lastChange.name})`;
    deletedRow.hidden = !deletedNames.length;
    deletedSel.replaceChildren(...deletedNames.map((n) => el("option", { value: n, textContent: n })));
  }

  function paintBar(): void {
    const p = poses.find((e) => e.pose.name === selected)?.pose;
    bar.replaceChildren();
    bar.classList.toggle("empty", !p);
    if (!p) {
      bar.append(el("span", { className: "note", textContent: "Click a pose, then apply it. Double-click or drag a card onto the canvas to apply it at once." }));
      return;
    }
    const run = (label: string, tip: string, mode: { mirrored?: boolean; selectedOnly?: boolean }, id: string): HTMLButtonElement => {
      const b = el("button", { id, textContent: label, title: tip });
      b.addEventListener("click", () => apply(p.name, mode));
      return b;
    };
    const buttons = [
      run("Apply", "Key this pose at the playhead (auto key off: an unkeyed edit)", {}, "poseapply"),
      run("Apply mirrored", "Apply the pose flipped left to right (the Shift+M mirror maths)", { mirrored: true }, "posemirror"),
      run("To selected bones", "Apply the pose to the selected bones only", { selectedOnly: true }, "poseselected")
    ];
    const head = el("div", { className: "pbar-head" }, el("strong", { textContent: p.name }), el("span", { className: "note", textContent: p.note ?? poseSummary(p) }));
    const actions = el("div", { className: "row" }, ...buttons);
    if (!p.builtin) {
      const del = el("button", { id: "posedelete", textContent: "Delete", title: "Delete this saved pose" });
      del.addEventListener("click", () => void remove(p.name));
      const prev = el("button", { id: "poseprevious", textContent: "Previous version", title: "Restore the version of this pose that was kept before the last replace (the current one is kept too)" });
      prev.addEventListener("click", () => void restoreLatest(p.name));
      actions.append(prev, del);
    }
    bar.append(head, actions);
  }

  function paintGrid(): void {
    const mine = poses.filter(({ pose }) => !pose.rig || pose.rig === rigId() || showOther);
    const otherCount = poses.filter(({ pose }) => pose.rig && pose.rig !== rigId()).length;
    otherToggle.hidden = !otherCount;
    otherToggle.title = `The built-in poses are made per pro rig; show the other rig's too (${otherCount})`;
    const shown = filterPoses(mine, query, filterTags);
    grid.replaceChildren();
    for (const { pose: p } of shown) {
      const key = keyOf(p);
      const url = thumbFor(p);
      const img = el("img", { alt: p.name, width: THUMB_W, height: THUMB_H, draggable: false });
      img.dataset.key = key;
      if (url) {
        img.src = url;
        img.classList.add("ready");
      }
      const tags = effectiveTags(p);
      const card = el(
        "div",
        { className: `pcard${p.name === selected ? " sel" : ""}`, draggable: true, title: `${p.note ?? poseSummary(p)}\nDouble-click to apply, or drag onto the canvas` },
        el("div", { className: "pthumb" }, img),
        el("div", { className: "pname", textContent: p.name }),
        el("div", { className: "ptagrow" }, ...(p.builtin ? [el("span", { className: "pill", textContent: "built-in", title: "Starter pose shipped with the editor (read-only)" })] : []), ...tags.slice(0, 2).map((t) => el("span", { className: "ptagdot", textContent: t })))
      );
      card.dataset.pose = p.name;
      if (p.builtin) card.dataset.builtin = "1";
      card.addEventListener("click", () => {
        selected = p.name;
        for (const c of grid.querySelectorAll(".pcard")) c.classList.toggle("sel", (c as HTMLElement).dataset.pose === p.name);
        paintBar();
        paintTags();
      });
      card.addEventListener("dblclick", () => apply(p.name));
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(MIME, p.name);
        e.dataTransfer?.setData("text/plain", p.name);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setDragImage(img, THUMB_W / 4, THUMB_H / 4);
        }
        selected = p.name;
        canvasView.classList.add("pose-dropping");
      });
      card.addEventListener("dragend", () => canvasView.classList.remove("pose-dropping", "pose-over"));
      grid.append(card);
    }
    if (!shown.length) grid.append(el("div", { className: "empty pempty", textContent: poses.length ? "No poses match." : "No saved poses yet. Pose the character, name it and Save pose." }));
    paintBar();
    schedule(shown);
  }

  async function remove(name: string): Promise<void> {
    if (!(await confirmDialog(`Delete pose ${name}?`, `This deletes the pose ${name} from the pose library. A copy is kept: Undo delete or Restore deleted brings it back.`, "Delete"))) return;
    const res = await fetch(`/api/poses/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      const message = res ? await apiError(res) : "the editor server is not answering";
      host.status(`Pose ${name} not deleted: ${message}`, "bad");
      showToast(`Pose ${name} not deleted: ${message}`, "bad");
      return;
    }
    if (selected === name) selected = "";
    lastChange = { name, kind: "deleted" };
    host.status(`Deleted pose ${name} (a copy is kept: Undo delete restores it)`, "ok");
    await refresh();
    paintTags();
  }

  /** Saves the pose at the playhead; `replacing` is set by Replace selected (no name collision to ask about). */
  async function save(replacing = false): Promise<void> {
    const name = replacing ? selected : saveName.value.trim();
    if (!POSE_NAME.test(name)) return host.status("Pose names use letters, digits, _ and - (up to 48 characters)", "bad");
    const existing = poses.find((p) => p.pose.name === name)?.pose;
    if (existing?.builtin) return host.status(`${name} is a built-in pose (read-only): pick another name`, "bad");
    let only: string[] | null = null;
    if (saveScope === "selected") {
      only = host.selectedBones();
      if (!only.length) return host.status("Select bones first to save only them", "bad");
    }
    if (existing && !(await confirmDialog(replacing ? `Replace pose ${name}?` : `A pose called ${name} already exists`, `${replacing ? "Replace" : "Saving this will replace"} the pose ${name} with the pose at the playhead. The old version is kept: Previous version or Undo replace brings it back.`, "Replace", false))) return;
    let record: PoseRecord = host.capturePose(name, include, only);
    const tags = normalizeTags([...saveTags]);
    record = { ...record, ...(tags.length ? { tags } : {}) };
    const png = renderThumb(record);
    const res = await fetch(`/api/poses/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pose: record, png }) });
    if (!res.ok) return host.status(`Pose not saved: ${((await res.json()) as { error?: string }).error ?? res.status}`, "bad");
    cache.set(keyOf(record), png);
    selected = name;
    saveName.value = "";
    saveTags.clear();
    if (existing) lastChange = { name, kind: "replaced" };
    host.status(`${existing ? "Replaced" : "Saved"} pose ${name} (${poseSummary(record)})${existing ? "; the old version is kept" : ""}`, "ok");
    await refresh();
    paintTags();
  }

  // ---- assemble ----
  const head = el("h2", { textContent: "Pose library" });
  const blendRow = el("div", { className: "row pblend" }, el("span", { className: "label", textContent: "Blend" }), blendInput, blendLabel);
  const saveRow = el("div", { className: "psave" }, el("div", { className: "row" }, saveName, saveBtn, replaceBtn), el("div", { className: "seg", role: "group", ariaLabel: "What the pose saves" } as never, scopeBtns.selected, scopeBtns.character, scopeBtns.full), includeRow, saveTagBar, el("div", { className: "row" }, undoBtn), deletedRow);
  const filterRow = el("div", { className: "row pfilter" }, search, otherToggle);
  box.replaceChildren(head, filterRow, tagBar, grid, bar, blendRow, saveRow);
  paintTags();

  search.addEventListener("input", () => {
    query = search.value;
    paintGrid();
  });
  blendInput.addEventListener("input", () => {
    blend = Number(blendInput.value);
    blendLabel.textContent = `${blend}%`;
  });
  otherBox.addEventListener("change", () => {
    showOther = otherBox.checked;
    paintGrid();
  });
  for (const scope of Object.keys(scopeBtns) as PoseScope[])
    scopeBtns[scope].addEventListener("click", () => {
      saveScope = scope;
      include = scopeDefaults(scope);
      paintTags();
    });
  saveBtn.addEventListener("click", () => void save());
  replaceBtn.addEventListener("click", () => void save(true));
  undoBtn.addEventListener("click", () => lastChange && void restoreLatest(lastChange.name));
  restoreDeletedBtn.addEventListener("click", () => deletedSel.value && void restoreLatest(deletedSel.value));
  saveName.addEventListener("keydown", (e) => e.key === "Enter" && void save());

  // Drag a pose onto the canvas.
  const accepts = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes(MIME);
  canvasView.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    canvasView.classList.add("pose-over");
  });
  canvasView.addEventListener("dragleave", (e) => {
    if (e.target === canvasView) canvasView.classList.remove("pose-over");
  });
  canvasView.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    canvasView.classList.remove("pose-over", "pose-dropping");
    const name = e.dataTransfer?.getData(MIME);
    if (name) apply(name, { mirrored: e.altKey });
  });

  host.on("rig", () => {
    queue = [];
    void refresh();
  });
  document.querySelector<HTMLElement>('[data-tab="library"]')?.addEventListener("click", () => void refresh());
  void refresh();

  const api: PoseLibraryApi = {
    refresh,
    apply,
    thumbs: () => ({ rendered, cached: cache.size }),
    settled: () => (pumping ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve())
  };
  (window as unknown as { atlasPoseLib?: PoseLibraryApi }).atlasPoseLib = api;
  return api;
}
