/*
 * Atlas Animator editor: the editor side of "Phone preview" (server: phoneLive.ts, page: phonePage.ts). A "Phone preview" button turns
 * the LAN server on and shows a small popover with the QR code and link; while it runs, every committed change (clip, facing, rig,
 * skins) is pushed to the server shortly after (debounced), and the phone, which polls twice a second, shows it within about a second.
 * Nothing is sent while the preview is off.
 */
import { iconHtml } from "./icons.js";
import { encodeQr, qrSvg } from "./phoneQr.js";
import { stateKey } from "./phoneModel.js";

export interface PhoneSnapshot {
  clipName: string;
  clip: unknown;
  facing: "left" | "right";
  /** Objects/strings whose identity says the rig the phone shows changed (raw document, skins, chosen skin names...). */
  rigIdentity: unknown[];
  /** The rig as the phone needs it; only called when `rigIdentity` changed. */
  rig(): { raw: unknown; meta: { document: string; atlas: string; standIn: boolean; skins: string[] } };
}

export interface PhonePushHost {
  /** The editor's current state, or null before a rig is mounted. */
  snapshot(): PhoneSnapshot | null;
  /** The Phone preview button is inserted right before this element (a header button, so it shows in every workspace). */
  before: HTMLElement;
}

interface Status {
  running: boolean;
  url: string | null;
  urls: string[];
  lan: boolean;
  phones: number;
}

const PUSH_DELAY_MS = 150;

const css = `
#phonebtn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
#phonebtn { position: relative; }
#phonebtn.on { background: var(--accent-soft, rgba(240, 184, 74, 0.14)); border-color: var(--accent-line, #4a3d1c); color: var(--accent, #f0b84a); }
#phonebtn.on::after { content: ""; position: absolute; top: 3px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--ok, #6bd68f); }
#phonepop { position: fixed; z-index: var(--z-popover, 8); width: 280px; padding: 12px; background: var(--panel, #1b1f27); border: 1px solid var(--line, #2d3443); border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5); display: none; }
#phonepop.open { display: block; }
#phonepop h3 { margin: 0 0 8px; font-size: 13px; color: var(--accent, #f0b84a); }
#phonepop .qr { width: 200px; height: 200px; margin: 0 auto 8px; background: #fff; border-radius: 4px; }
#phonepop .qr svg { width: 100%; height: 100%; display: block; }
#phonepop .urlrow { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; }
#phonepop .url { flex: 1 1 auto; min-width: 0; font: 12px/1.35 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; user-select: text; color: var(--text, #d9dee8); }
#phonepop .st { font-size: 12px; color: var(--dim, #8c96a8); margin-bottom: 8px; }
#phonepop .st.ok { color: var(--ok, #6bd68f); }
#phonepop .st.bad { color: var(--warn, #ffc65c); }
#phonepop .row { display: flex; gap: 6px; justify-content: space-between; }
`;

export function createPhonePush(host: PhonePushHost): { changed(): void; state(): { running: boolean; url: string | null; phones: number } } {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const btn = document.createElement("button");
  btn.id = "phonebtn";
  btn.className = "btn-icon";
  btn.setAttribute("aria-label", "Phone preview");
  btn.innerHTML = iconHtml("phone");
  btn.title = "Phone preview: show the clip you are editing live on your phone (same Wi-Fi as this PC): press, then scan the QR code with the phone camera";
  host.before.before(btn);
  const pop = document.createElement("div");
  pop.id = "phonepop";
  document.body.append(pop);

  let status: Status = { running: false, url: null, urls: [], lan: false, phones: 0 };
  let error = "";
  let lastKey = "";
  let lastRigKey = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const identity = (parts: unknown[]): string => parts.map((p) => (p && typeof p === "object" ? (ids.get(p) ?? (ids.set(p, nextId), nextId++)) : String(p))).join(",");

  const call = async (path: string, method = "GET", body?: unknown): Promise<Status> => {
    const res = await fetch(`/api/phone/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
    const json = (await res.json()) as Status & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };

  const render = (): void => {
    btn.classList.toggle("on", status.running);
    if (!pop.classList.contains("open")) return;
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 296, r.right - 280))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    let svg = "";
    if (status.url) {
      try {
        svg = qrSvg(encodeQr(status.url));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const state = error
      ? `<div class="st bad">${error}</div>`
      : !status.running
        ? `<div class="st">Starting...</div>`
        : !status.lan
          ? `<div class="st bad">No Wi-Fi/LAN address found on this PC, so the phone cannot reach it. Connect this PC to the same Wi-Fi as the phone and press Stop, then Phone preview again.</div>`
          : status.phones > 0
            ? `<div class="st ok">Phone connected (${status.phones}). Edits show in about a second.</div>`
            : `<div class="st">Scan with the phone camera and open the link. Same Wi-Fi as this PC. If Windows asks, allow Node.js on private networks.</div>`;
    pop.innerHTML = `<h3>Phone preview</h3>${svg ? `<div class="qr">${svg}</div>` : ""}${status.urls.length ? `<div class="urlrow"><div class="url">${status.urls.join("<br>")}</div><button id="phonecopy" class="btn sm" title="Copy the link">Copy</button></div>` : ""}${state}<div class="row"><button id="phonestop"${status.running ? "" : " disabled"}>Stop</button><button id="phoneclose">Close</button></div>`;
    pop.querySelector("#phonestop")?.addEventListener("click", () => void stop());
    pop.querySelector("#phoneclose")?.addEventListener("click", () => close());
    pop.querySelector("#phonecopy")?.addEventListener("click", (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard?.writeText(status.urls[0] ?? "").then(
        () => (b.textContent = "Copied"),
        () => undefined
      );
    });
  };

  const poll = async (): Promise<void> => {
    try {
      status = await call("status");
      if (!status.running) stopPolling();
    } catch {
      /* the dev server is restarting */
    }
    render();
  };
  const startPolling = (): void => {
    poller ??= setInterval(() => void poll(), 1500);
  };
  const stopPolling = (): void => {
    if (poller) clearInterval(poller);
    poller = null;
  };

  const push = async (): Promise<void> => {
    timer = null;
    if (!status.running) return;
    const snap = host.snapshot();
    if (!snap) return;
    const rigKey = identity(snap.rigIdentity);
    const key = stateKey({ clipName: snap.clipName, clip: snap.clip, facing: snap.facing, rigKey });
    if (key === lastKey) return;
    try {
      await call("state", "POST", { clipName: snap.clipName, clip: snap.clip, facing: snap.facing, rig: rigKey !== lastRigKey ? snap.rig() : undefined });
      lastKey = key;
      lastRigKey = rigKey;
    } catch {
      /* retried by the next change or poll */
    }
  };
  const changed = (): void => {
    if (!status.running || timer) return;
    timer = setTimeout(() => void push(), PUSH_DELAY_MS);
  };

  const open = (): void => {
    pop.classList.add("open");
    render();
  };
  const close = (): void => {
    pop.classList.remove("open");
  };
  const start = async (): Promise<void> => {
    error = "";
    open();
    try {
      status = await call("start", "POST");
      lastKey = "";
      lastRigKey = "";
      startPolling();
      await push();
    } catch (e) {
      error = `Could not start: ${e instanceof Error ? e.message : String(e)}`;
    }
    render();
  };
  const stop = async (): Promise<void> => {
    try {
      status = await call("stop", "POST");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    stopPolling();
    close();
    render();
  };

  btn.addEventListener("click", () => {
    if (!status.running) void start();
    else if (pop.classList.contains("open")) close();
    else open();
  });
  document.addEventListener("pointerdown", (e) => {
    if (pop.classList.contains("open") && !pop.contains(e.target as Node) && e.target !== btn) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // The server may already be running (the editor page was reloaded): pick it up again.
  void call("status")
    .then((s) => {
      status = s;
      if (s.running) {
        startPolling();
        void push();
      }
      render();
    })
    .catch(() => undefined);

  return { changed, state: () => ({ running: status.running, url: status.url, phones: status.phones }) };
}
