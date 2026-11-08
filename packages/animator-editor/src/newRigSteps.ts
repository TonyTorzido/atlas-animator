/*
 * Atlas Animator editor: the guide card of a freshly made rig (browser).
 *
 *   Drop parts -> Draw bones -> Auto-bind -> Mesh / weights (optional) -> Animate
 *
 * Shown as a progress stepper along the top of the canvas (done steps tick, the current one is highlighted with its button).
 *
 * `rigSteps` is pure: it reads a few facts about the open rig and says which step is done and which is next. The card sits over the Rig
 * workspace's canvas, only for rigs made with New rig, and each step has the button that does it.
 */
export interface RigFacts {
  slots: number;
  /** Bones other than the root. */
  bones: number;
  /** Slots on a bone other than the root. */
  boundSlots: number;
  meshes: number;
  clips: number;
}

export type StepId = "parts" | "bones" | "bind" | "mesh" | "animate";

export interface RigStep {
  id: StepId;
  label: string;
  action: string;
  title: string;
  done: boolean;
  optional: boolean;
  now: boolean;
}

export function rigSteps(f: RigFacts): RigStep[] {
  const steps: Omit<RigStep, "now">[] = [
    { id: "parts", label: "Drop parts", action: "Add", title: "Add more PNGs or a PSD to this rig (you can also drop them on the canvas)", done: f.slots > 0, optional: false },
    { id: "bones", label: "Draw bones", action: "Draw", title: "Setup: the Draw bone tool (B). Drag from the parent to the tip", done: f.bones > 0, optional: false },
    { id: "bind", label: "Auto-bind", action: "Bind", title: "Attach each slot to the nearest bone", done: f.slots > 0 && f.boundSlots >= f.slots, optional: false },
    { id: "mesh", label: "Mesh / weights (optional)", action: "Mesh", title: "Setup: trace a mesh (M) and paint weights (W) for bending parts", done: f.meshes > 0, optional: true },
    { id: "animate", label: "Animate", action: "Go", title: "Open the Animate workspace and key a clip", done: f.clips > 0, optional: false }
  ];
  const nowIndex = steps.findIndex((s) => !s.done && !s.optional);
  return steps.map((s, i) => ({ ...s, now: i === nowIndex }));
}

export interface StepsCardDeps {
  facts(): RigFacts;
  run(id: StepId): void;
}

export interface StepsCard {
  render(visible: boolean): void;
}

export function mountStepsCard(host: HTMLElement, deps: StepsCardDeps): StepsCard {
  const card = document.createElement("section");
  card.id = "newrig-steps";
  card.className = "newrig-steps";
  card.hidden = true;
  host.append(card);
  let dismissed = false;
  return {
    render(visible) {
      card.hidden = !visible || dismissed;
      if (card.hidden) return;
      card.replaceChildren();
      const x = document.createElement("button");
      x.className = "close btn-icon";
      x.type = "button";
      x.textContent = "Hide";
      x.title = "Hide this progress bar for now";
      x.addEventListener("click", () => {
        dismissed = true;
        card.hidden = true;
      });
      const ol = document.createElement("ol");
      ol.setAttribute("aria-label", "Rig this character: progress");
      rigSteps(deps.facts()).forEach((s, i) => {
        const li = document.createElement("li");
        li.className = `${s.done ? "done" : ""} ${s.now ? "now" : ""}`.trim();
        li.dataset.step = s.id;
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = s.done ? "✓" : String(i + 1);
        const label = document.createElement("span");
        label.className = "step-label";
        label.textContent = s.label.replace(" (optional)", "");
        li.append(dot, label);
        if (s.optional) li.append(Object.assign(document.createElement("em"), { textContent: "optional" }));
        const b = document.createElement("button");
        b.type = "button";
        b.className = s.now ? "btn-primary" : "btn";
        b.textContent = s.action;
        b.title = s.title;
        b.addEventListener("click", () => deps.run(s.id));
        li.append(b);
        ol.append(li);
      });
      card.append(ol, x);
    }
  };
}
