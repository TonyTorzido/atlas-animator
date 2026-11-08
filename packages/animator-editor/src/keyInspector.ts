/*
 * Atlas Animator editor: original implementation.
 *
 * Key inspector (Batch 6): the Keys tab's first card shows what the selected dopesheet key holds (value, interpolation and curve, event
 * payload, attachment name, colour, constraint mixes), lets the artist type new values, and adds a first key on the channels the
 * dopesheet now lists (slot colour, transform mix, physics mix / reset, IK mix). Double-clicking a key opens the same fields in a small
 * popover at the key. All edits go through `commit`, so each is one undo step.
 */
import type { AnimDocument, ClipData } from "@atlas-animator/core/core";
import "./keyInspector.css";
import { timeToFrame } from "./clipModel.js";
import { liveSelection, type KeySel, type RowId } from "./dopesheetModel.js";
import { addChannelKey, describeCurve, interpolationOf, keyChannels, setKeyCurve, setKeyFields, targetRow, type KeyChannelInfo, type KeyField, type NewKeyTarget } from "./keyInspectorModel.js";

export interface KeyInspectorDeps {
  clip(): ClipData;
  time(): number;
  playing(): boolean;
  selection(): readonly KeySel[];
  doc(): AnimDocument | null;
  /** The selected slot, to preselect its colour target. */
  selectedSlot(): string | null;
  commit(next: ClipData, message: string): void;
  select(sel: KeySel[]): void;
  setTime(t: number): void;
  status(text: string, kind?: "" | "bad" | "ok"): void;
}

const $ = (id: string) => document.getElementById(id);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

const rowTitle = (row: RowId): string => {
  if (row === "draw") return "Draw order";
  if (row === "event") return "Events";
  const [kind, name] = [row.slice(0, row.indexOf(":")), row.slice(row.indexOf(":") + 1)];
  const nice = row.startsWith("bone:") ? name.split("#")[0]! : name.split("/").pop()!;
  const label = { bone: "Bone", ik: "IK", slot: "Slot image", seq: "Image sequence", color: "Slot colour", transform: "Transform mix", path: "Path constraint", physics: "Physics", deform: "Shape keys" }[kind] ?? kind;
  return `${label} ${nice}`;
};

/** An input for one field; `onChange` receives the parsed value. */
function fieldInput(f: KeyField, onChange: (v: number | string | boolean) => void): HTMLElement {
  if (f.kind === "info") return el("span", { className: "name dim", textContent: String(f.value) });
  if (f.kind === "bool") {
    const cb = el("input", { type: "checkbox", checked: Boolean(f.value) });
    cb.setAttribute("aria-label", f.label);
    cb.title = `${f.label}: tick to turn on at this key`;
    cb.addEventListener("change", () => onChange(cb.checked));
    return cb;
  }
  if (f.kind === "choice") {
    const sel = el("select", { className: "field", id: `ki-field-${f.id}` });
    for (const o of f.options ?? []) sel.append(el("option", { value: o, textContent: o, selected: o === f.value }));
    sel.setAttribute("aria-label", f.label);
    sel.title = "Sequence mode: hold keeps the start frame; once plays to the last frame and stops; loop wraps; pingpong plays forward then back. The delay sets the seconds per frame";
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }
  const num = f.kind === "number";
  const input = el("input", { className: num ? "field num wide" : "field", type: num ? "number" : "text", value: String(f.value) });
  if (num) {
    if (f.min !== undefined) input.min = String(f.min);
    if (f.max !== undefined) input.max = String(f.max);
    input.step = String(f.step ?? 0.1);
  }
  input.setAttribute("aria-label", f.label);
  input.title = f.kind === "color" ? `${f.label}: eight hex digits, red green blue alpha` : `${f.label} of the selected key. Type a number and press Enter`;
  input.dataset.field = f.id;
  const apply = () => {
    if (num) {
      const v = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(v)) return;
      onChange(v);
    } else onChange(input.value);
  };
  input.addEventListener("change", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  });
  return input;
}

export interface KeyInspector {
  render(): void;
  /** Opens the value popover for a key at a screen position (the double-click on the dopesheet). */
  openPopover(row: RowId, time: number, x: number, y: number): void;
  closePopover(): void;
}

export function createKeyInspector(deps: KeyInspectorDeps): KeyInspector {
  const host = $("keyinspector")!;
  let lastSig = "";
  let popover: HTMLElement | null = null;

  const frameOf = (t: number) => timeToFrame(deps.clip(), t);

  /** Applies a field edit to the key (and, with several keys of the same row kind selected, to all of them). */
  function applyField(row: RowId, time: number, channel: string, id: string, value: number | string | boolean): void {
    let next = deps.clip();
    const sel = deps.selection();
    const targets = sel.some((s) => s.row === row && Math.abs(s.time - time) < 1e-4) ? liveSelection(next, sel).filter((s) => s.row === row) : [{ row, time }];
    for (const k of targets) next = setKeyFields(next, k.row, k.time, channel, { [id]: value });
    if (next === deps.clip()) return;
    deps.commit(next, `Set ${id} to ${typeof value === "number" ? value : `'${value}'`} on ${targets.length} ${rowTitle(row)} key${targets.length === 1 ? "" : "s"} (frame ${frameOf(time)})`);
  }

  function applyCurve(row: RowId, time: number, channel: string, curve: unknown): void {
    let next = deps.clip();
    const sel = deps.selection();
    const targets = sel.some((s) => s.row === row && Math.abs(s.time - time) < 1e-4) ? liveSelection(next, sel) : [{ row, time }];
    let n = 0;
    for (const k of targets) {
      for (const c of keyChannels(next, k.row, k.time)) {
        if (!c.hasCurve) continue;
        next = setKeyCurve(next, k.row, k.time, c.channel, curve);
        n++;
      }
    }
    if (n) deps.commit(next, `Interpolation ${interpolationOf(curve).toLowerCase()} on ${n} channel key${n === 1 ? "" : "s"}`);
  }

  function channelBlock(row: RowId, time: number, c: KeyChannelInfo): HTMLElement {
    const box = el("div", { className: "ki-chan" });
    box.dataset.channel = c.channel;
    box.append(el("div", { className: "label", textContent: c.channel }));
    const grid = el("div", { className: "kv" });
    for (const f of c.fields) grid.append(el("span", { className: "label", textContent: f.label }), el("span", { className: "v" }, fieldInput(f, (v) => applyField(row, time, c.channel, f.id, v))));
    if (c.hasCurve) {
      const kind = interpolationOf(c.curve);
      const sel = el("select", { className: "field" });
      sel.dataset.field = "interpolation";
      sel.setAttribute("aria-label", "Interpolation");
      sel.title = "Interpolation from this key to the next: linear, stepped (holds until the next key) or bezier (shape it in the graph)";
      for (const [v, l] of [["linear", "Linear"], ["stepped", "Stepped"], ["bezier", "Bezier (ease in-out)"]] as const) sel.append(el("option", { value: v, textContent: l }));
      sel.value = kind === "Linear" ? "linear" : kind === "Stepped" ? "stepped" : "bezier";
      if (kind === "Per channel") sel.append(el("option", { value: "mixed", textContent: "Per channel", selected: true }));
      sel.addEventListener("change", () => {
        if (sel.value === "mixed") return;
        applyCurve(row, time, c.channel, sel.value === "bezier" ? [0.42, 0, 0.58, 1] : sel.value);
      });
      grid.append(el("span", { className: "label", textContent: "Interpolation" }), el("span", { className: "v" }, sel));
      grid.append(el("span", { className: "label", textContent: "Curve" }), el("span", { className: "v name", textContent: describeCurve(c.curve), title: "The easing numbers of this key's curve (x1, y1, x2, y2); edit them in the Graph" }));
    }
    box.append(grid);
    return box;
  }

  function targetOptions(): { value: string; label: string; target: NewKeyTarget }[] {
    const doc = deps.doc();
    const out: { value: string; label: string; target: NewKeyTarget }[] = [];
    if (!doc) return out;
    const slotSel = deps.selectedSlot();
    const slots = [...doc.slots].sort((a, b) => (a.name === slotSel ? -1 : b.name === slotSel ? 1 : 0));
    const sequenceSlots = new Set<string>();
    for (const skin of Object.values(doc.skins ?? {})) for (const [slot, byName] of Object.entries((skin as { attachments?: Record<string, Record<string, { sequence?: unknown }>> }).attachments ?? {})) if (Object.values(byName).some((a) => a.sequence)) sequenceSlots.add(slot);
    for (const s of slots) if (sequenceSlots.has(s.name)) out.push({ value: `seq:${s.name}`, label: `Image sequence: ${s.name}`, target: { kind: "sequence", slot: s.name } });
    for (const s of slots) out.push({ value: `color:${s.name}`, label: `Slot colour: ${s.name}`, target: { kind: "color", slot: s.name } });
    for (const t of doc.transform) out.push({ value: `transform:${t.name}`, label: `Transform mix: ${t.name}`, target: { kind: "transform", name: t.name } });
    for (const p of (doc as { path?: { name: string }[] }).path ?? []) out.push({ value: `path:${p.name}`, label: `Path position, spacing and mixes: ${p.name}`, target: { kind: "path", name: p.name } });
    for (const p of doc.physics) {
      out.push({ value: `physics:${p.name}`, label: `Physics mix: ${p.name}`, target: { kind: "physics", name: p.name, channel: "mix" } });
      out.push({ value: `physicsreset:${p.name}`, label: `Physics reset: ${p.name}`, target: { kind: "physics", name: p.name, channel: "reset" } });
    }
    for (const i of doc.ik) out.push({ value: `ik:${i.name}`, label: `IK mix: ${i.name}`, target: { kind: "ik", name: i.name } });
    return out;
  }

  function setupFor(t: NewKeyTarget): Record<string, number | string> {
    const doc = deps.doc();
    if (!doc) return {};
    if (t.kind === "sequence") return { mode: "loop", index: 0, delay: 0.1 };
    if (t.kind === "color") return { color: String((doc.slots.find((s) => s.name === t.slot) as { color?: string } | undefined)?.color ?? "ffffffff") };
    if (t.kind === "transform") return Object.fromEntries(Object.entries(doc.transform.find((c) => c.name === t.name) ?? {}).filter(([k, v]) => k.startsWith("mix") && typeof v === "number")) as Record<string, number>;
    if (t.kind === "path") return Object.fromEntries(Object.entries((doc as { path?: Record<string, unknown>[] }).path?.find((c) => c["name"] === t.name) ?? {}).filter(([k, v]) => ["position", "spacing", "mixRotate", "mixX", "mixY"].includes(k) && typeof v === "number")) as Record<string, number>;
    if (t.kind === "ik") return { mix: Number((doc.ik.find((c) => c.name === t.name) as { mix?: number } | undefined)?.mix ?? 1) };
    return { value: Number((doc.physics.find((c) => c.name === t.name) as { mix?: number } | undefined)?.mix ?? 1) };
  }

  function addBlock(): HTMLElement {
    const opts = targetOptions();
    const box = el("div", { className: "ki-add" });
    box.append(el("div", { className: "label", textContent: "Add a key at the playhead" }));
    const row = el("div", { className: "ki-addrow" });
    const select = el("select", { className: "field", id: "ki-target" });
    select.setAttribute("aria-label", "Channel to key");
    select.title = "Pick a channel the bone keys do not cover: slot colour / alpha, transform constraint mix, path constraint position / spacing / mixes, physics mix or reset, IK mix";
    for (const o of opts) select.append(el("option", { value: o.value, textContent: o.label }));
    const btn = el("button", { id: "ki-addkey", type: "button", className: "btn sm", textContent: "Key it here" });
    btn.title = "Adds a key for the chosen channel at the playhead frame, starting from the previous key (or the rig's setup values). Edit the numbers above afterwards";
    btn.disabled = !opts.length;
    btn.addEventListener("click", () => {
      const o = opts.find((x) => x.value === select.value);
      if (!o) return;
      const t = deps.time();
      const next = addChannelKey(deps.clip(), o.target, t, {}, setupFor(o.target));
      if (next === deps.clip()) return;
      const rowId = targetRow(o.target);
      deps.select([{ row: rowId, time: Math.round(t * (deps.clip().fps ?? 30)) / (deps.clip().fps ?? 30) }]);
      deps.commit(next, `Keyed ${o.label.toLowerCase()} at frame ${frameOf(t)}`);
    });
    row.append(select, btn);
    box.append(row);
    if (!opts.length) box.append(el("div", { className: "ki-note", textContent: "Open a rig to key slot colours and constraint mixes." }));
    return box;
  }

  function render(): void {
    if (deps.playing()) return;
    const clip = deps.clip();
    const live = liveSelection(clip, deps.selection());
    const first = live[0];
    const infos = first ? keyChannels(clip, first.row, first.time) : [];
    const sig = JSON.stringify([first ?? null, live.length, infos, deps.doc() ? [deps.doc()!.slots.length, deps.doc()!.transform.length, ((deps.doc() as { path?: unknown[] }).path ?? []).length, deps.doc()!.physics.length, deps.doc()!.ik.length] : -1, deps.selectedSlot(), Math.round(deps.time() * 1000)]);
    if (sig === lastSig) return;
    // Do not rebuild under the cursor while a field here has focus.
    if (host.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && lastSig !== "") return;
    lastSig = sig;
    host.replaceChildren();
    host.append(el("h2", { className: "sec", textContent: "Key inspector" }));
    if (!first) {
      host.append(el("div", { className: "ki-note", textContent: "Select a key in the dopesheet to see its value, interpolation and curve. Double-click a key to type a value." }));
    } else {
      const head = el("div", { className: "ki-head" });
      head.append(el("span", { className: "name", textContent: rowTitle(first.row) }), el("span", { className: "chip chip-info", textContent: `frame ${frameOf(first.time)}` }));
      if (live.length > 1) head.append(el("span", { className: "chip chip-count", textContent: `+${live.length - 1} more`, title: "Interpolation and value edits apply to every selected key of this row" }));
      host.append(head);
      if (!infos.length) host.append(el("div", { className: "ki-note", textContent: "This key no longer exists." }));
      for (const c of infos) host.append(channelBlock(first.row, first.time, c));
    }
    host.append(addBlock());
  }

  function closePopover(): void {
    popover?.remove();
    popover = null;
  }

  function openPopover(row: RowId, time: number, x: number, y: number): void {
    closePopover();
    const infos = keyChannels(deps.clip(), row, time);
    if (!infos.length) return;
    const pop = el("div", { className: "ki-pop card", id: "ki-pop" });
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", `Key value: ${rowTitle(row)} at frame ${frameOf(time)}`);
    pop.append(el("div", { className: "card-title", textContent: `${rowTitle(row)}, frame ${frameOf(time)}` }));
    const drafts = new Map<string, Record<string, number | string | boolean>>();
    const grid = el("div", { className: "kv" });
    let firstInput: HTMLElement | null = null;
    for (const c of infos) {
      for (const f of c.fields) {
        const input = fieldInput(f, (v) => {
          const d = drafts.get(c.channel) ?? {};
          d[f.id] = v;
          drafts.set(c.channel, d);
        });
        input.addEventListener("keydown", (e) => {
          if ((e as KeyboardEvent).key === "Enter") {
            // The field's own handler stored the draft first (it is registered earlier); then commit all fields at once.
            queueMicrotask(() => commitAll());
          }
        });
        firstInput ??= f.kind === "info" ? null : input;
        grid.append(el("span", { className: "label", textContent: infos.length > 1 ? `${c.channel} ${f.label}` : f.label }), el("span", { className: "v" }, input));
      }
    }
    function commitAll(): void {
      let next = deps.clip();
      let n = 0;
      for (const [channel, patch] of drafts) {
        const after = setKeyFields(next, row, time, channel, patch);
        if (after !== next) n += Object.keys(patch).length;
        next = after;
      }
      closePopover();
      if (n) deps.commit(next, `Set ${n} value${n === 1 ? "" : "s"} on ${rowTitle(row)} at frame ${frameOf(time)}`);
    }
    pop.append(grid);
    const actions = el("div", { className: "ki-addrow" });
    const ok = el("button", { type: "button", className: "btn sm btn-primary", textContent: "Apply", title: "Apply the typed values (Enter)" });
    ok.addEventListener("click", () => {
      // Read every input, not only the ones that fired change.
      for (const c of infos) {
        for (const f of c.fields) {
          const input = pop.querySelector<HTMLInputElement>(`[data-field="${f.id}"]`);
          if (!input || f.kind === "info") continue;
          const v = f.kind === "number" ? Number(input.value) : input.value;
          if (f.kind === "number" && !Number.isFinite(v as number)) continue;
          if (String(v) !== String(f.value)) (drafts.get(c.channel) ?? drafts.set(c.channel, {}).get(c.channel)!)[f.id] = v;
        }
      }
      commitAll();
    });
    const cancel = el("button", { type: "button", className: "btn sm", textContent: "Cancel", title: "Close without changing the key (Escape)" });
    cancel.addEventListener("click", closePopover);
    actions.append(ok, cancel);
    pop.append(actions);
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopover();
      }
    });
    document.body.append(pop);
    popover = pop;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
    (firstInput as HTMLInputElement | null)?.focus();
    (firstInput as HTMLInputElement | null)?.select?.();
    const away = (e: PointerEvent) => {
      if (popover && !popover.contains(e.target as Node)) {
        closePopover();
        document.removeEventListener("pointerdown", away, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  render();
  return { render, openPopover, closePopover };
}
