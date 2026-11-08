/*
 * Atlas Animator editor: the Ship workspace screen.
 *
 * Order follows the real pipeline: Check (staged checklist and a preflight bound to the working revision, with hashes), Apply (Save,
 * Apply to rig), Publish (the primary action, plus a Published table read from the publish diff), then "Also": Export Spine, Download,
 * Render sheets with saved presets. Each button drives the editor's own control (#save, #apply, #render, #spine-export, #export).
 */
import { boardSummary, type BoardState } from "./gameClips.js";
import { getHost } from "./host.js";
import { openPublishDialog } from "./dataPanel.js";
import { BUILTIN_PRESETS, checklist, gateRows, isHex6, parsePresets, parseScales, publishedRow, shortHash, type CheckRow, type PublishPlanLike, type PublishedRow, type RenderPreset } from "./shipModel.js";

const PRESET_KEY = "atlas-editor-render-presets";
const ACTIVE_KEY = "atlas-editor-render-preset";

function readCustom(): RenderPreset[] {
  try {
    return parsePresets(JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]"));
  } catch {
    return [];
  }
}
function writeCustom(list: readonly RenderPreset[]): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list.map(({ label, scales, background }) => ({ label, scales, background }))));
  } catch {
    // not remembered
  }
}
export function allPresets(): RenderPreset[] {
  return [...BUILTIN_PRESETS, ...readCustom()];
}
/** The preset Render sheets uses (the Ship screen's choice; the phone sizes until one is picked). */
export function activeRenderPreset(): RenderPreset {
  let id = "phone";
  try {
    id = localStorage.getItem(ACTIVE_KEY) ?? "phone";
  } catch {
    // default
  }
  const all = allPresets();
  return all.find((p) => p.id === id) ?? all[0]!;
}
function setActive(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // not remembered
  }
}

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const tip = <T extends HTMLElement>(e: T, text: string): T => {
  e.title = text;
  e.setAttribute("aria-label", text);
  return e;
};

async function sha1(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const STATUS_CLASS: Record<string, string> = { ok: "chip-ok", warn: "chip-warn", bad: "chip-bad", todo: "chip-info" };
const STATUS_WORD: Record<string, string> = { ok: "OK", warn: "Check", bad: "Fix", todo: "To do" };

/** Builds the Ship screen into `host`. Returns a cleanup that disconnects the watchers. */
export function buildShip(host: HTMLElement, go: (id: "home" | "animate" | "pro") => void): () => void {
  const cleanups: (() => void)[] = [];
  host.replaceChildren();
  const card = mk("div", "soon-card ship-card");
  card.append(mk("h2", undefined, "Ship"));
  const lead = mk("p", "ship-lead");
  lead.id = "ship-deliverable";
  card.append(lead);

  // ---- 1. Check ---------------------------------------------------------------------------------------------------------------
  const checks = mk("section", "ship-sec");
  checks.id = "ship-check-sec";
  checks.append(mk("h3", "ship-h", "1. Check"));
  const list = mk("ul", "ship-checklist");
  list.id = "ship-checklist";
  const summary = mk("div", "ship-summary", "Reading the clip board...");
  summary.id = "ship-summary";
  const pre = mk("div", "ship-preflight");
  pre.id = "ship-preflight";
  const checkRow = mk("div", "ship-row");
  const checkBtn = tip(mk("button", "btn", "Check"), "Re-reads the rig, the open clip and the repo copy, and runs the clip's gate checks when a clip is open. Nothing is written.");
  checkBtn.type = "button";
  checkBtn.id = "ship-check";
  const boardBtn = tip(mk("button", "btn sm", "Open the Clip board"), "Opens the Animate workspace on the Clip board: the sample clip list and its state.");
  boardBtn.type = "button";
  boardBtn.id = "ship-board";
  boardBtn.addEventListener("click", () => {
    go("animate");
    document.getElementById("clips-open")?.click();
  });
  checkRow.append(checkBtn, boardBtn);
  checks.append(list, pre, summary, mk("p", "ship-note", "Gate checks run on a clip while it is open. Clips not opened this session count as made, not as re-checked."), checkRow);
  card.append(checks);

  // ---- 2. Apply ---------------------------------------------------------------------------------------------------------------
  const acts = mk("section", "ship-sec");
  acts.append(mk("h3", "ship-h", "2. Apply"));
  const row = (label: string, help: string, target: string, primary = false, tooltip = help) => {
    const r = mk("div", "ship-row");
    const b = tip(mk("button", primary ? "btn btn-primary" : "btn", label), tooltip);
    b.type = "button";
    b.id = `ship-${target}`;
    b.addEventListener("click", () => document.getElementById(target)?.click());
    r.append(b, mk("span", "ship-help", help));
    return r;
  };
  acts.append(row("Save", "Writes the open clip to the clips folder.", "save"));
  const apply = row("Apply to rig", "Writes the open clip into the rig file (the one the Spine export and Render sheets read).", "apply");
  const all = mk("label", "ship-all");
  const cb = mk("input");
  cb.type = "checkbox";
  cb.id = "ship-applyall";
  cb.title = "Also writes the clip into every compatible rig file, not just the open rig. Each one is listed in the confirm.";
  const real = document.getElementById("applyall") as HTMLInputElement | null;
  cb.checked = !!real?.checked;
  cb.addEventListener("change", () => {
    if (real) real.checked = cb.checked;
  });
  all.append(cb, " all rigs");
  apply.append(all);
  acts.append(apply);
  card.append(acts);

  // ---- 3. Publish -------------------------------------------------------------------------------------------------------------
  const pub = mk("section", "ship-sec");
  pub.append(mk("h3", "ship-h", "3. Publish"));
  const pubRow = mk("div", "ship-row");
  const pubBtn = tip(mk("button", "btn btn-primary", "Publish to project folder"), "Copies one of your rigs or clips from your data folder into your project folder (ATLAS_EDITOR_PUBLISH_DIR). Shows the changes and their hashes first. It does not commit, push or deploy.");
  pubBtn.type = "button";
  pubBtn.id = "ship-publish";
  pubBtn.addEventListener("click", () => void openPublishDialog().then(() => void refreshPublished()));
  // No publish folder set: Publish stays visible but off, with the reason next to it.
  void getJson<{ dir: string | null }>("/api/publish/config").then((c) => {
    if (c && c.dir === null) {
      pubBtn.disabled = true;
      pubBtn.title = "No publish folder is set. Start the editor with ATLAS_EDITOR_PUBLISH_DIR=<absolute folder> to turn Publish on.";
    }
  });
  pubRow.append(pubBtn, mk("span", "ship-help", "Copies a rig or clip into your project folder (changes shown first). Not committed, pushed or deployed. Needs a project folder: start the editor with ATLAS_EDITOR_PUBLISH_DIR set to an absolute folder path."));
  const table = mk("table", "ship-table");
  table.id = "ship-published";
  const tcap = mk("caption", undefined, "Published: what the project folder has, from the same diff Publish shows");
  table.append(tcap, mk("tbody"));
  const refreshBtn = tip(mk("button", "btn sm", "Refresh Published"), "Reads the publish diff again for every rig and saved clip.");
  refreshBtn.type = "button";
  refreshBtn.id = "ship-refresh-published";
  const valRow = mk("div", "ship-row");
  const valBtn = tip(mk("button", "btn", "Validate published"), "Loads every published rig from the project folder the way a runtime would: file hashes from the publish manifest, the rig document, every atlas page, every skin attachment and placeholder, and every clip in the project clip list. Nothing is written.");
  valBtn.type = "button";
  valBtn.id = "ship-validate";
  valRow.append(valBtn, mk("span", "ship-help", "Checks what Publish wrote: hashes, pages, skins and the project clip list (clipMap.json)."));
  const valOut = mk("div", "ship-result");
  valOut.id = "ship-validate-out";
  valOut.hidden = true;
  valBtn.addEventListener("click", () => void validatePublished());
  pub.append(pubRow, table, refreshBtn, valRow, valOut);
  card.append(pub);

  // ---- Also -------------------------------------------------------------------------------------------------------------------
  const also = mk("section", "ship-sec");
  also.append(mk("h3", "ship-h", "Also"));
  also.append(row("Export Spine", "Writes the whole saved rig (skeleton, atlas, images, every applied clip) as a Spine project into the exports folder.", "spine-export"));
  const spineOut = mk("div", "ship-result");
  spineOut.id = "ship-spine";
  spineOut.hidden = true;
  also.append(spineOut);
  also.append(row("Download clip JSON", "Downloads the open clip as a .clip.json file.", "export"));
  also.append(row("Render sheets", "Applies the open clip to the rig file first, then renders contact sheets and gifts with the preset below.".replace("gifts", "gifs"), "render", false, "Applies the open clip to the rig file, then renders contact sheets and gifs through the animator CLI with the chosen preset."));

  const pr = mk("div", "ship-preset");
  pr.id = "ship-presets";
  const sel = tip(mk("select", "field"), "Render preset: which scales and background Render sheets uses.");
  sel.id = "ship-preset";
  const scalesIn = tip(mk("input", "field"), "Scales for a new preset: one to three numbers from 0.1 to 2, for example 0.4, 1.");
  scalesIn.id = "ship-preset-scales";
  scalesIn.placeholder = "0.4, 1";
  scalesIn.size = 10;
  const bgIn = tip(mk("input", "field"), "Background colour as six hex digits, for example 1e2430.");
  bgIn.id = "ship-preset-bg";
  bgIn.value = "1e2430";
  bgIn.size = 7;
  const nameIn = tip(mk("input", "field"), "Name for the new preset.");
  nameIn.id = "ship-preset-name";
  nameIn.placeholder = "Preset name";
  nameIn.size = 12;
  const saveP = tip(mk("button", "btn sm", "Save preset"), "Saves these scales and this background as a named preset in this browser.");
  saveP.type = "button";
  saveP.id = "ship-preset-save";
  const delP = tip(mk("button", "btn sm", "Delete preset"), "Deletes the selected saved preset (the built-in ones stay).");
  delP.type = "button";
  delP.id = "ship-preset-delete";
  const presetNote = mk("div", "ship-help");
  presetNote.id = "ship-preset-note";
  const fillPresets = () => {
    const act = activeRenderPreset();
    sel.replaceChildren();
    for (const p of allPresets()) {
      const o = mk("option", undefined, `${p.label}${p.builtin ? "" : " (saved)"}`);
      o.value = p.id;
      sel.append(o);
    }
    sel.value = act.id;
    delP.disabled = !!act.builtin;
    presetNote.textContent = `Render sheets writes scales ${act.scales.join(", ")} on #${act.background}.`;
  };
  sel.addEventListener("change", () => {
    setActive(sel.value);
    fillPresets();
  });
  saveP.addEventListener("click", () => {
    const label = nameIn.value.trim();
    const scales = parseScales(scalesIn.value);
    if (!label) return void (presetNote.textContent = "Name the preset first.");
    if (!scales) return void (presetNote.textContent = "Scales: one to three numbers from 0.1 to 2.");
    if (!isHex6(bgIn.value)) return void (presetNote.textContent = "Background: six hex digits, for example 1e2430.");
    const next = parsePresets([...readCustom().filter((p) => p.label !== label), { label, scales, background: bgIn.value }]);
    if (!next.some((p) => p.label === label)) return void (presetNote.textContent = "That name is a built-in preset; pick another.");
    writeCustom(next);
    setActive(`custom:${label}`);
    fillPresets();
  });
  delP.addEventListener("click", () => {
    const act = activeRenderPreset();
    if (act.builtin) return;
    writeCustom(readCustom().filter((p) => p.id !== act.id));
    setActive("phone");
    fillPresets();
  });
  fillPresets();
  pr.append(mk("span", "label", "Render preset"), sel, nameIn, scalesIn, bgIn, saveP, delP, presetNote);
  also.append(pr);
  const out = mk("div", "ship-out");
  out.id = "ship-out";
  also.append(out, mk("p", "ship-note", "Progress and errors show in the status bar below."));
  card.append(also);

  const foot = mk("div", "soon-row");
  const homeBtn = tip(mk("button", "btn", "Back to Home"), "Leaves Ship and shows the Home screen.");
  homeBtn.type = "button";
  homeBtn.addEventListener("click", () => go("home"));
  const proBtn = tip(mk("button", "btn", "Open all tools (Pro)"), "Opens the Pro workspace with every tool.");
  proBtn.type = "button";
  proBtn.addEventListener("click", () => go("pro"));
  foot.append(homeBtn, proBtn);
  card.append(foot);
  host.append(card);

  // ---- Live parts -------------------------------------------------------------------------------------------------------------
  let board: BoardState = {};
  const repo: { rig: number | null; clip: number | null } = { rig: null, clip: null };
  let publishedGen = 0;

  async function refreshPublished(): Promise<void> {
    const gen = ++publishedGen;
    const info = await getJson<{ userRigs: string[] }>("/api/data");
    const clips = (await getJson<string[]>("/api/clips")) ?? [];
    const rows: PublishedRow[] = [];
    for (const r of info?.userRigs ?? []) {
      const body = await getJson<PublishPlanLike & { unregistered?: string }>(`/api/publish?kind=rig&probe=1&name=${encodeURIComponent(r)}`);
      if (body?.unregistered) rows.push({ kind: "rig", name: r, state: "not registered", detail: body.unregistered });
      else if (body) rows.push(publishedRow("rig", r, body));
    }
    for (const c of clips) {
      const plan = await getJson<PublishPlanLike>(`/api/publish?kind=clip&name=${encodeURIComponent(c)}`);
      if (plan) rows.push(publishedRow("clip", c, plan));
    }
    if (gen !== publishedGen || !table.isConnected) return;
    const st = getHost()?.shipState();
    repo.rig = st?.rig ? (rows.find((r) => r.kind === "rig" && r.name === st.rig)?.state === "same" ? 0 : rows.find((r) => r.kind === "rig" && r.name === st.rig) ? 1 : 0) : null;
    repo.clip = st?.clip ? (rows.find((r) => r.kind === "clip" && r.name === st.clip)?.state === "same" ? 0 : rows.find((r) => r.kind === "clip" && r.name === st.clip) ? 1 : 0) : null;
    const body = mk("tbody");
    const head = mk("tr");
    for (const t of ["What", "Name", "State", "Detail"]) head.append(mk("th", undefined, t));
    body.append(head);
    if (!rows.length) {
      const tr = mk("tr");
      const td = mk("td", "ship-table-empty", "Nothing to publish yet: edit a rig or save a clip first.");
      td.colSpan = 4;
      tr.append(td);
      body.append(tr);
    }
    for (const r of rows) {
      const tr = mk("tr");
      tr.dataset.kind = r.kind;
      tr.dataset.name = r.name;
      tr.dataset.state = r.state;
      const chip = mk("span", r.state === "same" ? "chip-ok" : r.state === "new" ? "chip-info" : r.state === "not registered" ? "chip-bad" : "chip-warn", r.state);
      const state = mk("td");
      state.append(chip);
      tr.append(mk("td", undefined, r.kind === "rig" ? "Rig" : "Clip"), mk("td", "name", r.name), state, mk("td", "ship-dim", r.detail));
      body.append(tr);
    }
    table.querySelector("tbody")?.replaceWith(body);
    void drawChecks();
  }

  /** Ship > Validate published: the Publish validator's report for every published rig, one line per check. */
  async function validatePublished(): Promise<void> {
    valOut.hidden = false;
    valOut.className = "ship-result";
    valOut.replaceChildren(mk("span", undefined, "Validating..."));
    try {
      const res = await fetch("/api/publish/validate");
      const body = (await res.json()) as { ok?: boolean; text?: string; error?: string };
      valOut.className = `ship-result ${res.ok && body.ok ? "ok" : "bad"}`;
      valOut.replaceChildren(...(body.text ?? body.error ?? `failed (${res.status})`).split("\n").map((line) => mk("span", line.startsWith("  ") ? "path" : undefined, line.trim())));
      getHost()?.status(body.ok ? "Validate published: PASS" : "Validate published: problems found (see Ship)", body.ok ? "ok" : "bad");
    } catch (error) {
      valOut.className = "ship-result bad";
      valOut.replaceChildren(mk("span", undefined, `Validate failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function readBoard(): Promise<void> {
    const h = getHost();
    board = (await getJson<BoardState>("/api/board")) ?? {};
    const names = h ? [...h.clips().map((c) => c.name), ...h.saved()] : [];
    const sum = boardSummary(names, board);
    summary.replaceChildren();
    const rows: [keyof typeof sum.counts, string, string][] = [
      ["done", "done", "chip-ok"],
      ["draft", "draft", "chip-info"],
      ["missing", "missing", "chip"],
      ["needs-recheck", "need re-check", "chip-warn"],
      ["broken", "broken", "chip-bad"]
    ];
    for (const [key, label, cls] of rows) summary.append(mk("span", cls, `${sum.counts[key]} ${label}`));
    summary.append(mk("p", "ship-progress", `${sum.counts.done} of ${sum.total} done`));
    boardFacts = { done: sum.counts.done, total: sum.total, broken: sum.counts.broken, recheck: sum.counts["needs-recheck"] };
    void drawChecks();
  }
  let boardFacts: { done: number; total: number; broken: number; recheck: number } | undefined;

  async function drawChecks(): Promise<void> {
    const h = getHost();
    const st = h?.shipState();
    const name = st?.rig ?? "no rig";
    lead.textContent = st?.rig ? `Rig ${name}${st.clip ? `, clip ${st.clip}` : ", no clip open"}. Check, apply, then publish.` : "Open a rig, then check, apply and publish.";
    const rows: CheckRow[] = [...checklist({
      rig: st?.rig ?? null,
      rigUnsaved: !!st?.rigUnsaved,
      clip: st?.clip ?? "",
      clipDirty: !!st?.clipDirty,
      clipApplied: !!st?.clipApplied,
      ...(boardFacts ? { board: boardFacts } : {}),
      ...(repo.rig === null && repo.clip === null ? {} : { repoDiff: { ...repo } })
    }), ...gateRows(window.atlasSwag?.lastGates?.() ?? null)];
    list.replaceChildren();
    for (const r of rows) {
      const li = mk("li", "ship-check");
      li.dataset.check = r.id;
      li.dataset.status = r.status;
      li.append(mk("span", STATUS_CLASS[r.status], STATUS_WORD[r.status]), mk("span", "ship-check-label", r.label), mk("span", "ship-dim", r.detail));
      list.append(li);
    }
    // Preflight: the working revision, hashed, so what Ship says is what the buttons act on ( / SH-07).
    const hash = st?.clipJson ? shortHash(await sha1(st.clipJson)) : "";
    pre.replaceChildren();
    const kv = mk("div", "kv");
    const put = (k: string, v: string, id?: string) => {
      kv.append(mk("span", "label", k));
      const e = mk("span", "v name", v);
      if (id) e.id = id;
      kv.append(e);
    };
    put("Rig", st?.rig ? `${st.rig} (${st.rigUnsaved ? "unsaved edits: Save rig first" : "saved"})` : "none open", "ship-pre-rig");
    put("Clip", st?.clip ? `${st.clip} (${st.clipDirty ? "unsaved" : "saved"}, ${st.clipApplied ? "applied" : "not applied"})` : "none open", "ship-pre-clip");
    put("Working clip revision", hash ? `sha1 ${hash}` : "no clip", "ship-pre-hash");
    put("Spine export reads", "the saved rig file, with every clip applied to it", "ship-pre-reads");
    pre.append(kv);
    const gated = !st?.clip;
    for (const t of ["save", "apply", "render", "export"]) {
      const b = document.getElementById(`ship-${t}`) as HTMLButtonElement | null;
      if (!b) continue;
      b.disabled = gated;
      const help = b.parentElement?.querySelector(".ship-help");
      if (!help) continue;
      help.classList.toggle("why", gated);
      if (gated) {
        if (!help.getAttribute("data-was")) help.setAttribute("data-was", help.textContent ?? "");
        help.textContent = "Open a clip first (Animate, then pick or create a clip).";
      } else if (help.getAttribute("data-was")) {
        help.textContent = help.getAttribute("data-was");
        help.removeAttribute("data-was");
      }
    }
  }

  checkBtn.addEventListener("click", () => {
    void (async () => {
      getHost()?.status("Checking the rig, the clip and the repo copy...");
      if (getHost()?.clipName) getHost()?.checkWholeClip();
      await Promise.all([readBoard(), refreshPublished()]);
      await drawChecks();
    })();
  });
  refreshBtn.addEventListener("click", () => void refreshPublished());

  // The Spine export writes its result into the Export tab's note (#spine-result); mirror it here with the path and a copy button.
  const mirrorSpine = () => {
    const src = document.getElementById("spine-result");
    if (!src) return;
    const path = src.dataset.path ?? "";
    const lines = [...src.children].map((c) => c.textContent ?? "");
    const started = lines.length > 0 && !/^Merges into/.test(lines[0]!);
    spineOut.hidden = !started;
    spineOut.className = `ship-result ${src.classList.contains("ok") ? "ok" : src.classList.contains("bad") ? "bad" : ""}`;
    spineOut.replaceChildren();
    for (const l of lines) spineOut.append(mk("div", path && l === `Wrote ${path}` ? "path" : undefined, l));
    if (path) {
      const bar = mk("div", "acts");
      const copy = tip(mk("button", "btn sm", "Copy path"), "Copies the folder the Spine project was written to.");
      copy.type = "button";
      copy.addEventListener("click", () => {
        const done = () => getHost()?.status(`Copied the path: ${path}`, "ok");
        const fail = () => getHost()?.status(`Could not copy; the file is at ${path}`, "bad");
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(path).then(done, fail);
        else fail();
      });
      bar.append(copy);
      spineOut.append(bar);
    }
  };
  mirrorSpine();
  const specs = document.getElementById("spine-result");
  if (specs && typeof MutationObserver !== "undefined") {
    const obs = new MutationObserver(() => {
      if (!document.getElementById("ship-spine")) return obs.disconnect();
      mirrorSpine();
    });
    obs.observe(specs, { childList: true, attributes: true });
    cleanups.push(() => obs.disconnect());
  }
  // Render sheets draws its previews on the canvas (hidden behind this screen): copy them here when they arrive.
  const view = document.getElementById("view");
  if (view && typeof MutationObserver !== "undefined") {
    const watch = new MutationObserver(() => {
      const imgs = document.querySelector("#exportresult .imgs");
      if (imgs) out.replaceChildren(imgs.cloneNode(true));
    });
    watch.observe(view, { childList: true, subtree: true });
    cleanups.push(() => watch.disconnect());
  }
  const off = getHost()?.on("clip", () => void drawChecks());
  const off2 = getHost()?.on("rig", () => void drawChecks());
  const onGates = (): void => void drawChecks();
  window.addEventListener("atlas-gates", onGates);
  cleanups.push(() => off?.(), () => off2?.(), () => window.removeEventListener("atlas-gates", onGates));

  void drawChecks();
  void readBoard();
  void refreshPublished();
  return () => cleanups.forEach((f) => f());
}
