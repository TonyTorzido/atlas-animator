/*
 * Atlas Animator editor: original implementation.
 *
 * The browser side of autosave: a timer (every 60 s) plus explicit triggers (a clip switch), one write in flight at a
 * time, a write only when the content changed since the last one. Saving never blocks the UI: the snapshot is a few
 * object references plus one JSON.stringify, the request is an ordinary async fetch, the timer yields to idle time, and a
 * failed write is only reported (the next tick tries again).
 */
import { AUTOSAVE_INTERVAL_MS, fingerprint, type AutosavePayload } from "./autosaveModel.js";

export interface AutosaveHost {
  /** The payload to write now (the working clip and any unsaved rig, setup or skin edits), or null when there is nothing unsaved. Read synchronously. */
  snapshot(reason: string): AutosavePayload | null;
  /** A version was written (or found identical to the newest one). */
  written(info: { clip: string; id: string; skipped: boolean; reason: string }): void;
  failed(message: string): void;
  /** A write started (true) or the queue drained (false); the status bar shows "Autosaving" in between. */
  busy?(on: boolean): void;
}

export interface AutosaveInfo {
  intervalMs: number;
  running: boolean;
  inFlight: boolean;
  writes: number;
  skipped: number;
  failures: number;
  lastId: string | null;
  lastAt: number | null;
}

export function createAutosaver(host: AutosaveHost, intervalMs = AUTOSAVE_INTERVAL_MS) {
  let interval = intervalMs;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  const pending = new Map<string, { payload: AutosavePayload; fp: string; reason: string }>();
  const last = new Map<string, string>();
  const info = { writes: 0, skipped: 0, failures: 0, lastId: null as string | null, lastAt: null as number | null };

  async function send(payload: AutosavePayload, fp: string, reason: string): Promise<void> {
    try {
      const res = await fetch("/api/autosave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await res.json().catch(() => ({}))) as { id?: string; skipped?: boolean; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`);
      last.set(payload.clip, fp);
      if (body.skipped) info.skipped++;
      else info.writes++;
      info.lastId = body.id;
      info.lastAt = Date.now();
      host.written({ clip: payload.clip, id: body.id, skipped: !!body.skipped, reason });
    } catch (error) {
      info.failures++;
      host.failed(error instanceof Error ? error.message : String(error));
    }
  }

  /** Writes a version now if something unsaved changed since the last one. The snapshot is taken before this returns; the request finishes later. */
  function now(reason: string): Promise<void> {
    const payload = host.snapshot(reason);
    if (!payload) return inFlight ?? Promise.resolve();
    const fp = fingerprint(payload);
    if (last.get(payload.clip) === fp && !pending.has(payload.clip)) return inFlight ?? Promise.resolve();
    // One request at a time; what arrives meanwhile (the outgoing clip of a switch, say) waits its turn, newest per clip.
    pending.set(payload.clip, { payload, fp, reason });
    inFlight ??= (async () => {
      await Promise.resolve(); // `inFlight` is assigned before the loop can finish
      host.busy?.(true);
      try {
        while (pending.size) {
          const [clip, item] = pending.entries().next().value as [string, { payload: AutosavePayload; fp: string; reason: string }];
          pending.delete(clip);
          if (last.get(clip) !== item.fp) await send(item.payload, item.fp, item.reason);
        }
      } finally {
        inFlight = null;
        host.busy?.(false);
      }
    })();
    return inFlight;
  }

  const tick = (): void => {
    const run = (): void => void now("interval");
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(run, { timeout: 2000 });
    else setTimeout(run, 0);
  };

  return {
    start(): void {
      if (timer === null) timer = setInterval(tick, interval);
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    /** Changes the interval (milliseconds); a running timer restarts. */
    setInterval(ms: number): void {
      interval = Math.max(50, ms);
      if (timer !== null) {
        clearInterval(timer);
        timer = setInterval(tick, interval);
      }
    },
    now,
    /** Forget what was written (the next change check starts clean). */
    reset(clip?: string): void {
      if (clip) last.delete(clip);
      else last.clear();
    },
    info: (): AutosaveInfo => ({ intervalMs: interval, running: timer !== null, inFlight: inFlight !== null, ...info })
  };
}

export type Autosaver = ReturnType<typeof createAutosaver>;
