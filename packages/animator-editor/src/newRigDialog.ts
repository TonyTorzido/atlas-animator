/*
 * Atlas Animator editor: the New rig dialog and the parts import (browser).
 *
 * Name (folder-safe id), starting point (Blank, or the player skeleton without art), and parts: drop several PNGs, or one layered PSD.
 * PNGs have no positions, so they are laid out in shelves standing on the ground; PSD layers land at their canvas positions, relative to
 * the ground point (newRigModel.psdCanvas). The list shows the front-most part first, like a layers panel; the server gets back to front.
 */
import { groundOf, layoutParts, opaqueBounds, partName, psdCanvas, psdOffset, rigIdProblem, suggestRigId, type CanvasSpec } from "./newRigModel.js";
import { psdReportLines, readPsd } from "./psdRead.js";
import { bindDialog } from "./dialog.js";
import type { DiscoveredRig } from "./fixtures.js";

export interface DraftPart {
  name: string;
  png: string;
  width: number;
  height: number;
  /** Root-relative top-left; null = not placed yet (laid out when the list is final). */
  x: number | null;
  y: number | null;
  /** Rows from the top to the lowest opaque pixel (loose PNGs: used to stand them on the ground). */
  opaqueBottom?: number;
}

export interface ImportedParts {
  parts: DraftPart[];
  canvas?: CanvasSpec;
  note: string;
  /** PSD only: what the import does not reproduce (blend modes, masks, effects, groups, hidden layers), one line per layer. */
  report?: string[];
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const readDataUrl = (file: Blob): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error("could not read the file"));
    r.readAsDataURL(file);
  });

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("not a readable image"));
    img.src = url;
  });

function rgbaToPng(rgba: Uint8ClampedArray, width: number, height: number): string {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return c.toDataURL("image/png");
}

/** Dropped or picked files to draft parts: a PSD gives positioned layers (back to front), PNGs are sorted by name and left unplaced. */
export async function filesToParts(files: readonly File[]): Promise<ImportedParts> {
  const psd = files.find((f) => /\.psd$/i.test(f.name));
  if (psd) {
    const file = readPsd(await psd.arrayBuffer());
    if (!file.layers.length) throw new Error("that PSD has no pixel layers");
    const canvas = psdCanvas(file.width, file.height, groundOf(file.layers));
    const parts = file.layers.map((l) => {
      const at = psdOffset(l, canvas);
      return { name: partName(l.name), png: rgbaToPng(l.rgba, l.width, l.height), width: l.width, height: l.height, x: at.x, y: at.y } satisfies DraftPart;
    });
    const others = files.filter((f) => f !== psd);
    const skipped = others.length ? `. Skipped ${others.length} other file${others.length === 1 ? "" : "s"} (${others.slice(0, 3).map((f) => f.name).join(", ")}${others.length > 3 ? ", ..." : ""}): one PSD or a set of PNGs at a time` : "";
    return { parts, canvas, report: psdReportLines(file.issues), note: `${parts.length} layers from ${psd.name}, at their positions; root on the ground under the art${skipped}` };
  }
  const pngs = files.filter((f) => /\.png$/i.test(f.name) || f.type === "image/png").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!pngs.length) throw new Error("drop PNG images or one layered PSD");
  const parts: DraftPart[] = [];
  for (const f of pngs) {
    const png = await readDataUrl(f);
    const img = await loadImage(png);
    const probe = document.createElement("canvas");
    probe.width = img.naturalWidth;
    probe.height = img.naturalHeight;
    const g = probe.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const ob = opaqueBounds(g.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height);
    parts.push({ name: partName(f.name), png, width: img.naturalWidth, height: img.naturalHeight, x: null, y: null, ...(ob ? { opaqueBottom: ob.bottom } : {}) });
  }
  return { parts, note: `${parts.length} images, in name order (first = back). They have no positions: stood on the ground, place them in Setup` };
}

/** Fills the unplaced parts' positions (a shelf layout around the ground point). */
export function placeParts(parts: DraftPart[]): DraftPart[] {
  const open = parts.filter((p) => p.x === null);
  if (!open.length) return parts;
  const at = layoutParts(open);
  let i = 0;
  return parts.map((p) => (p.x === null ? { ...p, x: at[i]!.x, y: at[i++]!.y } : p));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `request failed (${r.status})`);
  return j;
}

/** Asks what to do with parts whose slot names the rig already has. Esc = cancel. */
export function askDuplicateParts(rigLabel: string, names: string[]): Promise<"replace" | "copies" | "cancel"> {
  return new Promise((done) => {
    const back = h("div", "modal-backdrop");
    back.id = "dupparts-dialog";
    const box = h("div", "modal");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Parts already in the rig");
    const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? `, and ${names.length - 6} more` : "");
    box.append(h("h2", undefined, "Parts already in this rig"), h("div", "newrig-msg", `${names.length} of these parts have the same slot name as parts already in '${rigLabel}': ${shown}.`));
    let answer: "replace" | "copies" | "cancel" = "cancel";
    const closeDialog = bindDialog(back, () => {
      back.remove();
      done(answer);
    });
    const finish = (v: "replace" | "copies" | "cancel"): void => {
      answer = v;
      closeDialog();
    };
    const mk = (id: string, text: string, tip: string, v: "replace" | "copies" | "cancel", cls?: string): HTMLButtonElement => {
      const b = h("button", cls, text);
      b.type = "button";
      b.id = id;
      b.title = tip;
      b.addEventListener("click", () => finish(v));
      return b;
    };
    const actions = h("div", "modal-actions");
    actions.append(
      mk("dupparts-cancel", "Cancel", "Add nothing", "cancel"),
      mk("dupparts-copies", "Add as copies", "Add every part as a new slot; repeated names get _2, _3", "copies"),
      mk("dupparts-replace", "Replace", "Swap the image of the slots with the same name; new names are added", "replace", "btn-primary")
    );
    box.append(actions);
    back.append(box);
    document.body.append(back);
    actions.querySelector<HTMLButtonElement>("#dupparts-replace")?.focus();
  });
}

/** Adds dropped files to an editor-made rig (server packs them into its atlas). The caller reloads the rig. Returns null when the user cancelled. */
export async function addPartsToRig(rigId: string, files: readonly File[], rig?: { label: string; slots: readonly string[] }): Promise<{ added: number; replaced: number } | null> {
  const imported = await filesToParts(files);
  const parts = placeParts(imported.parts).map((p) => ({ name: p.name, png: p.png, x: p.x!, y: p.y! }));
  const have = new Set(rig?.slots ?? []);
  const dupes = [...new Set(parts.map((p) => partName(p.name)).filter((n) => have.has(n)))];
  let replace = false;
  if (dupes.length) {
    const choice = await askDuplicateParts(rig?.label ?? rigId, dupes);
    if (choice === "cancel") return null;
    replace = choice === "replace";
  }
  const r = await post<{ slots: string[]; replaced?: string[] }>("/api/rig/parts", { id: rigId, parts, replace });
  return { added: r.slots.length, replaced: r.replaced?.length ?? 0 };
}

/** Opens a file picker for PNGs / a PSD. */
export function pickPartFiles(): Promise<File[]> {
  return new Promise((ok) => {
    const input = h("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".png,.psd,image/png";
    input.addEventListener("change", () => ok([...(input.files ?? [])]));
    input.click();
  });
}

export interface NewRigDeps {
  existingIds(): string[];
  onCreated(entry: DiscoveredRig): Promise<void>;
}

export function openNewRigDialog(deps: NewRigDeps): void {
  if (document.getElementById("newrig-dialog")) return;
  let parts: DraftPart[] = [];
  let canvas: CanvasSpec | undefined;
  let template = "blank" as "blank" | "player";
  let idEdited = false;
  let busy = false;

  const back = h("div", "modal-backdrop");
  back.id = "newrig-dialog";
  const box = h("div", "modal newrig");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "New rig");
  back.append(box);
  box.append(h("h2", undefined, "New rig"));

  const nameIn = h("input");
  nameIn.type = "text";
  nameIn.placeholder = "Test blob";
  nameIn.id = "newrig-name";
  nameIn.title = "A display name for the rig";
  const idIn = h("input");
  idIn.type = "text";
  idIn.id = "newrig-id";
  idIn.placeholder = "test-blob";
  idIn.title = "The folder name under packages/animator/rigs: lower-case letters, digits and dashes";
  const idMsg = h("div", "newrig-msg");
  idMsg.id = "newrig-idmsg";
  const grid = h("div", "newrig-grid");
  const lab1 = h("label", "newrig-label", "Name");
  const lab2 = h("label", "newrig-label", "Folder id");
  grid.append(lab1, nameIn, lab2, idIn);
  box.append(grid, idMsg);

  const startRow = h("div", "newrig-start");
  const choices: [typeof template, string, string][] = [
    ["blank", "Blank", "Only a root bone. Draw your own bones."],
    ["player", "Player skeleton", "The turned player's bones, IK and standard names, no art: project clips and pose rules work."]
  ];
  const startBtns = choices.map(([id, title, blurb]) => {
    const b = h("button", "newrig-choice");
    b.type = "button";
    b.dataset.template = id;
    b.title = blurb;
    b.append(h("b", undefined, title), h("span", undefined, blurb));
    b.addEventListener("click", () => {
      template = id;
      sync();
    });
    startRow.append(b);
    return b;
  });
  box.append(h("div", "newrig-label", "Starting point"), startRow);

  const zone = h("div", "newrig-drop");
  zone.id = "newrig-drop";
  zone.tabIndex = 0;
  zone.append(h("b", undefined, "Drop parts here"), h("span", undefined, "Several PNGs, or one layered PSD. Or click to browse."));
  const list = h("div", "newrig-parts");
  list.id = "newrig-parts";
  const note = h("div", "newrig-msg");
  note.id = "newrig-note";
  const report = h("div", "newrig-msg");
  report.id = "newrig-psd-report";
  report.title = "What the PSD import does not reproduce: blend modes, opacity, masks, effects, groups and hidden layers come in as plain pixels";
  report.hidden = true;
  box.append(h("div", "newrig-label", "Parts (optional)"), zone, note, report, list);

  const err = h("div", "newrig-msg bad");
  err.id = "newrig-error";
  const cancel = h("button", undefined, "Cancel");
  cancel.type = "button";
  cancel.title = "Close without creating a rig (Esc)";
  const create = h("button", "btn-primary", "Create rig");
  create.type = "button";
  create.id = "newrig-create";
  create.title = "Write the rig to packages/animator/rigs and open it in the Rig workspace";
  const actions = h("div", "modal-actions");
  actions.append(err, cancel, create);
  box.append(actions);

  const close = bindDialog(back);
  cancel.addEventListener("click", close);

  const idProblem = (): string | null => {
    const id = idIn.value.trim();
    if (!id) return "Give the rig a name";
    return rigIdProblem(id) ?? (deps.existingIds().includes(id) ? `A rig '${id}' already exists` : null);
  };

  function renderParts(): void {
    list.replaceChildren();
    [...parts].reverse().forEach((p, shown) => {
      const index = parts.length - 1 - shown;
      const row = h("div", "newrig-part");
      const img = h("img");
      img.src = p.png;
      img.alt = "";
      const name = h("input");
      name.value = p.name;
      name.title = "Slot name";
      name.addEventListener("change", () => {
        parts[index] = { ...p, name: partName(name.value) };
        name.value = parts[index]!.name;
      });
      const size = h("span", "newrig-size", `${p.width}x${p.height}`);
      const rm = h("button", undefined, "Remove");
      rm.type = "button";
      rm.title = "Leave this part out";
      rm.addEventListener("click", () => {
        parts.splice(index, 1);
        renderParts();
      });
      row.append(img, name, size, rm);
      if (shown === 0) row.append(h("span", "newrig-tag", "front"));
      list.append(row);
    });
  }

  function sync(): void {
    startBtns.forEach((b) => b.classList.toggle("on", b.dataset.template === template));
    const problem = idProblem();
    idMsg.textContent = problem && (idIn.value || idEdited) ? problem : "";
    idMsg.classList.toggle("bad", !!idMsg.textContent);
    create.disabled = busy || !!problem;
  }

  async function take(files: File[]): Promise<void> {
    note.classList.remove("bad");
    try {
      const got = await filesToParts(files);
      parts = [...parts, ...got.parts];
      if (got.canvas) canvas = got.canvas;
      note.textContent = got.note;
      report.replaceChildren();
      report.hidden = !got.report;
      if (got.report) {
        report.append(h("div", "newrig-label", got.report[0]!.startsWith("Nothing") ? "PSD import report" : `PSD import report: ${got.report.length} layer${got.report.length === 1 ? "" : "s"} with settings that are not reproduced`));
        for (const line of got.report) report.append(h("div", undefined, line));
      }
      renderParts();
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : String(e);
      note.classList.add("bad");
    }
  }
  zone.addEventListener("click", () => void pickPartFiles().then(take));
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") void pickPartFiles().then(take);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    void take([...(e.dataTransfer?.files ?? [])]);
  });
  nameIn.addEventListener("input", () => {
    if (!idEdited) idIn.value = suggestRigId(nameIn.value);
    sync();
  });
  idIn.addEventListener("input", () => {
    idEdited = true;
    sync();
  });

  create.addEventListener("click", async () => {
    if (idProblem()) return;
    busy = true;
    err.textContent = "";
    sync();
    try {
      const placed = placeParts(parts).map((p) => ({ name: p.name, png: p.png, x: p.x!, y: p.y! }));
      const r = await post<{ rig: DiscoveredRig }>("/api/rig/create", { id: idIn.value.trim(), label: nameIn.value.trim() || idIn.value.trim(), template, parts: placed, ...(canvas ? { canvas } : {}) });
      close();
      await deps.onCreated(r.rig);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      busy = false;
      sync();
    }
  });

  document.body.append(back);
  sync();
  nameIn.focus();
}
