/*
 * Atlas Animator editor: the server-tick hit lock on the timeline (maths in hitLockModel.ts).
 *
 *   - faint 20 Hz tick marks along the ruler (the server lands hits on these);
 *   - an amber badge on the ruler at any `hit` event that is not on its profile step's contact frame, with a dashed pointer to the
 *     right frame; clicking the badge snaps the hit there (one undo step);
 *   - a red shade after the last allowed frame when the clip is longer than windupMs + recoveryMs;
 *   - a live chip over the canvas ("Hit on tick ✓" / "Hit 1 frame late ▾") whose menu lists the problems and snaps the hit.
 * It reads the editor only through the host and edits a clip only by `host.commit`.
 */
import { clipFps, frameCount } from "./clipModel.js";
import { addTimelineDecorator, type EditorHost } from "./host.js";
import { hitChip, hitStatuses, lengthIssue, snapHit, tickTimes, type HitStatus } from "./hitLockModel.js";

const AMBER = "#ffc65c";
const TICK = "rgba(95, 179, 255, 0.38)";

export interface HitLockApi {
  /** Snaps every off-frame hit onto its contact frame; returns how many moved. */
  snapAll(): number;
  chip(): { state: string; text: string };
}

export function installHitLock(host: EditorHost): HitLockApi | null {
  const view = document.getElementById("view");
  const tl = document.getElementById("tl");
  if (!view || !tl) return null;

  const pill = document.createElement("button");
  pill.type = "button";
  pill.id = "hitlock-pill";
  pill.setAttribute("aria-haspopup", "true");
  pill.title = "Server-tick hit lock: hits land on 20 Hz server ticks while the clip plays at 30 fps";
  const menu = document.createElement("div");
  menu.id = "hitlock-menu";
  menu.hidden = true;
  const wrap = document.createElement("div");
  wrap.id = "hitlock";
  wrap.append(pill, menu);
  // Mounted in the canvas toolbar row (#vtop), right of its spacer, so it can never sit on another control.
  const bar = document.getElementById("vtop");
  const anchor = bar?.querySelector(":scope > .spacer")?.nextSibling ?? null;
  if (bar) bar.insertBefore(wrap, anchor);
  else view.append(wrap);

  const compute = () => {
    const clip = host.clip;
    const hits = hitStatuses(clip, host.clipName);
    const length = lengthIssue(clip, host.clipName);
    return { hits, length, chip: hitChip(hits, length) };
  };

  function snap(status: HitStatus): void {
    const next = snapHit(host.clip, status);
    host.commit(next, `Hit moved to frame ${status.want} (server tick ${status.wantTick})`);
  }

  function paint(): void {
    const { hits, length, chip } = compute();
    wrap.hidden = chip.state === "none";
    pill.textContent = chip.text;
    pill.className = chip.state === "bad" ? "bad" : "";
    pill.setAttribute("aria-expanded", String(!menu.hidden));
    menu.replaceChildren();
    for (const line of chip.detail) {
      const p = document.createElement("div");
      p.className = "hitlock-line";
      p.textContent = line;
      menu.append(p);
    }
    for (const h of hits.filter((x) => !x.ok)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hitlock-snap";
      b.textContent = `Snap hit to frame ${h.want}`;
      b.title = "Move the hit marker onto the profile step's contact frame";
      b.addEventListener("click", () => {
        snap(h);
        menu.hidden = true;
      });
      menu.append(b);
    }
    if (!chip.detail.length) menu.hidden = true;
    void length;
  }

  pill.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    paint();
  });

  let signature = "";
  const refresh = (): void => {
    const c = host.clip;
    const sig = `${host.clipName}|${c.duration}|${c.fps}|${JSON.stringify(c.events)}`;
    if (sig === signature) return;
    signature = sig;
    paint();
    host.redrawTimeline();
  };
  for (const ev of ["clip", "pose", "save", "rig"] as const) host.on(ev, refresh);
  refresh();

  // ---- timeline ----
  let badges: { x0: number; x1: number; y0: number; y1: number; status: HitStatus }[] = [];
  addTimelineDecorator((g, frameX, width, _height, rulerH) => {
    const clip = host.clip;
    const fps = clipFps(clip);
    const left = frameX(0);
    const end = frameX(frameCount(clip));
    const ticks = tickTimes(clip.duration);
    const gap = ticks.length > 1 ? frameX(ticks[1]! * fps) - frameX(0) : 0;
    g.save();
    if (gap >= 3.5) {
      g.fillStyle = TICK;
      for (let k = 0; k < ticks.length; k++) {
        const x = frameX(ticks[k]! * fps);
        if (x < left - 1 || x > width) continue;
        g.fillRect(Math.round(x), rulerH - (k % 20 === 0 ? 7 : 4), 1, k % 20 === 0 ? 7 : 4);
      }
    }
    badges = [];
    const length = lengthIssue(clip, host.clipName);
    if (length) {
      const x = frameX(length.allowedFrames);
      g.fillStyle = "rgba(255, 107, 107, 0.10)";
      g.fillRect(x, rulerH, Math.max(0, end - x + 1), _height - rulerH);
      g.fillStyle = "#ff6b6b";
      g.fillRect(Math.round(x), rulerH - 10, 1, _height);
      g.font = "10px Segoe UI, system-ui, sans-serif";
      g.textAlign = "left";
      g.fillText(`limit ${length.allowedFrames}`, x + 3, rulerH - 12);
    }
    for (const status of hitStatuses(clip, host.clipName)) {
      if (status.ok) continue;
      const x = frameX(status.frame);
      const wx = frameX(status.want);
      g.strokeStyle = AMBER;
      g.fillStyle = AMBER;
      g.lineWidth = 1;
      g.setLineDash([2, 2]);
      g.beginPath();
      g.moveTo(x, rulerH - 3);
      g.lineTo(wx, rulerH - 3);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(wx, rulerH - 9);
      g.lineTo(wx + 4, rulerH - 3);
      g.lineTo(wx, rulerH + 3);
      g.lineTo(wx - 4, rulerH - 3);
      g.closePath();
      g.stroke();
      // The badge: a small rounded tag on the hit with "!" and the offset.
      const label = `! ${status.delta > 0 ? "+" : ""}${status.delta}`;
      g.font = "bold 10px Segoe UI, system-ui, sans-serif";
      const w = Math.ceil(g.measureText(label).width) + 8;
      const bx = Math.round(x - w / 2);
      const by = 2;
      const h = 13;
      g.beginPath();
      g.roundRect(bx, by, w, h, 6);
      g.fill();
      g.fillStyle = "#1b1f27";
      g.textAlign = "center";
      g.fillText(label, bx + w / 2, by + 10);
      g.textAlign = "left";
      badges.push({ x0: bx, x1: bx + w, y0: by, y1: by + h, status });
    }
    g.restore();
  });

  // Capture phase on the timeline canvas: a click on a badge snaps the hit and never reaches the scrub handler.
  tl.addEventListener(
    "pointerdown",
    (e) => {
      const r = tl.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const hit = badges.find((b) => x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      snap(hit.status);
    },
    true
  );
  tl.addEventListener("pointermove", (e) => {
    const r = tl.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const over = badges.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    tl.title = over ? `Hit is ${Math.abs(over.status.delta)} frame${Math.abs(over.status.delta) === 1 ? "" : "s"} ${over.status.delta > 0 ? "late" : "early"}: click to snap it to frame ${over.status.want}` : "";
  });

  const api: HitLockApi = {
    snapAll() {
      let moved = 0;
      for (const h of hitStatuses(host.clip, host.clipName)) {
        if (h.ok) continue;
        snap(h);
        moved++;
      }
      return moved;
    },
    chip: () => ({ state: compute().chip.state, text: compute().chip.text })
  };
  (window as unknown as { atlasHitLock?: HitLockApi & { badges: () => { x: number; y: number }[] } }).atlasHitLock = {
    ...api,
    /** Screen centres of the badges on the timeline (for tests and demos). */
    badges: () => {
      const r = tl.getBoundingClientRect();
      return badges.map((b) => ({ x: r.left + (b.x0 + b.x1) / 2, y: r.top + (b.y0 + b.y1) / 2 }));
    }
  };
  return api;
}
