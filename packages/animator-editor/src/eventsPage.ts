/*
 * Atlas Animator editor: the Events page of the Rig inspector.
 *
 * Opened from the Tree's Events group (or an event row). Lists the rig's event definitions (the project's six are always there),
 * each with its default Int, Float, String and Audio, plus Rename and Remove; "Add event" declares a new one. Clip keys fire
 * these events and may override the payload (Animate, key inspector).
 */
import { promptDialog } from "./dialog.js";
import { EVENT_NAMES, eventColor, type EventDef } from "./eventModel.js";
import { declaredEvents, planAddEvent, planAddGameEvents, planRemoveEvent, planRenameEvent, planSetEvent } from "./eventRigPlans.js";
import { nodeHeader, plainRow, section, staticName, type Page, type PageCtx } from "./inspector.js";

const isGame = (name: string): boolean => (EVENT_NAMES as readonly string[]).includes(name);

export function eventsPage(c: PageCtx, selected: string | null, show: (name: string | null) => void): Page {
  const { ui: u } = c;
  const declared = declaredEvents(c.raw);
  const names = [...new Set([...EVENT_NAMES, ...Object.keys(declared)])] as string[];
  if (selected && names.includes(selected)) {
    names.splice(names.indexOf(selected), 1);
    names.unshift(selected);
  }
  const head = nodeHeader({
    icon: "events",
    tone: "--c-key-event",
    kind: "EVENTS",
    name: staticName(selected ?? "Events"),
    crumbs: [{ text: "Events", ...(selected ? { go: () => show(null) } : {}) }, ...(selected ? [{ text: selected }] : [])],
    tip: "The rig's event definitions: named moments a clip can fire, each with default int, float, string and audio values"
  });

  const nameIn = u.el("input", { type: "text", className: "field", id: "setup-event-name", placeholder: "footstep", title: "Name of the new event: letters, digits, _ . - (for example footstep, sparkle, door_open)" });
  const add = u.el("button", { type: "button", className: "btn btn-primary", id: "setup-event-add", textContent: "Add event", title: "Declare this event in the rig (undoable); then key it in Animate" });
  const doAdd = (): void => {
    const name = nameIn.value.trim();
    if (!name) return u.status("Type a name for the event first", "bad");
    void u.run(`Add event ${name}`, (raw) => planAddEvent(raw, name)).then((ok) => ok && show(name));
  };
  add.addEventListener("click", doAdd);
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });
  const missing = EVENT_NAMES.filter((n) => !(n in declared));
  const addBody: HTMLElement[] = [plainRow("Name", nameIn, add)];
  if (missing.length) {
    const game = u.el("button", { type: "button", className: "btn", id: "setup-event-game", textContent: `Save the ${missing.length} game event${missing.length === 1 ? "" : "s"}`, title: `Write ${missing.join(", ")} into the rig file (they are always available; this makes them editable here)` });
    game.addEventListener("click", () => void u.run("Add the project events", (raw) => planAddGameEvents(raw)));
    addBody.push(u.el("div", { className: "insp-line" }, game));
  }

  const field = (label: string, input: HTMLElement, tip: string): HTMLElement => {
    input.title = tip;
    return plainRow(label, input);
  };
  const cards = names.map((name) => {
    const def: EventDef = declared[name] ?? { int: 0, float: 0, string: "", audio: "" };
    const inFile = name in declared;
    const card = u.el("div", { className: `insp-card ev-card${name === selected ? " sel" : ""}` });
    card.dataset["event"] = name;
    const intIn = u.num(def.int, "1", (v) => void u.run(`Event ${name} int`, (raw) => planSetEvent(raw, name, { int: v })), 64);
    const floatIn = u.num(def.float, "0.1", (v) => void u.run(`Event ${name} float`, (raw) => planSetEvent(raw, name, { float: v })), 64);
    const strIn = u.el("input", { type: "text", className: "field", value: def.string });
    strIn.addEventListener("change", () => void u.run(`Event ${name} string`, (raw) => planSetEvent(raw, name, { string: strIn.value })));
    const audIn = u.el("input", { type: "text", className: "field", value: def.audio, placeholder: "sound name" });
    audIn.addEventListener("change", () => void u.run(`Event ${name} audio`, (raw) => planSetEvent(raw, name, { audio: audIn.value })));
    intIn.dataset["field"] = `${name}.int`;
    floatIn.dataset["field"] = `${name}.float`;
    strIn.dataset["field"] = `${name}.string`;
    audIn.dataset["field"] = `${name}.audio`;
    const rename = u.el("button", { type: "button", className: "btn", textContent: "Rename", title: `Rename ${name}: the keys that fire it in every clip follow` });
    rename.dataset["rename"] = name;
    rename.addEventListener("click", () => {
      void promptDialog({ title: `Rename event ${name}`, message: "New name (letters, digits, _ . -). Every clip key that fires it is renamed too.", value: name, confirmLabel: "Rename", id: "rename-event-dialog" }).then((to) => {
        if (to === null) return;
        const next = to.trim();
        if (next && next !== name) void u.run(`Rename event ${name} to ${next}`, (raw) => planRenameEvent(raw, name, next)).then((ok) => ok && show(next));
      });
    });
    const remove = u.el("button", { type: "button", className: "btn btn-danger", textContent: "Remove", title: isGame(name) ? `${name} is a built-in game event: it is always listed and cannot be removed` : `Remove ${name} and every clip key that fires it (asks first; Undo brings it back)` });
    remove.dataset["remove"] = name;
    remove.disabled = isGame(name) || !inFile;
    remove.addEventListener("click", () => {
      void u.ask({ title: `Remove event ${name}?`, message: `Remove the event "${name}" and every clip key that fires it? Undo brings them back.`, confirmLabel: "Remove event", danger: true, id: "remove-event-dialog" }).then(async (ok) => {
        if (!ok) return;
        await u.run(`Remove event ${name}`, (raw) => planRemoveEvent(raw, name));
        show(null);
      });
    });
    const dot = u.el("span", { className: "ev-dot" });
    dot.style.background = eventColor(name);
    const pick = u.el("button", { type: "button", className: "name ev-name", textContent: name, title: `Edit ${name}` });
    pick.addEventListener("click", () => show(name));
    const title = u.el("div", { className: "ev-title" }, dot, pick);
    if (!inFile) title.append(u.el("span", { className: "chip", textContent: "game", title: "A built-in game event: available in every rig. Changing a value saves it into this rig file" }));
    card.append(
      title,
      field("Int", intIn, "Default int payload (whole number) a key gets when it does not set its own"),
      field("Float", floatIn, "Default float payload a key gets when it does not set its own"),
      field("String", strIn, "Default string payload (a hit key uses it for its attack-profile link)"),
      field("Audio", audIn, "Sound name played with the event (the project or runtime looks it up; blank for none)"),
      u.el("div", { className: "insp-line" }, rename, remove)
    );
    return card;
  });
  const list = section({ id: "events.list", title: "Defined events", meta: `${names.length}`, tip: "every event a clip can fire, with its default payload", open: true, body: cards });
  return { head, sections: [section({ id: "events.add", title: "Add an event", meta: "", tip: "declare a new event for this rig", open: true, body: addBody }), list], foot: [] };
}
