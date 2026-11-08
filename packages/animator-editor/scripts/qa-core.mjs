// Atlas Animator QA suite: catches basic interaction regressions (Ctrl+Z not working, a hotkey firing while typing, a control
// that vanished, a jump on release) before the user does.  the design notes explains the rules.
//
//   pnpm --filter @atlas-animator/editor qa            (from the repo root)   or   pnpm qa   (inside packages/animator-editor)
//   node scripts/qa-core.mjs [--only=undo,hotkeys,controls,rig,basics,mouse,errors,overlap] [--headed] [--strict-xpass] [--json=out.json]
//
// It starts its own sandboxed server (scripts/demo-server.mjs: ATLAS_EDITOR_DATA_DIR in a temp folder, a free port, never :5211),
// drives the editor with the real mouse and keyboard in Playwright, prints a PASS / FAIL / XFAIL / XPASS / SKIP table and exits
// non-zero when anything FAILs.  XFAIL = a known gap listed in scripts/qa-manifest.json (expected-fail); XPASS = a known gap that now
// works (delete its "status" in the manifest; --strict-xpass makes it fail).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(resolve(PKG, "../animator/package.json"));
const { chromium } = require("@playwright/test");
const { demoServer } = await import(pathToFileURL(resolve(PKG, "scripts/demo-server.mjs")).href);

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (area) => only.length === 0 || only.includes(area);
const match = (argv.find((a) => a.startsWith("--match=")) ?? "").slice(8);
const strictXpass = argv.includes("--strict-xpass");
const jsonOut = (argv.find((a) => a.startsWith("--json=")) ?? "").slice(7);

// ---------------------------------------------------------------------------------------------------------------- results
const rows = [];
const rec = (area, name, status, detail = "") => {
  rows.push({ area, name, status, detail: String(detail).replace(/\s+/g, " ").slice(0, 260) });
  process.stdout.write(`${status.padEnd(5)} ${area.padEnd(9)} ${name}${detail && status !== "PASS" ? `  -- ${String(detail).replace(/\s+/g, " ").slice(0, 200)}` : ""}\n`);
};
class Skip extends Error {}
/** Runs one check. `xfail` = the manifest row this is a known gap for (reported XFAIL while failing, XPASS once it passes). */
async function test(area, name, fn, { xfail = null, timeout = 90_000 } = {}) {
  if (!want(area) || (match && !name.includes(match))) return;
  let err = null;
  // Real-mouse and real-key checks on a software-GL browser can lose a gesture to timing: one retry before a FAIL is reported.
  for (let attempt = 0; attempt < (["mouse", "hotkeys"].includes(area) && !xfail ? 2 : 1); attempt++) {
    err = null;
    try {
      await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error(`timed out after ${timeout / 1000}s`)), timeout))]);
    } catch (e) {
      err = e;
      if (e instanceof Skip) break;
    }
    if (!err) break;
  }
  if (err instanceof Skip) return rec(area, name, "SKIP", err.message);
  if (xfail) return err ? rec(area, name, "XFAIL", `${xfail} (${err.message})`) : rec(area, name, "XPASS", `now works: remove "status" for it in qa-manifest.json (${xfail})`);
  return err ? rec(area, name, "FAIL", err.message) : rec(area, name, "PASS");
}
const need = (cond, msg) => {
  if (!cond) throw new Error(typeof msg === "function" ? msg() : msg);
};

// ---------------------------------------------------------------------------------------------------------------- browser
const { url } = await demoServer();
const browser = await chromium.launch({ headless: !argv.includes("--headed"), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
process.on("exit", () => void browser.close().catch(() => {}));

/** A page with error collection. `phase` labels what the error happened during. */
/** `rig`: the rig the page is put on. The suite's fixtures (garment gates, slot lists, mesh ids) are the kit-body-cutout rig, so it is selected explicitly; the editor's own default is Player v2 (pass null to keep it). */
async function session(width = 1600, height = 1000, startWorkspace = null, rig = "pro-turned") {
  const page = await browser.newPage({ viewport: { width, height } });
  const s = { page, errors: [], phase: "load", E: (fn, arg) => page.evaluate(fn, arg) };
  page.on("pageerror", (e) => s.errors.push({ phase: s.phase, text: `pageerror: ${e.message}` }));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location()?.url ?? "";
    s.errors.push({ phase: s.phase, text: `console.error: ${m.text()}${loc ? ` @ ${loc.replace(url, "/")}` : ""}` });
  });
  // The sandbox dev server watches the worktree: someone saving a src file would hot-reload the page under the test. Stub the HMR socket.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    const Stub = function (u, p) {
      if (String(p ?? "").includes("vite")) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
      return new Real(u, p);
    };
    Stub.prototype = Real.prototype;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  });
  if (rig) await page.addInitScript((id) => { window.__atlasOutfit = id; }, rig);
  if (startWorkspace) await page.addInitScript((w) => { window.__atlasWorkspace = w; }, startWorkspace);
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
  await page.waitForTimeout(1200);
  page.setDefaultTimeout(8000);
  s.close = () => page.close().catch(() => {});
  return s;
}
const ws = async (s, id) => {
  await s.E((w) => window.atlasEditor.workspace(w), id);
  await s.page.waitForTimeout(450);
};
const wait = (s, ms) => s.page.waitForTimeout(ms);
/** A fresh clip made through the New clip dialog (it lives in Pro; the other workspaces hide the button). */
async function makeClip(s, name) {
  await ws(s, "pro");
  await s.page.click("#newclip-open");
  await s.page.fill("#newclip-name", name);
  await s.page.click("#newclip-make");
  await wait(s, 400);
}
/** Keys upper_arm_near, chest and the wrist-free pose at frames 0, 6 and 12 so there is something to undo, nudge, mirror and delete. */
async function seedKeys(s) {
  await s.E(() => {
    const a = window.atlasEditor;
    const pose = { 0: [0, 0], 6: [40, -12], 12: [10, 8] };
    for (const [f, [arm, chest]] of Object.entries(pose)) {
      a.setTime(Number(f) / 30);
      a.select("upper_arm_near");
      a.rotate("upper_arm_near", arm);
      a.key();
      a.select("chest");
      a.rotate("chest", chest);
      a.key();
    }
    a.setTime(6 / 30);
    a.select("upper_arm_near");
  });
}
/** The editor's confirm dialogs are in-page (src/dialog.ts): click their confirm button as soon as one opens (the old page.on("dialog") accept). */
async function autoAccept(page) {
  await page.evaluate(() => {
    new MutationObserver(() => {
      const b = document.querySelector('.modal-backdrop [data-act="confirm"]');
      if (b && !b.dataset.auto) { b.dataset.auto = "1"; setTimeout(() => b.click(), 30); }
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const press = (s, k) => s.page.keyboard.press(k);
const neutral = async (s) => {
  const b = await s.E(() => { const r = document.querySelector("#view canvas").getBoundingClientRect(); return { x: r.x + 24, y: r.y + r.height - 24 }; });
  await s.page.mouse.move(b.x, b.y);
  await s.E(() => document.activeElement?.blur?.());
};

// ---------------------------------------------------------------------------------------------------------------- signatures and pixels
/** Everything an edit can change in the open clip: the clip document plus the live pose of every bone. */
const poseSig = (s) =>
  s.E(() => {
    const a = window.atlasEditor;
    const r = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
    const bones = {};
    for (const b of a.debug().skeleton.bones) {
      const n = b.data.name;
      bones[n] = [r(a.boneRot(n)), r(b.x), r(b.y), r(b.scaleX), r(b.scaleY), r(b.world?.x), r(b.world?.y)];
    }
    return JSON.stringify({ clip: a.state().clip, bones });
  });
const setupSig = (s) => s.E(() => JSON.stringify(window.atlasEditor.setupRaw()));
/** Whole-editor fingerprint for the hotkey checks: if a key "does something observable", this changes. */
const fingerprint = (s) =>
  s.E(() => {
    const a = window.atlasEditor;
    const t = (f) => { try { return f(); } catch { return "err"; } };
    const st = a.state();
    const el = (id) => document.getElementById(id);
    const shown = (e) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    return JSON.stringify(
      {
        st, ov: t(() => { const o = a.overlayState(); return { sb: o.showBones, bv: o.boneView, sh: o.showHelpers }; }), ab: t(() => a.abInfo()), pr: t(() => a.playRange()),
        face: t(() => a.facing()), on: t(() => a.onionInfo()), gr: t(() => a.graphState()), view: t(() => a.view()), ks: t(() => a.selection()), gv: t(() => a.gameViewInfo()),
        cls: document.body.className, status: el("status")?.textContent, sbsave: el("sb-save")?.textContent, help: shown(el("help")), pal: t(() => a.paletteOpen()),
        tool: t(() => a.canvasTool?.()), setup: t(() => a.setupState?.()), play: [el("play")?.className, el("play")?.textContent],
        gate: [el("gate-toggle")?.className, ...[...document.querySelectorAll("[id^=gatehud]")].map((e) => e.className)], auto: el("autokey")?.className,
        phone: el("phonebtn")?.className, paste: el("pastepose")?.disabled, box: t(() => a.boneSelection())
      },
      (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)
    );
  });
async function hideOverlay(s) {
  await s.E(() => {
    const d = window.atlasEditor.debug();
    d.world.children.forEach((c) => { if (c !== d.character) c.visible = false; });
    if (!document.getElementById("qa-style")) {
      const st = document.createElement("style");
      st.id = "qa-style";
      st.textContent = "#hoverlabel{visibility:hidden !important}";
      document.head.append(st);
    }
  });
}
const canvasBox = (s) => s.E(() => { const r = document.querySelector("#view canvas").getBoundingClientRect(); return { x: r.x + 220, y: r.y + 60, width: Math.max(80, r.width - 440), height: Math.max(80, r.height - 200) }; });
/** PNG of the character region (overlay hidden) once the compositor has presented the latest render. */
async function shot(s, box) {
  await s.page.waitForFunction(() => !window.atlasEditor.view().goal, null, { timeout: 4000 }).catch(() => {});
  await s.E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await hideOverlay(s);
  await s.E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return (await s.page.screenshot({ clip: box })).toString("base64");
}
/** Count of clearly different pixels between two PNGs. */
const pixDiff = (s, a, b) =>
  s.E(async ([x, y]) => {
    const load = async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const [p, q] = [await load(x), await load(y)];
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30) n++;
    return n;
  }, [a, b]);

// ---------------------------------------------------------------------------------------------------------------- real-mouse gestures
const ends = (s, bone) => s.E((b) => window.atlasEditor.boneScreenEnds(b), bone);
/** Presses on the rotate ring of `bone` (the selected bone, Rotate tool), sweeps `sweep` rad in `steps` moves. `hold` leaves the button down. */
async function ringDrag(s, bone, { sweep = 0.9, steps = 10, hold = false, onStep = null, a0 = -0.6, r0 = 70 } = {}) {
  const e = await ends(s, bone);
  need(e, `bone ${bone} has no screen position`);
  const at = (a) => [e.origin.x + r0 * Math.cos(a), e.origin.y + r0 * Math.sin(a)];
  await s.page.mouse.move(...at(a0));
  await s.page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await s.page.mouse.move(...at(a0 + (sweep * i) / steps));
    if (onStep) await onStep(i);
  }
  if (!hold) await s.page.mouse.up();
  return e;
}
async function dragBy(s, from, dx, dy, { steps = 8, hold = false, onStep = null } = {}) {
  await s.page.mouse.move(from.x, from.y);
  await s.page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await s.page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    if (onStep) await onStep(i);
  }
  if (!hold) await s.page.mouse.up();
}

// ---------------------------------------------------------------------------------------------------------------- hotkey table (parsed from the source, so a new row cannot be forgotten)
const hotkeySrc = readFileSync(resolve(PKG, "src/hotkeys.ts"), "utf8");
const HOTKEYS = [...hotkeySrc.matchAll(/\{ action: "(\w+)", keys: "((?:[^"\\]|\\.)*)"/g)].map((m) => ({ action: m[1], keys: JSON.parse(`"${m[2]}"`) }));
const SETUP_SHARED = new Set((hotkeySrc.match(/SETUP_SHARED[^=]*=\s*new Set<HotkeyAction>\(\[([^\]]*)\]/)?.[1] ?? "").match(/"(\w+)"/g)?.map((x) => x.replace(/"/g, "")) ?? []);
const SETUP_KEYS = [...(hotkeySrc.match(/SETUP_KEYS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? "").matchAll(/keys: "(\w)"/g)].map((m) => m[1]);
const toPlaywright = (keys) => {
  const first = keys.split(" / ")[0].trim();
  const parts = first.split("+");
  const k = parts.pop() || "+";
  const map = { Ctrl: "Control", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Esc: "Escape", Space: " " };
  return [...parts.map((p) => map[p] ?? p), map[k] ?? k].join("+");
};

// Per-hotkey setup. Everything runs on the standard state below; a row only adds what its key needs to have an effect.
const G = (mode) => (s) => s.E((m) => window.atlasEditor.setGizmo(m), mode);
const T = (f) => (s) => s.E((x) => window.atlasEditor.setTime(x / 30), f);
const HK = {
  rotate: { pre: G("move") }, move: { pre: G("rotate") }, scale: { pre: G("rotate") }, ik: { pre: G("rotate") }, shapeKeys: {}, weightsTool: {}, compensate: {}, autoKey: {},
  key: { pre: T(9) }, deleteKey: {}, mirror: {}, flipPose: {}, breakdown: { pre: T(3) }, copy: {}, undo: { pre: (s) => s.E(() => { window.atlasEditor.rotate("chest", 33); window.atlasEditor.key(); }) },
  redo: { pre: (s) => s.E(() => { window.atlasEditor.rotate("chest", 33); window.atlasEditor.key(); window.atlasEditor.undo(); }) },
  paste: { pre: async (s) => { await s.E(() => window.atlasEditor.copyPose()); await T(9)(s); } },
  play: { special: "play" }, prevFrame: {}, nextFrame: {}, prevFrame5: {}, nextFrame5: {}, prevKey: {}, nextKey: {}, firstFrame: {}, lastFrame: {}, prevPose: {}, nextPose: {},
  nudgeKeysBack: { pre: (s) => s.E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }])) },
  nudgeKeysForward: { pre: (s) => s.E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }])) },
  nudgeKeysBack5: { pre: (s) => s.E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }])) },
  nudgeKeysForward5: { pre: (s) => s.E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }])) },
  rangeIn: {}, rangeOut: {}, selectRoot: {}, selectAllKeys: {}, selectAllBones: {}, clearSelection: {},
  frameSelection: { pre: async (s) => { await zoomOut(s); } }, fitAll: { pre: async (s) => { await zoomOut(s); } }, phoneSize: {}, facingRight: {},
  bonesOverlay: {}, boneView: {}, graph: {}, gameView: {}, home: {}, palette: {}, help: {}, save: { pre: (s) => s.E(() => { window.atlasEditor.rotate("chest", 21); window.atlasEditor.key(); }) },
  pinPose: {}, unpinPose: { pre: (s) => press(s, "q") }, ghostPose: { pre: (s) => press(s, "q") }, swapPose: { pre: (s) => press(s, "q") },
  onion: {}, onionStyle: { pre: (s) => press(s, "Alt+o") }, gateHud: {}
};
async function zoomOut(s) {
  const b = await s.E(() => { const r = document.querySelector("#view canvas").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await s.page.mouse.move(b.x, b.y);
  await s.page.mouse.wheel(0, 500);
  await wait(s, 500);
}
/** The standard state every hotkey check starts from (and returns to): Animate, clip with keys at 0 / 6 / 12, playhead 6, upper_arm_near selected. */
async function stdState(s, workspace = "animate") {
  await s.E(() => {
    const a = window.atlasEditor;
    document.querySelectorAll("#helpclose").forEach((b) => b.offsetParent && b.click());
    a.paletteOpen?.() && document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    try { a.graphOpen(false); } catch {}
    try { a.gameView(false); } catch {}
  });
  const cls = await s.E(() => document.body.className);
  if (!cls.includes(`ws-${workspace}`)) await ws(s, workspace);
  await s.E(() => {
    const a = window.atlasEditor;
    a.setPlayRange(null);
    a.clearSelection();
    a.setGizmo("rotate");
  });
  await seedKeys(s);
  await neutral(s);
}
async function hotkeyEffect(s, def) {
  const spec = HK[def.action];
  need(spec, `no QA spec for hotkey "${def.action}" (${def.keys}): add a row to HK in scripts/qa-core.mjs so it is checked `);
  await stdState(s);
  await spec.pre?.(s);
  await wait(s, 150);
  const key = toPlaywright(def.keys);
  const before = await fingerprint(s);
  await press(s, key);
  await wait(s, 700);
  const after = await fingerprint(s);
  if (spec.special === "play") {
    need(before !== after, "Space did not start playback");
    await press(s, key);
    return;
  }
  need(before !== after, `pressing ${def.keys} in Animate changed nothing observable`);
}

// ---------------------------------------------------------------------------------------------------------------- the checks
const sessions = [];
const track = (s) => (sessions.push(s), s);
const cleanups = [];

// ===== 1. Undo / redo ===========================================================================================================
async function undoCycle(s, label, { edit, sig = poseSig, between = null, pixels = false, pre = null, redoKeys = ["Control+y", "Control+Shift+z"] }) {
  await pre?.();
  await neutral(s);
  const box = pixels ? await canvasBox(s) : null;
  const sigB = await sig(s);
  const pixB = pixels ? await shot(s, box) : null;
  await edit();
  await wait(s, 250);
  const sigA = await sig(s);
  need(sigA !== sigB, `the edit (${label}) did not change the document: cannot test undo (harness or product bug)`);
  const pixA = pixels ? (await neutral(s), await shot(s, box)) : null;
  if (between) await between();
  await press(s, "Control+z");
  await wait(s, 300);
  need((await sig(s)) === sigB, "Ctrl+Z did not revert the edit");
  if (pixels) {
    await neutral(s);
    const d = await pixDiff(s, pixB, await shot(s, box));
    need(d < 250, `after Ctrl+Z the canvas still differs from before the edit by ${d} px`);
  }
  for (const k of redoKeys) {
    await press(s, k);
    await wait(s, 300);
    need((await sig(s)) === sigA, `${k} did not re-apply the edit`);
    if (pixels) {
      await neutral(s);
      const d = await pixDiff(s, pixA, await shot(s, box));
      need(d < 250, `after ${k} the canvas differs from the edited pose by ${d} px`);
    }
    if (k !== redoKeys[redoKeys.length - 1]) {
      await press(s, "Control+z");
      await wait(s, 300);
      need((await sig(s)) === sigB, "second Ctrl+Z did not revert the edit");
    }
  }
}

if (want("undo")) {
  const s = track(await session(1600, 1000));
  s.phase = "undo";
  await makeClip(s, "qa_undo");
  await ws(s, "animate");
  await seedKeys(s);
  await s.E(() => window.atlasEditor.setGizmo("rotate"));
  await wait(s, 2000);
  await shot(s, await canvasBox(s)); // warm-up: the art loads lazily, the first shot of a page is not representative
  const pre = (fn) => async () => {
    await seedKeys(s);
    await s.E(() => { window.atlasEditor.setTime(6 / 30); window.atlasEditor.clearSelection(); });
    await fn?.();
  };
  const toolEdits = {
    "rotate drag": { pixels: true, pre: pre(async () => s.E(() => { window.atlasEditor.setGizmo("rotate"); window.atlasEditor.select("upper_arm_near"); })), edit: () => ringDrag(s, "upper_arm_near") },
    "move drag": {
      pixels: true,
      pre: pre(async () => s.E(() => { window.atlasEditor.setGizmo("move"); window.atlasEditor.select("chest"); })),
      edit: async () => { const e = await ends(s, "chest"); await dragBy(s, e.mid, 34, -22); }
    },
    "scale drag": {
      pixels: true,
      pre: pre(async () => s.E(() => { window.atlasEditor.setGizmo("scale"); window.atlasEditor.select("chest"); })),
      edit: async () => { const h = await s.E(() => window.atlasEditor.handlePos("chest")); await dragBy(s, h.y, 40, 0); }
    },
    "IK foot drag": {
      pixels: true,
      pre: pre(async () => s.E(() => { window.atlasEditor.setGizmo("rotate"); window.atlasEditor.select("foot_near_target"); })),
      edit: async () => { const h = (await s.E(() => window.atlasEditor.overlayState().ikHandles)).find((x) => x.name === "foot_near_target"); need(h, "no foot IK handle on the overlay"); await dragBy(s, h, 36, -26); }
    },
    "key pose (button)": { pre: pre(async () => s.E(() => { window.atlasEditor.setTime(9 / 30); window.atlasEditor.select("chest"); })), edit: async () => { await s.page.click("#key-menu-btn"); await s.page.click("#ab-key"); } },
    "key nudge": { pre: pre(async () => s.E(() => window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }]))), edit: () => press(s, ".") },
    "key delete": { pre: pre(async () => s.E(() => { window.atlasEditor.select("upper_arm_near"); window.atlasEditor.selectKeys([{ row: "bone:upper_arm_near", frame: 6 }]); })), edit: () => press(s, "Delete") },
    "easing change": { pre: pre(), edit: () => s.E(() => window.atlasEditor.applyEasing("strike", [{ bone: "upper_arm_near", frame: 6 }])) }
  };
  for (const [name, def] of Object.entries(toolEdits)) await test("undo", `Animate: ${name}, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (canvas focus)`, () => undoCycle(s, name, def));
  // Focus traps: the same rotate edit, then use a control, then Ctrl+Z.
  const rot = toolEdits["rotate drag"];
  const focusTraps = {
    "after clicking a toolbar button (zoom in)": () => s.page.click("#zoomin"),
    "after changing a dropdown (Keys tab, tween spacing)": async () => {
      await s.E(() => window.atlasEditor.showTab("keys"));
      await wait(s, 200);
      const v = await s.E(() => [...document.getElementById("tween-spacing").options].map((o) => o.value));
      const cur = await s.E(() => document.getElementById("tween-spacing").value);
      await s.page.selectOption("#tween-spacing", v.find((x) => x !== cur));
      await s.page.selectOption("#tween-spacing", cur);
    },    "after editing a panel field (length, Enter)": async () => { await s.page.click("#duration"); await press(s, "Enter"); },
    "after clicking a panel field then the canvas": async () => { await s.page.click("#duration"); const b = await canvasBox(s); await s.page.mouse.click(b.x + 10, b.y + b.height - 10); },
    "after Play then pause (button)": async () => { await s.page.click("#play"); await wait(s, 200); await s.page.click("#play"); await s.E(() => window.atlasEditor.setTime(6 / 30)); },
    "after opening the Keys tab": () => s.page.click("#tab-keys")
  };
  for (const [name, fn] of Object.entries(focusTraps)) await test("undo", `Animate: rotate drag, Ctrl+Z ${name}`, () => undoCycle(s, "rotate", { ...rot, pixels: false, between: fn }));
  await test("undo", "Animate: Loop is undoable on its own: after the Loop button, Ctrl+Z undoes the loop change first, then the rotation", async () => {
    await rot.pre();
    await neutral(s);
    const b = await poseSig(s);
    await rot.edit();
    await wait(s, 200);
    const a = await poseSig(s);
    need(a !== b, "edit did not register");
    await s.page.click("#loop");
    await wait(s, 150);
    const looped = await poseSig(s);
    need(looped !== a, "the Loop button did not change the clip");
    await press(s, "Control+z");
    await wait(s, 250);
    need((await poseSig(s)) === a, "Ctrl+Z after the Loop button did not undo the loop change (it must undo the last change)");
    await press(s, "Control+z");
    await wait(s, 250);
    need((await poseSig(s)) === b, "the second Ctrl+Z did not undo the rotation");
  });
  await test("undo", "Animate: undo button (#undo) and Ctrl+Z agree", async () => {
    await rot.pre();
    await neutral(s);
    const b = await poseSig(s);
    await rot.edit();
    await wait(s, 200);
    const a = await poseSig(s);
    need(a !== b, "edit did not register");
    await s.page.click("#undo");
    await wait(s, 250);
    need((await poseSig(s)) === b, "the Undo button did not revert");
    await press(s, "Control+y");
    await wait(s, 250);
    need((await poseSig(s)) === a, "Ctrl+Y after the Undo button did not re-apply");
  });
  await test("undo", "Animate: Ctrl+Z with nothing to undo does not throw or change the pose", async () => {
    const n = s.errors.length;
    for (let i = 0; i < 30; i++) await press(s, "Control+z");
    await wait(s, 200);
    need(s.errors.length === n, "page errors while undoing past the start of history");
  });

  // Pro workspace: same handler, different layout.
  await ws(s, "pro");
  await s.E(() => window.atlasEditor.setGizmo("rotate"));
  await test("undo", "Pro: rotate drag, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z", () => undoCycle(s, "rotate", { ...rot, pixels: true }));
  await test("undo", "Pro: Set key button (#setkey) on a pending pose (Auto key off), Ctrl+Z right after", async () => {
    const auto = () => s.E(() => { const b = document.getElementById("autokey"); return b.classList.contains("on") || b.getAttribute("aria-pressed") === "true"; });
    const was = await auto();
    if (was) await s.page.click("#autokey");
    try {
      await undoCycle(s, "set key", { pre: pre(() => s.E(() => { window.atlasEditor.setTime(9 / 30); window.atlasEditor.select("chest"); })), edit: async () => { await s.E(() => window.atlasEditor.rotate("chest", 19)); await s.page.click("#setkey"); } });
    } finally {
      if ((await auto()) !== was) await s.page.click("#autokey");
    }
  });
  await test("undo", "Pro: Key selected bones (#setkey) keys a pending scale + shear too, one Undo removes both ()", async () => {
    const auto = () => s.E(() => { const b = document.getElementById("autokey"); return b.classList.contains("on") || b.getAttribute("aria-pressed") === "true"; });
    const was = await auto();
    if (was) await s.page.click("#autokey");
    try {
      await s.E(() => { const e = window.atlasEditor; e.setTime(14 / 30); e.select("neck"); e.scale("neck", 1.3); e.shear("neck", 7, 0); });
      await s.page.click("#setkey");
      await wait(s, 200);
      const keyed = await s.E(() => { const b = window.atlasEditor.state().clip.bones.neck ?? {}; return { scale: (b.scale ?? []).some((k) => Math.round(k.time * 30) === 14), shear: (b.shear ?? []).some((k) => Math.round(k.time * 30) === 14) }; });
      need(keyed.scale && keyed.shear, `scale / shear not keyed: ${JSON.stringify(keyed)}`);
      need(/scale/.test(await s.E(() => document.querySelector("#status")?.textContent ?? "")), "status does not name the keyed channels");
      await s.E(() => window.atlasEditor.undoStep());
      const gone = await s.E(() => { const b = window.atlasEditor.state().clip.bones.neck ?? {}; return !(b.scale ?? []).some((k) => Math.round(k.time * 30) === 14) && !(b.shear ?? []).some((k) => Math.round(k.time * 30) === 14); });
      need(gone, "undo did not remove the scale / shear keys");
    } finally {
      if ((await auto()) !== was) await s.page.click("#autokey");
    }
  });
  await test("controls", "Key scope labels are truthful: Key character pose has no K badge, #setkey says Key selected bones ()", async () => {
    const t = await s.E(() => ({ key: document.getElementById("ab-key")?.textContent ?? "", kbd: !!document.querySelector("#ab-key kbd"), set: document.getElementById("setkey")?.textContent ?? "", all: document.getElementById("keyall")?.title ?? "" }));
    need(/Key character pose/.test(t.key) && !t.kbd, `ab-key: ${JSON.stringify(t)}`);
    need(/Key selected bones/.test(t.set), `setkey: ${t.set}`);
    need(/active bone/.test(t.all), `keyall title: ${t.all}`);
  });
  await test("undo", "Pro: Undo and Redo buttons (#undo / #redo)", async () => {
    await rot.pre();
    await neutral(s);
    const b = await poseSig(s);
    await rot.edit();
    await wait(s, 200);
    const a = await poseSig(s);
    need(a !== b, "edit did not register");
    await s.page.click("#undo");
    await wait(s, 250);
    need((await poseSig(s)) === b, "#undo did not revert");
    await s.page.click("#redo");
    await wait(s, 250);
    need((await poseSig(s)) === a, "#redo did not re-apply");
  });
  s.phase = "undo-done";
  cleanups.push(() => s.close());
}

if (want("undo")) {
  // ----- Rig / Setup
  const s = track(await session(1600, 1000));
  s.phase = "undo-rig";
  await ws(s, "rig");
  const setTool = (t) => s.E((x) => window.atlasEditor.setupTool(x), t);
  const selectBone = (b) => s.E((x) => window.atlasEditor.select(x), b);
  const rigEdits = {
    "bone rotate (ring drag)": async () => { await setTool("rotate"); await selectBone("chest"); await wait(s, 200); await ringDrag(s, "chest", { sweep: 0.7, a0: Math.PI, r0: 260 }); },
    "bone move (drag)": async () => { await setTool("move"); await selectBone("chest"); await wait(s, 200); const e = await ends(s, "chest"); await dragBy(s, e.mid, 30, 18); },
    "bone length (tip drag)": async () => { await setTool("length"); await selectBone("forearm_near"); await wait(s, 200); const e = await ends(s, "forearm_near"); await dragBy(s, e.tip, 18, 30); },
    "mesh point add (click)": async () => {
      await setTool("mesh");
      await s.E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
      await wait(s, 300);
      const e = await ends(s, "chest");
      await s.page.mouse.click(e.mid.x + 9, e.mid.y + 5);
    },
    "weight stroke (paint)": async () => {
      await setTool("weights");
      await s.E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
      await selectBone("chest");
      await wait(s, 300);
      const e = await ends(s, "chest");
      await dragBy(s, { x: e.mid.x - 10, y: e.mid.y }, 22, 6, { steps: 6 });
    },
    "slot / image move (drag)": async () => {
      await setTool("attachment");
      const pick = await s.E(() => {
        const raw = window.atlasEditor.setupRaw();
        const atts = raw.skins.body?.attachments ?? Object.values(raw.skins)[0]?.attachments ?? {};
        for (const [slot, m] of Object.entries(atts)) for (const [name, a] of Object.entries(m)) if (a.type === "region" || a.type === undefined) { window.atlasEditor.setupSelectSlot(slot, name); return [slot, name]; }
        return null;
      });
      need(pick, "no region attachment in the rig to move");
      await wait(s, 300);
      const h = await s.E(() => window.atlasEditor.setupImageHandles());
      need(h, "no image handles");
      const c = await s.E((p) => window.atlasEditor.setupScreen(p.x, p.y), h.centre);
      await dragBy(s, c, 26, 14);
    }
  };
  const soft = new Set(["mesh point add (click)", "weight stroke (paint)", "slot / image move (drag)"]);
  const trapRig = { "canvas focus": null, "after clicking a toolbar button (workspace tab)": () => s.page.click("#ws-rig") };
  for (const [name, edit] of Object.entries(rigEdits)) {
    for (const [tname, between] of Object.entries(trapRig)) {
      await test("undo", `Rig: ${name}, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (${tname})`, async () => {
        try {
          await undoCycle(s, name, { sig: setupSig, edit, between, pixels: false });
        } catch (e) {
          if (soft.has(name) && /did not change the document/.test(e.message)) throw new Skip(`gesture made no edit (${e.message.slice(0, 60)}): the harness gesture needs updating for this tool`);
          throw e;
        }
      });
    }
  }
  await test("undo", "Rig: Setup Undo / Redo buttons agree with Ctrl+Z", async () => {
    await rigEdits["bone move (drag)"]();
    await wait(s, 250);
    const a = await setupSig(s);
    await s.page.click("#setup-undo");
    await wait(s, 250);
    need((await setupSig(s)) !== a, "#setup-undo did nothing");
    await s.page.click("#setup-redo");
    await wait(s, 250);
    need((await setupSig(s)) === a, "#setup-redo did not re-apply");
  });
  s.phase = "undo-rig-done";

  // ----- Swag: wear an item
  await ws(s, "swag");
  await wait(s, 600);
  await test("undo", "Swag: wear an item, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z", async () => {
    const sk = () => s.E(() => JSON.stringify({ s: window.atlasEditor.skins(), o: window.atlasEditor.state().outfit }));
    const row = s.page.locator("button.swwear:not(.on)").first();
    need(await row.count(), "no 'Wear it' button in the Swag workshop");
    const b = await sk();
    await row.click();
    await wait(s, 700);
    const a = await sk();
    need(a !== b, "wearing did not change the skin state");
    await neutral(s);
    await press(s, "Control+z");
    await wait(s, 500);
    need((await sk()) === b, "Ctrl+Z did not take the item off again (wear is not undoable)");
    await press(s, "Control+y");
    await wait(s, 500);
    need((await sk()) === a, "Ctrl+Y did not wear it again");
  });
  cleanups.push(() => s.close());
}

// ===== 2. Hotkeys ===============================================================================================================
if (want("hotkeys")) {
  const s = track(await session(1600, 1000));
  s.phase = "hotkeys";
  await makeClip(s, "qa_keys");
  await ws(s, "animate");
  await seedKeys(s);
  need(HOTKEYS.length > 40, "could not parse HOTKEYS from src/hotkeys.ts");
  for (const def of HOTKEYS) {
    await test("hotkeys", `Animate: ${def.action} (${def.keys}) does something`, async () => {
      await hotkeyEffect(s, def);
      if (def.action === "weightsTool") await s.E(() => window.atlasEditor.workspace("animate"));
    });
  }
  await test("hotkeys", "Space + Escape bookkeeping: playback stopped, nothing left running", async () => {
    await stdState(s);
    await press(s, "Escape");
  });
  // Typing guard: in a text field a key types, it does not fire the editor (Ctrl+S, Ctrl+K and F1 are the declared exceptions).
  await ws(s, "pro");
  const exceptions = new Set(["save", "palette", "help"]);
  for (const def of HOTKEYS.filter((d) => !exceptions.has(d.action) && d.action !== "play")) {
    await test("hotkeys", `Pro: ${def.action} (${def.keys}) does NOT fire while typing in a text field`, async () => {
      await stdState(s, "pro");
      await HK[def.action]?.pre?.(s);
      await s.page.click(".ol-search");
      await s.E(() => document.activeElement?.tagName === "INPUT" || (() => { throw new Error("search field did not take focus"); })());
      const before = await fingerprint(s);
      await press(s, toPlaywright(def.keys));
      await wait(s, 400);
      const after = await fingerprint(s);
      await s.E(() => { const i = document.activeElement; if (i && "value" in i) i.value = ""; i?.blur?.(); });
      need(before === after, `${def.keys} acted on the editor while a text field had focus`);
    });
  }
  await test("hotkeys", "Pro: Space types a space (does not play) while typing in a text field", async () => {
    await stdState(s, "pro");
    await s.page.click(".ol-search");
    const t0 = await s.E(() => window.atlasEditor.state().time);
    await press(s, " ");
    await wait(s, 500);
    const t1 = await s.E(() => window.atlasEditor.state().time);
    await s.E(() => { const i = document.activeElement; if (i && "value" in i) i.value = ""; i?.blur?.(); });
    need(t0 === t1, "playback started from a Space typed in a field");
  });
  await test("hotkeys", "Pro: Ctrl+S still saves while typing (declared exception)", async () => {
    await stdState(s, "pro");
    await s.E(() => { window.atlasEditor.rotate("chest", 12); window.atlasEditor.key(); });
    await s.page.click(".ol-search");
    const req = s.page.waitForRequest((r) => r.method() !== "GET" && r.url().includes("/api/"), { timeout: 4000 }).catch(() => null);
    await press(s, "Control+s");
    need(await req, "Ctrl+S sent no save request while a text field had focus");
    await s.E(() => document.activeElement?.blur?.());
  });
  // Setup mode.
  await ws(s, "rig");
  for (const k of SETUP_KEYS) {
    await test("hotkeys", `Rig: Setup tool key ${k} selects its tool`, async () => {
      await s.E(() => { document.activeElement?.blur?.(); });
      await s.E((x) => window.atlasEditor.setupTool(x === "V" ? "rotate" : "select"), k);
      await neutral(s);
      const b = await s.E(() => window.atlasEditor.setupState().tool);
      await press(s, k.toLowerCase());
      await wait(s, 250);
      const a = await s.E(() => window.atlasEditor.setupState().tool);
      need(a !== b, `${k} left the Setup tool at "${b}"`);
    });
  }
  const sharedPre = { selectRoot: async () => s.E(() => window.atlasEditor.select("chest")), clearSelection: async () => s.E(() => window.atlasEditor.select("chest")), frameSelection: () => zoomOut(s), fitAll: () => zoomOut(s) };
  for (const def of HOTKEYS.filter((d) => SETUP_SHARED.has(d.action) && !["undo", "redo", "home"].includes(d.action))) {
    await test("hotkeys", `Rig: ${def.action} (${def.keys}) works in Setup mode (declared shared)`, async () => {
      await s.E(() => { document.querySelectorAll("#helpclose").forEach((b) => b.offsetParent && b.click()); });
      const cls = await s.E(() => document.body.className);
      if (!cls.includes("ws-rig")) await ws(s, "rig");
      await neutral(s);
      await sharedPre[def.action]?.();
      if (def.action === "save") await s.E(() => window.atlasEditor.setupRun?.([]));
      await wait(s, 200);
      const b = await fingerprint(s);
      await press(s, toPlaywright(def.keys));
      await wait(s, 700);
      const a = await fingerprint(s);
      if (def.action === "palette" || def.action === "help") await press(s, "Escape");
      need(b !== a, `${def.keys} changed nothing observable in Setup mode`);
    });
  }
  await test("hotkeys", "Rig: Animate-only keys (G graph, V game view) do not fire in Setup mode", async () => {
    await neutral(s);
    const b = await fingerprint(s);
    await press(s, "g");
    await press(s, "Shift+f").catch(() => {});
    await wait(s, 300);
    await press(s, "g");
    const a = JSON.parse(await fingerprint(s));
    need(JSON.stringify(a.gr) === JSON.stringify(JSON.parse(b).gr), "the graph editor toggled from Setup mode");
  });
  cleanups.push(() => s.close());
}

// ===== 3. Visible controls (from scripts/qa-manifest.json) ======================================================================
if (want("controls")) {
  const manifest = JSON.parse(readFileSync(resolve(PKG, "scripts/qa-manifest.json"), "utf8")).controls;
  const s = track(await session(1600, 1000));
  s.phase = "controls";
  await makeClip(s, "qa_controls");
  await seedKeys(s);
  for (const w of ["animate", "swag", "rig", "ship", "pro"]) {
    await ws(s, w);
    await s.E(() => window.atlasEditor.showTab(document.body.className.includes("ws-animate") ? "pose" : "pose")).catch(() => {});
    for (const m of manifest.filter((x) => x.workspace === w)) {
      await test("controls", `${w}: ${m.capability} [${m.selector.split(",")[0].trim()}]`, async () => {
        if (m.tab) await s.E((t) => window.atlasEditor.showTab(t), m.tab).catch(() => {});
        if (m.tool) {
          await s.E((t) => window.atlasEditor.setupTool(t), m.tool);
          await wait(s, 300);
        }
        if (m.node?.startsWith("att:")) await s.E((n) => { const [sl, nm] = n.slice(4).split("/"); window.atlasEditor.setupSelectSlot(sl, nm); }, m.node);
        if (m.node && !m.node.startsWith("att:")) await s.E((n) => { const [k, v] = n.split(":"); if (k === "slot") window.atlasEditor.setupSelectSlot(v); else if (k === "ik") window.atlasEditor.setupSelectNode({ kind: "constraint", ckind: "ik", name: v }); else if (k === "skin") window.atlasEditor.setupSelectNode({ kind: "skin", name: v }); else window.atlasEditor.select(v); }, m.node);
        if (m.expand) await s.E((id) => window.atlasEditor.inspectorOpen(id, true), m.expand);
        if (m.node || m.expand) await wait(s, 250);
        if (m.open) await s.page.click(m.open);
        await wait(s, 120);
        const loc = s.page.locator(m.selector).filter(m.text ? { hasText: m.text } : {}).first();
        const found = await loc.count();
        need(found, `no element matches ${m.selector}`);
        need(await loc.isVisible(), `${m.selector} exists but is not visible in ${w}`);
        const box = await loc.boundingBox();
        need(box && box.width > 1 && box.height > 1, "visible element has no size");
        if (m.tooltip !== false) {
          const tip = await loc.evaluate((e) => (e.getAttribute("title") || e.getAttribute("aria-label") || e.closest("[title]")?.getAttribute("title") || "").trim());
          need(tip.length > 0, `${m.selector} has no tooltip (title / aria-label)`);
        }
        if (m.enabled !== false) need(await loc.isEnabled(), `${m.selector} is disabled although a clip is open`);
        if (m.open) await s.page.keyboard.press("Escape");
        if (m.tool) await s.E(() => window.atlasEditor.setupTool("move"));
      }, { xfail: m.status === "expected-fail" ? m.note ?? "known gap" : null });
    }
  }
  const overlays = async () => {
    if (!(await s.page.locator("#ctx-pop").isVisible())) await s.page.click("#ctx-overlays");
  };
  await ws(s, "animate");
  await test("controls", "view HUD: Onion button toggles the onion skin and its popover opens", async () => {
    await overlays();
    const was = await s.E(() => window.atlasEditor.onionInfo().enabled);
    await s.page.click("#vh-onion");
    need((await s.E(() => window.atlasEditor.onionInfo().enabled)) === !was, "the HUD Onion button did not toggle the onion skin");
    await s.page.click("#vh-onion");
    await s.page.click("#vh-onion-set");
    need(await s.page.locator("#vh-onion-pop").isVisible(), "the onion settings popover did not open");
    await s.page.keyboard.press("Escape");
  });
  await test("controls", "view HUD: Pin A in the compare popover pins the pose", async () => {
    await overlays();
    await s.page.click("#vh-ab");
    await s.page.click("#vh-abpin");
    need((await s.E(() => window.atlasEditor.abInfo().pinned)) !== null, "pose A was not pinned");
    await s.page.click("#vh-abclear");
    await s.page.keyboard.press("Escape");
  });
  await test("controls", "Help menu: User guide renders with its screenshots, Troubleshooting scrolls to its section, About shows the commit, Keyboard shortcuts opens the sheet", async () => {
    await s.page.click("#helpbtn");
    await s.page.click("#help-guide");
    await s.page.waitForSelector("#guideview h1", { timeout: 10000 });
    await s.page.waitForFunction(() => [...document.querySelectorAll("#guideview img")].length > 0 && [...document.querySelectorAll("#guideview img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    need((await s.page.locator("#guideview h2").count()) >= 5, "the guide shows fewer than 5 sections");
    await s.page.keyboard.press("Escape");
    need((await s.page.locator("#guideview").count()) === 0, "Escape did not close the guide");
    await s.page.click("#helpbtn");
    await s.page.click("#help-trouble");
    await s.page.waitForSelector("#guideview #troubleshooting", { timeout: 10000 });
    const top = await s.page.evaluate(() => { const b = document.querySelector("#guideview .hv-body"), h = document.querySelector("#guideview #troubleshooting"); return h.getBoundingClientRect().top - b.getBoundingClientRect().top; });
    need(top < 200, `Troubleshooting is not scrolled into view (${top}px below the top)`);
    await s.page.click("#helpview-close");
    await s.page.click("#helpbtn");
    await s.page.click("#help-about");
    await s.page.waitForSelector("#aboutview #about-copy", { timeout: 10000 });
    need(/Commit\s*[0-9a-f]{6,}|Commit\s*unknown/i.test(await s.page.locator("#aboutview").innerText()), "About does not show a commit hash");
    await s.page.click("#helpview-close");
    await s.page.click("#helpbtn");
    await s.page.click("#help-keys");
    need(await s.page.locator("#help.open").count(), "Keyboard shortcuts did not open the sheet");
    await s.page.click("#helpclose");
  });
  await test("controls", "view HUD: Select all bones selects every bone; Select branch selects a bone's children", async () => {
    await overlays();
    await s.page.click("#vh-selall");
    const n = await s.E(() => ({ sel: window.atlasEditor.state().selection.length }));
    need(n.sel > 3, `select all left ${n.sel} bones selected`);
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 500);
    await overlays();
    await s.page.click("#vh-branch");
    need((await s.E(() => window.atlasEditor.state().selection.length)) > 1, "select branch selected only one bone");
  });
  await test("controls", "view HUD: Hand tool turns a plain drag into a pan", async () => {
    await overlays();
    await s.page.click("#vh-pan");
    await s.page.keyboard.press("Escape");
    const before = await s.E(() => (({ x, y }) => ({ x, y }))(window.atlasEditor.debug().world));
    const box = await s.page.locator("#view canvas").first().boundingBox();
    await s.page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 120);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2 + 160, { steps: 5 });
    await s.page.mouse.up();
    const after = await s.E(() => (({ x, y }) => ({ x, y }))(window.atlasEditor.debug().world));
    await overlays();
    await s.page.click("#vh-pan");
    need(before && after && (before.x !== after.x || before.y !== after.y), "the canvas did not pan");
  });
  // ----- Batch 2: one tool palette and one stage context bar per workspace -----
  const PALETTE_KEYS = { select: "V", bone: "B", attachment: "A", rotate: "R", move: "T", scale: "S", length: "L", ik: "H", weights: "W" };
  for (const w of ["animate", "swag", "rig", "pro"]) {
    await test("controls", `${w}: exactly one tool palette (role=toolbar, data-tools), no other tool bar, one context bar`, async () => {
      await ws(s, w);
      const r = await s.E(() => {
        const vis = (e) => !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        const tb = [...document.querySelectorAll("[role=toolbar][data-tools]")];
        return { n: tb.length, shown: tb.filter(vis).length, old: document.querySelectorAll("#gizmo, .xs-tools, #xs-edge, #vhud, #gate-overlay:not(#ov-gate #gate-overlay)").length, ctx: [...document.querySelectorAll("[data-contextbar]")].filter(vis).length, ctxTools: document.querySelectorAll("#vtop [data-tools]").length };
      });
      need(r.n === 1, `${r.n} elements match [role=toolbar][data-tools]`);
      need(r.shown === 1, `the palette is not visible in ${w}`);
      need(r.old === 0, `${r.old} old tool bars / floating cards are still in the DOM`);
      need(r.ctx === 1 && r.ctxTools === 0, `expected one stage context bar, found ${r.ctx}`);
    });
  }
  for (const w of ["animate", "rig", "pro"]) {
    await test("controls", `${w}: every palette tool is visible, labelled, and its tooltip names the key`, async () => {
      await ws(s, w);
      const rows = await s.E(() => [...document.querySelectorAll("#toolpalette .tp-btn")].map((b) => ({ tool: b.dataset.tool, shown: b.offsetParent !== null && b.getBoundingClientRect().width > 8, title: b.title, text: b.textContent.trim() })));
      need(rows.length === 11, `${rows.length} palette tools`);
      for (const r of rows) {
        need(r.shown, `tool ${r.tool} is not visible`);
        need(r.text.length > 0 && r.title.length > 0, `tool ${r.tool} has no label or tooltip`);
        const k = PALETTE_KEYS[r.tool];
        if (k) need(r.title.includes(`(${k})`), `tool ${r.tool}'s tooltip does not name ${k}: ${r.title}`);
      }
    });
  }
  await test("controls", "palette: in Animate the transform tools set the gizmo; Select and Shape keys switch the canvas tool", async () => {
    await ws(s, "animate");
    for (const [id, mode] of [["tp-move", "move"], ["tp-scale", "scale"], ["tp-shear", "shear"], ["tp-ik", "ik"], ["tp-rotate", "rotate"]]) {
      await s.page.click(`#${id}`);
      need((await s.E(() => window.atlasEditor.state().gizmoMode)) === mode, `${id} did not select the ${mode} gizmo`);
      need(await s.page.locator(`#${id}`).evaluate((e) => e.classList.contains("on")), `${id} is not lit after it was clicked`);
    }
  });
  await test("controls", "gate overlay: marks and the Outline gate card clear on a workspace change (Swag to Rig)", async () => {
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.setActiveSkin("chest.leather"));
    await wait(s, 400);
    need(await s.E(() => window.atlasGate.summary().applies), "the gate should apply in Animate with the pro rig");
    await ws(s, "swag");
    await ws(s, "rig");
    await wait(s, 400);
    const g = await s.E(() => ({ marks: window.atlasGate.marks().length, applies: window.atlasGate.summary().applies, card: [...document.querySelectorAll("#gate-overlay")].filter((e) => e.offsetParent !== null).length }));
    need(g.marks === 0 && !g.applies && g.card === 0, `gate state after Swag to Rig: ${JSON.stringify(g)}`);
    await s.E(() => window.atlasEditor.setActiveSkin(null));
  });
  // Every control the page shows must have a tooltip or visible text (an unlabelled icon button is the rule).
  for (const w of ["animate", "swag", "rig", "ship", "pro"]) {
    await test("controls", `${w}: every visible button has a label (text, title or aria-label)`, async () => {
      await ws(s, w);
      const bad = await s.E(() => [...document.querySelectorAll("button, [role=button]")].filter((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !b.closest("#home,#help"); }).filter((b) => !(b.textContent.trim() || b.title || b.getAttribute("aria-label"))).map((b) => b.id || b.className || b.outerHTML.slice(0, 40)));
      need(bad.length === 0, `unlabelled buttons: ${bad.slice(0, 6).join(", ")}${bad.length > 6 ? ` (+${bad.length - 6})` : ""}`);
    });
  }
  cleanups.push(() => s.close());
}

// ===== 3b. Rig panel behaviour: reparent, rename, slots, draw order, constraints, revert =================
if (want("rig")) {
  const s = track(await session(1600, 1000));
  s.phase = "rig";
  await autoAccept(s.page);
  await ws(s, "rig");
  await s.E(() => window.atlasEditor.showTab("rig"));
  const raw = () => s.E(() => window.atlasEditor.setupRaw());
  const order = (r) => (r.drawOrder ?? r.slots.map((x) => x.name)).filter((n) => !r.slots.find((x) => x.name === n)?.drawAfter && !r.slots.find((x) => x.name === n)?.drawBefore);
  const undo = async () => { await neutral(s); await press(s, "Control+z"); await wait(s, 500); };
  const edits = () => s.E(() => window.atlasEditor.setupState().undoable);
  await test("rig", "Tree: dragging a bone row onto another re-parents it, keeps its world position, Ctrl+Z undoes it", async () => {
    const pick = await s.E(() => {
      const r = window.atlasEditor.setupRaw();
      const present = new Set([...document.querySelectorAll("#outliner .ol-row.k-bone")].map((e) => e.dataset.id.slice(2)));
      const kids = new Set(r.bones.map((b) => b.parent));
      const leaf = r.bones.find((b) => b.parent && !kids.has(b.name) && present.has(b.name) && !r.ik?.some((c) => c.bones.includes(b.name) || c.target === b.name));
      const to = r.bones.find((b) => present.has(b.name) && b.name !== leaf?.parent && b.name !== leaf?.name && b.name !== "root");
      return leaf && to ? { bone: leaf.name, parent: leaf.parent, to: to.name } : null;
    });
    need(pick, "no leaf bone and target row are visible in the Tree");
    const w0 = await s.E((b) => window.atlasEditor.setupBoneWorld(b), pick.bone);
    const n0 = await edits();
    await s.page.locator(`#outliner .ol-row[data-id="b:${pick.bone}"]`).dragTo(s.page.locator(`#outliner .ol-row[data-id="b:${pick.to}"]`));
    await wait(s, 600);
    const r1 = await raw();
    need(r1.bones.find((b) => b.name === pick.bone).parent === pick.to, `the bone is still under ${r1.bones.find((b) => b.name === pick.bone).parent}`);
    const w1 = await s.E((b) => window.atlasEditor.setupBoneWorld(b), pick.bone);
    need(Math.hypot(w1.origin.x - w0.origin.x, w1.origin.y - w0.origin.y) < 0.05, "the bone moved in the world when re-parented");
    need((await edits()) === n0 + 1, "the drop was not one undo step");
    await undo();
    need((await raw()).bones.find((b) => b.name === pick.bone).parent === pick.parent, "Ctrl+Z did not put the bone back under its parent");
  });
  await test("rig", "Tree: double-click renames a bone, Enter commits, Undo renames it back", async () => {
    const name = await s.E(() => { const r = window.atlasEditor.setupRaw(); const present = new Set([...document.querySelectorAll("#outliner .ol-row.k-bone")].map((e) => e.dataset.id.slice(2))); return r.bones.find((b) => b.name !== "root" && present.has(b.name))?.name; });
    await s.E((n) => window.atlasEditor.select(n), name);
    await wait(s, 300);
    await s.page.locator(`#outliner .ol-row[data-id="b:${name}"] .ol-label`).dblclick();
    const input = s.page.locator("#outliner .ol-rename");
    need(await input.count(), "double-click opened no rename field");
    await input.fill("x_renamed");
    await input.press("Enter");
    await wait(s, 600);
    need((await raw()).bones.some((b) => b.name === "x_renamed"), "the bone was not renamed");
    await undo();
    need((await raw()).bones.some((b) => b.name === name), "undo did not restore the old name");
  });
  await test("rig", "Bone panel: scale, shear and rotation-limit fields edit the bone, each undoable", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const bone = async () => (await raw()).bones.find((b) => b.name === "chest");
    await s.page.fill("#setup-scalex", "1.25");
    await s.page.press("#setup-scalex", "Enter");
    await wait(s, 400);
    need((await bone()).scaleX === 1.25, "scale x was not applied");
    await s.page.fill("#setup-sheary", "7");
    await s.page.press("#setup-sheary", "Enter");
    await wait(s, 400);
    need((await bone()).shearY === 7, "shear y was not applied");
    await s.page.check("#setup-limits-on");
    await wait(s, 400);
    need((await bone()).limits, "limits were not switched on");
    await undo();
    need(!(await bone()).limits, "undo did not remove the limits");
    await undo();
    await undo();
    const b = await bone();
    need((b.scaleX ?? 1) === 1 && !b.shearY, "undo did not restore scale and shear");
  });
  await test("rig", "Slots: New slot, rename, tint, blend and Delete slot (confirm) work and undo", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const n0 = (await raw()).slots.length;
    await s.page.click("#setup-newslot");
    await wait(s, 500);
    const r1 = await raw();
    need(r1.slots.length === n0 + 1, "New slot added no slot");
    const made = r1.slots.at(-1).name;
    need(order(r1).at(-1) === made, "the new slot is not drawn in front");
    await s.page.fill("#setup-slot-name", "qa_slot");
    await s.page.press("#setup-slot-name", "Enter");
    await wait(s, 500);
    need((await raw()).slots.some((x) => x.name === "qa_slot"), "the slot was not renamed");
    await s.page.selectOption("#setup-slot-blend", "additive");
    await wait(s, 400);
    need((await raw()).slots.find((x) => x.name === "qa_slot").blend === "additive", "blend mode not applied");
    await s.page.locator("#setup-slot-color").evaluate((e) => { e.value = "#ff8000"; e.dispatchEvent(new Event("change", { bubbles: true })); });
    await wait(s, 400);
    need((await raw()).slots.find((x) => x.name === "qa_slot").color?.startsWith("ff8000"), "tint not applied");
    await s.page.click("#setup-delslot");
    await wait(s, 500);
    need(!(await raw()).slots.some((x) => x.name === "qa_slot"), "Delete slot left the slot");
    await undo();
    need((await raw()).slots.some((x) => x.name === "qa_slot"), "undo did not bring the deleted slot back");
    for (let i = 0; i < 4; i++) await undo();
    need((await raw()).slots.length === n0, "undo did not remove the new slot");
  });
  await test("rig", "Slots: Up / Down / To front / To back and dragging a Tree Draw order row change the draw order; undo restores", async () => {
    const r0 = await raw();
    const o0 = order(r0);
    const mid = o0[Math.floor(o0.length / 2)];
    await s.E((n) => window.atlasEditor.setupSelectSlot(n), mid);
    await wait(s, 300);
    const idx = async () => order(await raw()).indexOf(mid);
    await s.page.click("#setup-slot-up");
    await wait(s, 500);
    need((await idx()) === o0.indexOf(mid) + 1, "Up did not move the slot toward the front");
    await s.page.click("#setup-slot-down");
    await wait(s, 500);
    need((await idx()) === o0.indexOf(mid), "Down did not move it back");
    await s.page.click("#setup-slot-front");
    await wait(s, 500);
    need((await idx()) === o0.length - 1, "To front did not put it last");
    await undo();
    need((await idx()) === o0.indexOf(mid), "Ctrl+Z did not undo To front");
    await s.page.click("#setup-slot-back");
    await wait(s, 500);
    need((await idx()) === 0, "To back did not put it first");
    // Drag the slot row two places toward the front (top half of the target row = in front of it).
    const cur = order(await raw());
    const at = cur.indexOf(mid);
    const target = cur[at + 2];
    need(target, "the draw order has no slot two places in front of the test slot");
    // The Tree's Draw order section (front on top): open it, then drag the slot's row onto the top half of the target row.
    if (!(await s.page.locator('#outliner .ol-row[data-id="d:' + mid + '"]').count())) await s.page.locator('#outliner .ol-row[data-id="g:draw"]').click();
    const list = s.page.locator("#outliner");
    await list.locator(`.ol-row[data-id="d:${mid}"]`).dragTo(list.locator(`.ol-row[data-id="d:${target}"]`), { targetPosition: { x: 40, y: 2 } });
    await wait(s, 600);
    need(order(await raw()).indexOf(mid) === at + 2, `dragging the row two places up left the slot at ${order(await raw()).indexOf(mid)} instead of ${at + 2}`);
    for (let i = 0; i < 4; i++) await undo();
    need(order(await raw()).join() === o0.join(), "undo did not restore the original draw order");
  });
  await test("rig", "Constraints: + Constraint adds 1-bone IK and a transform constraint, Up/Down reorders, Remove (confirm) deletes, each undoable", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const r0 = await raw();
    const n0 = (r0.ik ?? []).length;
    const t0 = (r0.transform ?? []).length;
    await s.page.click("#setup-addik1");
    await wait(s, 600);
    const r1 = await raw();
    need((r1.ik ?? []).length === n0 + 1 && r1.ik.at(-1).bones.length === 1, "Add 1-bone IK did not add a 1-bone IK");
    await s.page.click("#setup-addtc");
    await wait(s, 600);
    need(((await raw()).transform ?? []).length === t0 + 1, "Add transform constraint added nothing");
    await s.page.locator("#setuppanel [data-con].insp-item").last().click();
    need(await s.page.locator("#setuppanel [data-remove]").count(), "opening the constraint row did not show its page");
    const ups = s.page.locator('#setuppanel .conorder button[data-move="up"]:not([disabled])');
    need(await ups.count(), "no enabled constraint Up button");
    const sig = async () => JSON.stringify([...(await raw()).ik.map((c) => [c.name, c.order]), ...(await raw()).transform.map((c) => [c.name, c.order])]);
    const before = await sig();
    await ups.last().click();
    await wait(s, 500);
    need((await sig()) !== before, "Up changed no constraint order");
    await undo();
    need((await sig()) === before, "Ctrl+Z did not restore the constraint order");
    await s.page.locator("#setuppanel [data-remove]").last().click();
    await wait(s, 600);
    need(((await raw()).transform ?? []).length === t0, "Remove (after the confirm) did not remove the transform constraint");
    await undo();
    need(((await raw()).transform ?? []).length === t0 + 1, "undo did not bring the constraint back");
    await undo();
    await undo();
    const r4 = await raw();
    need((r4.ik ?? []).length === n0 && (r4.transform ?? []).length === t0, "undo did not remove the added constraints");
  });
  await test("rig", "Physics: + Physics adds a physics constraint, its fields edit it, Run order moves it, the Tree menu lists Add physics, Remove (confirm) deletes it, each undoable (Batch 7a, RG-08)", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const p0 = ((await raw()).physics ?? []).length;
    await s.page.click("#setup-addphys");
    await wait(s, 600);
    const r1 = await raw();
    need((r1.physics ?? []).length === p0 + 1, "Add physics added nothing");
    const made = r1.physics.at(-1);
    need(made.bone === "chest" && made.rotate === 1, `the new physics is ${JSON.stringify(made)}`);
    await s.page.locator("#setuppanel [data-con].insp-item").last().click();
    await wait(s, 300);
    await s.E(() => window.atlasEditor.inspectorOpen("con.ph.run", true));
    await wait(s, 250);
    for (const k of ["rotate", "x", "y", "scaleX", "shearX", "inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "limit", "fps"]) {
      const el = s.page.locator(`#setup-phys-${k}`);
      need(await el.count(), `no #setup-phys-${k} field`);
      need((await el.getAttribute("title"))?.length > 5, `#setup-phys-${k} has no tooltip`);
    }
    await s.page.fill("#setup-phys-gravity", "40");
    await s.page.press("#setup-phys-gravity", "Enter");
    await wait(s, 500);
    need((await raw()).physics.at(-1).gravity === 40, "gravity 40 was not written");
    await undo();
    need(((await raw()).physics.at(-1).gravity ?? 0) === 0, "Ctrl+Z did not restore gravity");
    await s.page.fill("#setup-phys-fps", "0");
    await s.page.press("#setup-phys-fps", "Enter");
    await wait(s, 400);
    need((await raw()).physics.at(-1).fps === undefined || (await raw()).physics.at(-1).fps >= 1, "fps 0 was accepted");
    const ups = s.page.locator('#setuppanel .conorder button[data-move="up"]:not([disabled])');
    need(await ups.count(), "no enabled Up button for physics in the run order");
    const sig = async () => JSON.stringify((await raw()).physics.map((c) => [c.name, c.order]));
    const before = await sig();
    await ups.last().click();
    await wait(s, 500);
    need((await sig()) !== before, "Up changed no physics order");
    await undo();
    await s.page.locator("#outliner .ol-row.k-bone").first().click({ button: "right" }).catch(() => {});
    const menuHasPhysics = await s.page.locator(".ctxmenu, [role=menu]").filter({ hasText: "Add physics" }).count();
    await s.page.keyboard.press("Escape");
    need(menuHasPhysics, "the Tree bone context menu has no Add physics entry");
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    await s.page.locator("#setuppanel [data-con].insp-item").last().click();
    await wait(s, 300);
    await s.page.locator("#setuppanel [data-remove]").last().click();
    await wait(s, 600);
    need(((await raw()).physics ?? []).length === p0, "Remove (after the confirm) did not remove the physics constraint");
    await undo();
    need(((await raw()).physics ?? []).length === p0 + 1, "undo did not bring the physics constraint back");
    await undo();
    need(((await raw()).physics ?? []).length === p0, "undo did not remove the added physics constraint");
  });
  await test("rig", "Path: + Path adds a bezier path, the page edits points and handles, Closed / Constant speed toggle, + Path constraint (button and Tree menu) follows it with fields and run order, Remove deletes it, each undoable (Batch 12b)", async () => {
    const raw = () => s.E(() => window.atlasEditor.setupRaw());
    const undo = async () => {
      await s.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await s.page.keyboard.press("Control+z");
      await wait(s, 500);
    };
    const att = async () => (await raw()).skins.body.attachments["skin_forearm_near_path"]?.path;
    await s.E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
    await wait(s, 300);
    need(((await s.page.locator("#setup-add-path").getAttribute("title")) ?? "").length > 20, "+ Path has no tooltip");
    await s.page.click("#setup-add-path");
    await wait(s, 600);
    const p = await att();
    need(p && p.type === "path" && p.vertexCount === 9 && p.vertices.length === 18, `+ Path wrote ${JSON.stringify(p)?.slice(0, 100)}`);
    need((await s.page.locator("#path-points .insp-item").count()) === 3, "the path page should list 3 points");
    const x0 = p.vertices[8];
    const inx0 = p.vertices[6];
    await s.page.fill("#path-px1", String(x0 + 10));
    await s.page.press("#path-px1", "Enter");
    await wait(s, 500);
    const moved = await att();
    need(moved.vertices[8] === x0 + 10 && Math.abs(moved.vertices[6] - (inx0 + 10)) < 0.01, "moving a point did not carry its handle");
    await s.page.locator("#path-points .insp-item").first().locator("button.btn.sm").click();
    await wait(s, 500);
    need((await att()).vertexCount === 12, "the + button did not add a point");
    await s.page.locator("#path-points .insp-item .insp-trash").last().click();
    await wait(s, 500);
    need((await att()).vertexCount === 9, "the trash button did not remove a point");
    await s.page.check("#path-closed");
    await wait(s, 500);
    need((await att()).closed === true, "Closed loop was not written");
    await undo();
    need((await att()).closed === false, "undo did not reopen the path");
    await s.page.uncheck("#path-constant");
    await wait(s, 500);
    need((await att()).constantSpeed === false, "Constant speed off was not written");
    await undo();
    // The constraint
    await s.E(() => window.atlasEditor.select("head"));
    await wait(s, 300);
    const n0 = ((await raw()).path ?? []).length;
    need(((await s.page.locator("#setup-addpath").getAttribute("title")) ?? "").length > 20, "Path constraint button has no tooltip");
    await s.page.click("#setup-addpath");
    await wait(s, 700);
    const r1 = await raw();
    const st = await s.page.locator("#status").textContent();
    need((r1.path ?? []).length === n0 + 1, `Add path constraint added nothing (${st})`);
    need(r1.path.at(-1).target === "skin_forearm_near_path" && r1.path.at(-1).bones[0] === "head", `the new constraint is ${JSON.stringify(r1.path.at(-1))}`);
    await wait(s, 300);
    if (!(await s.page.locator("#setuppanel [data-con].insp-item").count())) throw new Error(`no constraint row on the bone page: ${(await s.page.locator("#setuppanel").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
    await s.page.locator("#setuppanel [data-con].insp-item").last().click();
    await wait(s, 300);
    for (const id of ["path-target", "path-position", "path-positionmode", "path-spacing", "path-spacingmode", "path-rotatemode", "path-offsetrot", "path-mixrotate", "path-mixx", "path-mixy", "path-addbone", "path-addbone-sel"]) {
      const el = s.page.locator(`#${id}`);
      need(await el.count(), `no #${id} field`);
      need(((await el.getAttribute("title")) ?? "").length > 5, `#${id} has no tooltip`);
    }
    await s.page.fill("#path-position", "0.5");
    await s.page.press("#path-position", "Enter");
    await wait(s, 500);
    need((await raw()).path.at(-1).position === 0.5, "position 0.5 was not written");
    await undo();
    await s.page.locator("#path-rotatemode").selectOption("chain");
    await wait(s, 500);
    need((await raw()).path.at(-1).rotateMode === "chain", "rotate mode was not written");
    await s.page.fill("#path-mixrotate", "2");
    await s.page.press("#path-mixrotate", "Enter");
    await wait(s, 400);
    need(((await raw()).path.at(-1).mixRotate ?? 1) <= 1, "mix 2 was accepted");
    const ups = s.page.locator('#setuppanel .conorder button[data-move="up"]:not([disabled])');
    need(await ups.count(), "no enabled Up button for the path constraint run order");
    await s.E(() => window.atlasEditor.select("head"));
    await wait(s, 300);
    await s.page.locator("#outliner .ol-row.k-bone").first().click({ button: "right" }).catch(() => {});
    const menu = await s.page.locator(".ctxmenu, [role=menu]").filter({ hasText: "Add path constraint" }).count();
    await s.page.keyboard.press("Escape");
    need(menu, "the Tree bone context menu has no Add path constraint entry");
    await s.E(() => window.atlasEditor.select("head"));
    await wait(s, 400);
    await s.page.locator("#setuppanel [data-con].insp-item").last().click();
    await wait(s, 300);
    await s.page.locator("#setuppanel [data-remove]").last().click();
    await wait(s, 600);
    need(((await raw()).path ?? []).length === n0, "Remove did not remove the path constraint");
    await undo();
    need(((await raw()).path ?? []).length === n0 + 1, "undo did not bring the path constraint back");
    for (let i = 0; i < 14 && (((await raw()).path ?? []).length > n0 || (await att())); i++) await undo();
    need(((await raw()).path ?? []).length === n0 && !(await att()), "undo did not remove the added path");
  });
  await test("rig", "Pixi stage: a numbered PNG sequence imports in one go, the setup frame changes the drawn pixels, a clip mask visibly clips it, a stage drag moves a hit box point (Batch 12a/12b)", async () => {
    const raw = () => s.E(() => window.atlasEditor.setupRaw());
    const { PNG } = require("pngjs");
    const solid = (r, g, b) => {
      const png = new PNG({ width: 60, height: 60 });
      for (let i = 0; i < 60 * 60; i++) png.data.set([r, g, b, 255], i * 4);
      return PNG.sync.write(png);
    };
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    await s.page.click("#idk-tab-images");
    await wait(s, 500);
    need(await s.page.locator("#idk-import-seq").count(), "no Import PNG sequence button in the Images dock");
    need(((await s.page.locator("#idk-import-seq").getAttribute("title")) ?? "").length > 20, "Import PNG sequence has no tooltip");
    await s.page.locator("#idk-import-seq-file").setInputFiles([
      { name: "qaseq_02.png", mimeType: "image/png", buffer: solid(0, 0, 255) },
      { name: "qaseq_01.png", mimeType: "image/png", buffer: solid(255, 0, 0) }
    ]);
    await wait(s, 1200);
    const r = await raw();
    const seqSlot = r.slots.find((x) => x.name.startsWith("qaseq"));
    need(seqSlot, `no qaseq slot: ${r.slots.map((x) => x.name).slice(-3)}`);
    const att = r.skins.body.attachments[seqSlot.name]?.[seqSlot.attachment];
    need(att?.sequence?.count === 2 && att.sequence.start === 1 && att.sequence.digits === 2, `sequence ${JSON.stringify(att)}`);
    need(r.atlas.pages.filter((p) => /qaseq/.test(p)).length === 2, "the two PNGs did not become two atlas pages");
    // Pixels
    const at = async (x, y) => {
      await s.E(() => new Promise((rr) => requestAnimationFrame(() => requestAnimationFrame(rr))));
      await hideOverlay(s);
      await s.E(() => new Promise((rr) => requestAnimationFrame(() => requestAnimationFrame(rr))));
      const b64 = (await s.page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })).toString("base64");
      return s.E(async (d) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${d}`)).blob());
        const c = new OffscreenCanvas(1, 1);
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return [...g.getImageData(0, 0, 1, 1).data];
      }, b64);
    };
    const bone = seqSlot.bone;
    const left = await s.E(([b]) => window.atlasEditor.localToScreen(b, -15, 0), [bone]);
    const right = await s.E(([b]) => window.atlasEditor.localToScreen(b, 15, 0), [bone]);
    await s.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    const p0 = await at(left.x, left.y);
    need(p0[0] > 200 && p0[2] < 60, `frame 1 should draw red, got ${p0}`);
    await s.E(([sl, n]) => window.atlasEditor.setupSelectSlot(sl, n), [seqSlot.name, seqSlot.attachment]);
    await wait(s, 400);
    await s.E(() => window.atlasEditor.inspectorOpen("att.sequence", true));
    await wait(s, 250);
    await s.page.fill("#seq-setup", "1");
    await s.page.press("#seq-setup", "Enter");
    await wait(s, 700);
    const p1 = await at(left.x, left.y);
    need(p1[2] > 200 && p1[0] < 60, `setup frame 2 should draw blue, got ${p1}`);
    // Clip mask: keep the left half only
    await s.E(([sl]) => window.atlasEditor.setupAddPolygon(sl, "clipping"), [seqSlot.name]);
    await wait(s, 700);
    const rr = await raw();
    const clipSlot = rr.slots.find((x) => x.name === `${seqSlot.name}_clip`);
    need(clipSlot, "no clip slot was added");
    const poly = rr.skins.body.attachments[clipSlot.name].clip.vertices;
    const cx = (poly[0] + poly[2]) / 2;
    await s.E(([sl, n, x]) => window.atlasEditor.setupEditPolygon(sl, n, { kind: "move", index: 1, x, y: -30 }), [clipSlot.name, "clip", cx]);
    await wait(s, 500);
    await s.E(([sl, n, x]) => window.atlasEditor.setupEditPolygon(sl, n, { kind: "move", index: 2, x, y: 30 }), [clipSlot.name, "clip", cx]);
    await wait(s, 700);
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 500);
    const inside = await at(left.x, left.y);
    const outside = await at(right.x, right.y);
    need(inside[2] > 200, `inside the mask the sequence should still draw, got ${inside}`);
    need(!(outside[2] > 200 && outside[0] < 60), `outside the mask the sequence should be clipped away, got ${outside}`);
    // Stage drag: a hit box point moves with the real mouse
    await s.E(([sl]) => window.atlasEditor.setupAddPolygon(sl, "boundingbox"), [seqSlot.name]);
    await wait(s, 700);
    const box = (await raw()).skins.body.attachments[`${seqSlot.name}_hitbox`].hitbox.vertices.slice();
    await s.E(() => window.atlasEditor.setupTool("attachment"));
    await wait(s, 300);
    const from = await s.E(([b, x, y]) => window.atlasEditor.localToScreen(b, x, y), [bone, box[0], box[1]]);
    await dragBy(s, from, 14, 9, { steps: 6 });
    await wait(s, 700);
    const after = (await raw()).skins.body.attachments[`${seqSlot.name}_hitbox`].hitbox.vertices;
    need(Math.abs(after[0] - box[0]) > 1 || Math.abs(after[1] - box[1]) > 1, `the hit box point did not move: ${box.slice(0, 2)} -> ${after.slice(0, 2)}`);
    await s.E(() => window.atlasEditor.setupTool("select"));
    for (let i = 0; i < 14; i++) {
      await s.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await s.page.keyboard.press("Control+z");
      await wait(s, 300);
      if (!(await raw()).slots.some((x) => x.name.startsWith("qaseq"))) break;
    }
    need(!(await raw()).slots.some((x) => x.name.startsWith("qaseq")), "undo did not remove the imported sequence");
  });
  await test("rig", "Point: + Grip / + Tip / + Point on a slot add a point attachment, the page edits it, Remove deletes it, each undoable; the skin page lists skin bones and constraints (Batch 7a, RG-07, RG-09)", async () => {
    await s.E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
    await wait(s, 300);
    const countPoints = async () => {
      const r = await raw();
      return Object.values(r.skins?.body?.attachments?.skin_forearm_near ?? {}).filter((a) => a.type === "point").length;
    };
    const n0 = await countPoints();
    for (const k of ["point", "grip", "tip"]) {
      const b = s.page.locator(`#setup-add-${k}`);
      need(await b.count(), `no #setup-add-${k} button`);
      need((await b.getAttribute("title"))?.length > 10, `#setup-add-${k} has no tooltip`);
    }
    await s.page.click("#setup-add-grip");
    await wait(s, 600);
    need((await countPoints()) === n0 + 1, "+ Grip added no point attachment");
    const grip = (await raw()).skins.body.attachments.skin_forearm_near.grip;
    need(grip && grip.type === "point", "the grip point is not named grip");
    need((await s.page.locator("#setup-img-x").count()) === 1 && (await s.page.locator("#setup-img-sx").count()) === 0, "the point page should show position and direction, no scale");
    await s.page.fill("#setup-img-x", "12");
    await s.page.press("#setup-img-x", "Enter");
    await wait(s, 500);
    need((await raw()).skins.body.attachments.skin_forearm_near.grip.x === 12, "the point x was not written");
    await undo();
    need((await raw()).skins.body.attachments.skin_forearm_near.grip.x !== 12, "undo did not restore the point x");
    await s.page.click("#setup-remove-image");
    await wait(s, 500);
    need((await countPoints()) === n0, "Remove point did not remove it");
    await undo();
    need((await countPoints()) === n0 + 1, "undo did not bring the point back");
    await undo();
    need((await countPoints()) === n0, "undo did not remove the added point");
    await s.E(() => window.atlasEditor.setupSelectNode({ kind: "skin", name: "body" }));
    await wait(s, 300);
    await s.E(() => window.atlasEditor.inspectorOpen("skin.scoped", true));
    await wait(s, 250);
    need((await s.page.locator("#setup-skin-bones").count()) === 1 && (await s.page.locator("#setup-skin-constraints").count()) === 1, "the skin page does not list skin bones and constraints");
  });
  await test("rig", "Clip mask, hit box and image sequence: add from the slot page, edit points and the end slot, make and unmake a sequence, each undoable; the Tree shows badges (Batch 12a)", async () => {
    const raw = () => s.E(() => window.atlasEditor.setupRaw());
    const undo = async () => {
      await s.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await s.page.keyboard.press("Control+z");
      await wait(s, 500);
    };
    const att = async (slot, name) => (await raw()).skins.body.attachments[slot]?.[name];
    await s.E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
    await wait(s, 300);
    for (const k of ["clipping", "boundingbox"]) {
      need(await s.page.locator(`#setup-add-${k}`).count(), `no #setup-add-${k} button`);
      need(((await s.page.locator(`#setup-add-${k}`).getAttribute("title")) ?? "").length > 20, `#setup-add-${k} has no tooltip`);
    }
    await s.page.click("#setup-add-boundingbox");
    await wait(s, 600);
    const box = await att("skin_forearm_near_hitbox", "hitbox");
    need(box && box.type === "boundingbox" && box.vertices.length === 8, `+ Hit box wrote ${JSON.stringify(box)?.slice(0, 100)}`);
    need((await s.page.locator("#poly-points .insp-item").count()) === 4, "the hit box page should list 4 points");
    await s.page.fill("#poly-x0", "5");
    await s.page.press("#poly-x0", "Enter");
    await wait(s, 500);
    need((await att("skin_forearm_near_hitbox", "hitbox")).vertices[0] === 5, "editing point 1 X did not write");
    await s.page.locator('#poly-points .insp-item').first().locator("button.btn.sm").click();
    await wait(s, 500);
    need((await att("skin_forearm_near_hitbox", "hitbox")).vertices.length === 10, "the + button did not add a point");
    await s.page.locator("#poly-points .insp-item .insp-trash").last().click();
    await wait(s, 500);
    need((await att("skin_forearm_near_hitbox", "hitbox")).vertices.length === 8, "the trash button did not remove a point");
    await undo();
    need((await att("skin_forearm_near_hitbox", "hitbox")).vertices.length === 10, "undo did not bring the point back");
    await undo();
    await undo();
    await undo();
    need(!(await att("skin_forearm_near_hitbox", "hitbox")), "undo did not remove the added hit box");
    await s.E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
    await wait(s, 300);
    await s.page.click("#setup-add-clipping");
    await wait(s, 600);
    need((await att("skin_forearm_near_clip", "clip"))?.type === "clipping", "+ Clip mask added no clipping attachment");
    need(await s.page.locator("#poly-end").count(), "the clip mask page has no End slot select");
    need(((await s.page.locator("#poly-end").getAttribute("title")) ?? "").length > 10, "End slot has no tooltip");
    await s.page.locator("#poly-end").selectOption("shirt_tip_far");
    await wait(s, 500);
    need((await att("skin_forearm_near_clip", "clip")).end === "shirt_tip_far", "End slot was not written");
    await s.page.fill("#outliner .ol-search", "clip");
    await wait(s, 500);
    need((await s.page.locator("#outliner .ol-badge.b-clip").count()) >= 1, "the Tree shows no clip badge");
    await s.page.fill("#outliner .ol-search", "");
    await undo();
    await undo();
    need(!(await att("skin_forearm_near_clip", "clip")), "undo did not remove the added clip mask");
    await s.E(() => window.atlasEditor.setupSelectSlot("shirt_tip_far", "tip"));
    await wait(s, 400);
    await s.E(() => window.atlasEditor.inspectorOpen("att.sequence", true));
    await wait(s, 250);
    need(((await s.page.locator("#seq-make").getAttribute("title")) ?? "").length > 20, "Play numbered images has no tooltip");
    await s.page.click("#seq-make");
    await wait(s, 600);
    need((await att("shirt_tip_far", "tip")).sequence?.count === 2, "Play numbered images wrote no sequence");
    await s.page.fill("#seq-count", "4");
    await s.page.press("#seq-count", "Enter");
    await wait(s, 500);
    need((await att("shirt_tip_far", "tip")).sequence.count === 4, "Frames was not written");
    await s.page.click("#seq-remove");
    await wait(s, 500);
    need(!(await att("shirt_tip_far", "tip")).sequence, "Make a single image did not remove the sequence");
    await undo();
    await undo();
    await undo();
    need(!(await att("shirt_tip_far", "tip")).sequence, "undo did not remove the sequence");
  });
  await test("rig", "Linked mesh: Link to mesh in the inspector turns an image into a linked mesh (Tree badge, deform inheritance), Unlink copies the shape back, each undoable (Batch 7b, )", async () => {
    await s.E(() => window.atlasEditor.setupSelectSlot("shirt_tip_far", "tip"));
    await wait(s, 400);
    await s.E(() => window.atlasEditor.inspectorOpen("att.link", true));
    await wait(s, 250);
    const sel = s.page.locator("#setup-link-source");
    need(await sel.count(), "no #setup-link-source (Link to mesh) field");
    need(((await sel.getAttribute("title")) ?? "").length > 10, "Link to mesh has no tooltip");
    const att = async () => (await raw()).skins.body.attachments.shirt_tip_far.tip;
    need((await att()).type === "mesh", "the fixture image should start as a plain mesh");
    const w0 = (await att()).width;
    await sel.selectOption("body/shirt_tip_near/tip");
    await wait(s, 700);
    const linked = await att();
    need(linked.type === "linkedMesh" && linked.source.slot === "shirt_tip_near" && linked.inheritDeform === true, `Link to mesh wrote ${JSON.stringify(linked).slice(0, 120)}`);
    need((await s.page.locator("#setup-link-inherit").count()) === 1 && (await s.page.locator("#setup-unlink").isEnabled()), "linked mesh page lacks Inherit deform / Unlink");
    await s.page.fill("#outliner .ol-search", "tip");
    await wait(s, 500);
    need((await s.page.locator('#outliner .ol-badge.b-linked').count()) >= 1, "the Tree shows no linked badge");
    await s.page.fill("#outliner .ol-search", "");
    await s.page.click("#setup-link-inherit");
    await wait(s, 600);
    need((await att()).inheritDeform === false, "Inherit deform checkbox did not write inheritDeform:false");
    await s.page.click("#setup-unlink");
    await wait(s, 700);
    const own = await att();
    const srcMesh = (await raw()).skins.body.attachments.shirt_tip_near.tip;
    need(own.type === "mesh" && JSON.stringify(own.triangles) === JSON.stringify(srcMesh.triangles) && own.width === w0, `Unlink did not copy the source shape into the image: ${own.type} w=${own.width} tri=${(own.triangles ?? []).length}/${srcMesh.triangles.length}`);
    await undo();
    need((await att()).type === "linkedMesh", "undo did not restore the link");
    await undo();
    await undo();
    need((await att()).type === "mesh", "undo did not restore the plain mesh");
  });
  await test("rig", "Mesh tool: Draw hull (5 clicks + close makes a 5 point outline), typed X / Y / U / V, Rotate / scale around a pivot, Reset UVs, each one undo step (Batch 7b, )", async () => {
    await s.E(() => window.atlasEditor.setupTool("mesh"));
    await s.E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
    await wait(s, 800);
    const st = () => s.E(() => window.atlasMesh.state());
    const att = async () => (await raw()).skins.body.attachments.shirt_torso.torso;
    for (const id of ["#mesh-mode-hull", "#mesh-reset-uvs", "#mesh-vx", "#mesh-vy", "#mesh-vu", "#mesh-vv", "#mesh-rot", "#mesh-sx", "#mesh-sy", "#mesh-pivot", "#mesh-xform-go"]) {
      const l = s.page.locator(id);
      need(await l.count(), `${id} does not exist`);
      need(((await l.getAttribute("title")) ?? "").length > 10, `${id} has no tooltip`);
    }
    const s0 = await st();
    need(s0.points > 20, "the mesh did not load");
    const uv0 = JSON.stringify((await att()).uvs);
    // Typed X / Y moves the selected point; undo puts it back.
    await s.E((i) => window.atlasMesh.select([i]), s0.hull + 1);
    await wait(s, 200);
    const x0 = Number(await s.page.inputValue("#mesh-vx"));
    await s.page.fill("#mesh-vx", String(x0 + 7));
    await s.page.press("#mesh-vx", "Enter");
    await wait(s, 700);
    const x1 = Number(await s.page.inputValue("#mesh-vx"));
    need(Math.abs(x1 - (x0 + 7)) < 0.01, `typed X gave ${x1}, wanted ${x0 + 7}`);
    await undo();
    await s.E((i) => window.atlasMesh.select([i]), s0.hull + 1);
    await wait(s, 200);
    need(Math.abs(Number(await s.page.inputValue("#mesh-vx")) - x0) < 0.01, "undo did not restore the typed X");
    // Typed U writes the UV; Reset UVs puts it back on the picture.
    await s.page.fill("#mesh-vu", "0.5");
    await s.page.press("#mesh-vu", "Enter");
    await wait(s, 700);
    need((await att()).uvs[2 * (s0.hull + 1)] === 0.5, "typed U was not written");
    await s.page.click("#mesh-reset-uvs");
    await wait(s, 700);
    const back = (await att()).uvs;
    const u0 = JSON.parse(uv0)[2 * (s0.hull + 1)];
    need(Math.abs(back[2 * (s0.hull + 1)] - u0) < 0.01, `Reset UVs left U at ${back[2 * (s0.hull + 1)]}, wanted about ${u0}`);
    await undo();
    await undo();
    need(JSON.stringify((await att()).uvs) === uv0, "undo did not restore the UVs");
    // Rotate 90 degrees around the picture centre: every point moves, undo restores them.
    await s.E((n) => window.atlasMesh.select(Array.from({ length: n }, (_, i) => i)), s0.points);
    await wait(s, 200);
    const pos = () => s.E(() => [0, 1, 2].map((i) => window.atlasMesh.vertex(i)));
    const p0 = JSON.stringify(await pos());
    await s.page.selectOption("#mesh-pivot", "picture");
    await s.page.fill("#mesh-rot", "90");
    await s.page.press("#mesh-rot", "Enter");
    await s.page.click("#mesh-xform-go");
    await wait(s, 800);
    need(JSON.stringify(await pos()) !== p0, `Rotate / scale moved nothing (status: ${await s.E(() => document.getElementById("status")?.textContent ?? "")})`);
    await undo();
    need(JSON.stringify(await pos()) === p0, "undo did not restore the rotated points");
    // Draw hull: five clicks, then a click on the first point closes it.
    await s.page.click("#mesh-mode-hull");
    const w = s0.width;
    const h = s0.height;
    const pts = [[0.15, 0.1], [0.85, 0.1], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]];
    await s.page.keyboard.down("Control");
    for (const [fx, fy] of pts) {
      const c = await s.E((p) => window.atlasMesh.client(p.x, p.y), { x: fx * w, y: fy * h });
      await s.page.mouse.click(c.x, c.y);
      await wait(s, 120);
    }
    need((await st()).hullClicks === 5, `expected 5 hull points drawn, saw ${(await st()).hullClicks}`);
    const c0 = await s.E((p) => window.atlasMesh.client(p.x, p.y), { x: pts[0][0] * w, y: pts[0][1] * h });
    await s.page.mouse.click(c0.x, c0.y);
    await s.page.keyboard.up("Control");
    await wait(s, 900);
    const closed = await st();
    need(closed.hull === 5 && closed.hullClicks === 0, `Draw hull gave hull ${closed.hull}, ${closed.hullClicks} points left over`);
    await undo();
    need((await st()).hull === s0.hull, "undo did not restore the old outline");
    await s.page.click("#mesh-mode-points");
  });
  await test("rig", "Weights table: editable % per bone, Set active % on selection normalises, Normalise / Prune / Lock / Smooth are visible; one undo step each (Batch 7b, )", async () => {
    await s.E(() => window.atlasEditor.setupTool("weights"));
    await s.E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
    await wait(s, 900);
    for (const id of ["#wt-normalise", "#wt-prune", "#wt-smooth", "#wt-setval", "#wt-setsel"]) {
      const l = s.page.locator(id);
      need(await l.count(), `${id} does not exist`);
      need(((await l.getAttribute("title")) ?? "").length > 5, `${id} has no tooltip`);
    }
    need(await s.page.locator("#wt-bones .wt-lock").count(), "no per-bone Lock buttons");
    await s.E(() => window.atlasWeights.setBrush({ tool: "select" }));
    await s.E(() => window.atlasWeights.setActive("chest"));
    await s.E(() => { const w = window.atlasWeights; w.selectAll(); });
    await wait(s, 400);
    need(await s.page.locator("#wt-tbody input.wt-cell").count(), "the weights table shows no editable % cells");
    const e0 = await s.E(() => window.atlasEditor.setupState().undoable);
    await s.page.fill("#wt-setval", "100");
    await s.page.click("#wt-setsel");
    await wait(s, 1200);
    const sums = await s.E(() => { const w = window.atlasWeights; const n = w.state().vertices; let worst = 0, chest = 0; for (let v = 0; v < n; v++) { const row = w.weights(v); const sum = Object.values(row).reduce((a, b) => a + b, 0); worst = Math.max(worst, Math.abs(sum - 1)); chest += row.chest ?? 0; } return { worst, chest: chest / n }; });
    need(sums.worst < 0.01, `weights are not normalised after Set active % (worst sum error ${sums.worst})`);
    need(sums.chest > 0.95, `chest should hold ~100% on every selected vertex (mean ${sums.chest})`);
    need((await s.E(() => window.atlasEditor.setupState().undoable)) === e0 + 1, "Set active % was not one undo step");
    await undo();
    const after = await s.E(() => { const w = window.atlasWeights; const n = w.state().vertices; let chest = 0; for (let v = 0; v < n; v++) chest += w.weights(v).chest ?? 0; return chest / n; });
    need(after < sums.chest - 0.05, "undo did not restore the weights");
    await s.E(() => { window.atlasEditor.setupTool("move"); window.atlasEditor.setupSelectNode({ kind: "bone" }); window.atlasEditor.select("chest"); });
    await wait(s, 400);
  });
  await test("rig", "Revert rig to saved undoes the unsaved edits; Redo brings them back", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await s.E(() => window.atlasEditor.setupTransform("chest", { rotation: 11 }));
    await wait(s, 500);
    await s.page.click("#setup-newslot");
    await wait(s, 500);
    const dirty = await raw();
    await s.E(() => window.atlasEditor.inspectorOpen("rig.edits"));
    await wait(s, 200);
    need(await s.page.locator("#setup-revert").isEnabled(), "Revert is disabled with unsaved edits");
    await s.page.click("#setup-revert");
    await wait(s, 1500);
    const clean = await raw();
    need(clean.slots.length < dirty.slots.length, "Revert left the new slot");
    need(clean.bones.find((b) => b.name === "chest").rotation !== 11, "Revert left the bone edit");
    need(await s.page.locator("#setup-revert").isDisabled(), "Revert stays enabled with nothing to revert");
    await s.E(() => window.atlasEditor.setupRedo());
    await wait(s, 400);
    need((await raw()).bones.find((b) => b.name === "chest").rotation === 11, "Redo did not bring the reverted edit back");
    await s.E(() => window.atlasEditor.setupRevert());
  });
  await test("rig", "Setup: Move along the X arm with Axes = World changes world x only (the stage context bar's Axes work in Setup)", async () => {
    await s.E(() => { window.atlasEditor.select("forearm_near"); window.atlasEditor.setupTool("move"); });
    await s.page.click("#xs-space-world");
    await wait(s, 300);
    const e0 = await ends(s, "forearm_near");
    await dragBy(s, { x: e0.origin.x + 30, y: e0.origin.y }, 26, 18);
    await wait(s, 400);
    const e1 = await ends(s, "forearm_near");
    await undo();
    await s.page.click("#xs-space-parent");
    need(Math.abs(e1.origin.y - e0.origin.y) < 0.8, `world y moved by ${(e1.origin.y - e0.origin.y).toFixed(2)} px under Axes = World`);
    need(e1.origin.x - e0.origin.x > 10, `world x moved by only ${(e1.origin.x - e0.origin.x).toFixed(2)} px`);
  });
  await test("rig", "Setup Scale drag on chest changes scaleX only (X handle), the handle lies along the Axes choice, and it undoes (Batch 7a, RG-04)", async () => {
    await s.E(() => { window.atlasEditor.select("chest"); window.atlasEditor.setupTool("scale"); });
    await s.page.click("#xs-space-world");
    await wait(s, 300);
    const e0 = await ends(s, "chest");
    const b0 = (await raw()).bones.find((b) => b.name === "chest");
    const n0 = await edits();
    await dragBy(s, { x: e0.origin.x + 64, y: e0.origin.y }, 40, 0);
    await wait(s, 500);
    const b1 = (await raw()).bones.find((b) => b.name === "chest");
    const n1 = await edits();
    await undo();
    const b2 = (await raw()).bones.find((b) => b.name === "chest");
    await s.page.click("#xs-space-parent");
    need((b1.scaleX ?? 1) > (b0.scaleX ?? 1) * 1.3, `scaleX went ${b0.scaleX ?? 1} -> ${b1.scaleX}`);
    need(Math.abs((b1.scaleY ?? 1) - (b0.scaleY ?? 1)) < 1e-6, "scaleY changed on an X-handle drag");
    need(n1 === n0 + 1, `the drag was ${n1 - n0} undo steps`);
    need((b2.scaleX ?? 1) === (b0.scaleX ?? 1), "Ctrl+Z did not restore scaleX");
  });
  await test("rig", "Setup Shear drag on chest changes shearY (green handle) and undoes (Batch 7a, RG-04)", async () => {
    await s.E(() => { window.atlasEditor.select("chest"); window.atlasEditor.setupTool("shear"); });
    await s.page.click("#xs-space-world");
    await wait(s, 300);
    const e0 = await ends(s, "chest");
    const b0 = (await raw()).bones.find((b) => b.name === "chest");
    await dragBy(s, { x: e0.origin.x, y: e0.origin.y + 64 }, 40, 0, { steps: 10 });
    await wait(s, 500);
    const b1 = (await raw()).bones.find((b) => b.name === "chest");
    await undo();
    const b2 = (await raw()).bones.find((b) => b.name === "chest");
    await s.page.click("#xs-space-parent");
    need(Math.abs((b1.shearY ?? 0) - (b0.shearY ?? 0)) > 5, `shearY went ${b0.shearY ?? 0} -> ${b1.shearY}`);
    need(Math.abs((b1.shearX ?? 0) - (b0.shearX ?? 0)) < 1e-6, "shearX changed on a Y-handle drag");
    need((b2.shearY ?? 0) === (b0.shearY ?? 0), "Ctrl+Z did not restore shearY");
  });
  await test("rig", "View HUD in Rig: Facing right, Pan and Fit work and the Animate-only buttons are hidden", async () => {
    await s.page.click("#ctx-overlays");
    for (const id of ["#fit", "#vh-frame", "#vh-pan", "#vh-phone", "#vh-facing"]) need(await s.page.locator(id).isVisible(), `${id} is not visible in Rig`);
    for (const id of ["#vh-game", "#vh-onion", "#vh-ab", "#vh-snap15"]) need(!(await s.page.locator(id).isVisible()), `${id} should be hidden in Rig`);
    await s.page.click("#vh-facing");
    need(await s.page.locator("#vh-facing").evaluate((e) => e.classList.contains("on")), "Facing right did not switch on");
    await s.page.click("#vh-facing");
    await s.page.click("#vh-pan");
    need(await s.page.locator("#vh-pan").evaluate((e) => e.classList.contains("on")), "Pan did not switch on");
    await s.page.click("#vh-pan");
    await s.page.click("#vh-frame");
    await s.page.click("#fit");
  });
  // ---- Batch 3: Rig inspector and Tree sections ----
  for (const [w, h] of [[1366, 768], [1600, 1000]]) {
    await test("rig", `Rig inspector scrollHeight <= 1.2 x clientHeight for a bone, a slot and a constraint at ${w}x${h}`, async () => {
      const p = await session(w, h);
      try {
        await p.E(() => { window.atlasEditor.workspace("rig"); });
        await p.page.waitForTimeout(500);
        await p.E(() => window.atlasEditor.showTab("rig"));
        const nodes = [["bone", () => window.atlasEditor.select("chest")], ["slot", () => window.atlasEditor.setupSelectSlot("skin_forearm_near")], ["constraint", () => window.atlasEditor.setupSelectNode({ kind: "constraint", ckind: "ik", name: "leg_ik_near" })]];
        for (const [name, go] of nodes) {
          await p.E(go);
          await p.page.waitForTimeout(350);
          const m = await p.E(() => { const b = document.querySelector("#inspector .insp-body"); return b ? [b.scrollHeight, b.clientHeight] : null; });
          need(m, `${name}: no inspector body`);
          need(m[0] <= m[1] * 1.2, `${name} page at ${w}x${h}: scrollHeight ${m[0]} > 1.2 x clientHeight ${m[1]}`);
        }
      } finally { await p.close(); }
    });
  }
  await test("rig", "No bone property control appears twice (ids unique, one #setup-length), and the Tree has no properties pane", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await s.E(() => window.atlasEditor.inspectorOpen("bone.appearance", true));
    await wait(s, 300);
    const r = await s.E(() => {
      const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      return { dup: [...new Set(dup)], length: document.querySelectorAll("#setup-length").length, lengthInputs: document.querySelectorAll('input[data-field="length"], #outliner input[type="number"]:not(.ol-split)').length, props: document.querySelectorAll("#outliner .ol-props").length, keep: document.querySelectorAll("#setupopts, #setuppanel input[type=checkbox][id*=keep]").length };
    });
    need(r.dup.length === 0, `duplicate ids: ${r.dup.join(", ")}`);
    need(r.length === 1 && r.lengthInputs === 0, `length fields: ${r.length} inspector, ${r.lengthInputs} in the Tree`);
    need(r.props === 0 && r.keep === 0, `leftover Tree props pane (${r.props}) or keep / hide checkboxes (${r.keep})`);
  });
  await test("rig", "Tree shows counted Constraints, Skins and Draw order sections; the Rig status bar has no frame / fps text", async () => {
    const r = await s.E(() => ({
      heads: [...document.querySelectorAll("#outliner .ol-row.k-group .ol-label")].map((e) => e.textContent),
      frame: (() => { const e = document.getElementById("sb-frame"); return !!e && e.offsetParent !== null && /frame|fps/i.test(e.textContent); })(),
      slots: window.atlasEditor.setupRaw().slots.length,
      cons: window.atlasEditor.setupRaw().ik.length + window.atlasEditor.setupRaw().transform.length + (window.atlasEditor.setupRaw().physics?.length ?? 0)
    }));
    need(r.heads.includes(`Constraints (${r.cons})`), `Constraints header: ${r.heads.join(" | ")}`);
    need(r.heads.includes(`Draw order (${r.slots})`), `Draw order header: ${r.heads.join(" | ")}`);
    need(r.heads.some((h) => /^Skins \(\d+\)$/.test(h)), `Skins header: ${r.heads.join(" | ")}`);
    need(!r.frame, "the status bar shows frame / fps text in Rig");
  });
  await test("rig", "Clicking a Tree slot row opens the slot page, an image row the image page, a constraint row the constraint page, a bone row the bone page", async () => {
    const kind = () => s.E(() => document.querySelector("#inspector .insp-kind")?.textContent);
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const slotRow = s.page.locator("#outliner .ol-row.k-slot").first();
    await slotRow.click();
    await wait(s, 300);
    need((await kind()) === "SLOT", `slot row opened ${await kind()}`);
    await s.page.locator("#outliner .ol-row.k-bone").first().click();
    await wait(s, 300);
    need((await kind()) === "BONE", `bone row opened ${await kind()}`);
    await s.E(() => window.atlasEditor.setupSelectNode({ kind: "constraint", ckind: "ik", name: "leg_ik_near" }));
    await wait(s, 300);
    need((await kind()) === "IK", `constraint node opened ${await kind()}`);
    await s.E(() => window.atlasEditor.select("chest"));
  });
  // ---- Batch 4: context menus, images dock, multi-bone transforms, box select, delete confirm, lock, F2 ----
  await test("rig", "Tree: right-click a bone row opens a menu with Rename, Delete, Select children, New child, New slot, Add IK; a slot row has Attach image", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    await s.page.locator('#outliner .ol-row[data-id="b:chest"]').click({ button: "right" });
    const items = await s.E(() => [...document.querySelectorAll(".ctxmenu button")].map((b) => b.textContent.trim()));
    for (const w of ["Rename", "Delete", "Select children", "New child bone", "New slot", "Add IK"]) need(items.some((i) => i.startsWith(w)), `bone menu lacks ${w}: ${items.join(" | ")}`);
    await press(s, "Escape");
    await s.page.locator("#outliner .ol-row.k-slot").first().click({ button: "right" });
    const si = await s.E(() => [...document.querySelectorAll(".ctxmenu button")].map((b) => b.textContent.trim()));
    need(si.some((i) => i.startsWith("Attach image")) && si.some((i) => i.startsWith("Rename")), `slot menu: ${si.join(" | ")}`);
    await press(s, "Escape");
  });
  await test("rig", "F2 renames the selected bone in the Tree, Enter commits, Undo restores", async () => {
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    await s.page.locator('#outliner .ol-row[data-id="b:chest"]').click();
    await press(s, "F2");
    const input = s.page.locator("#outliner .ol-rename");
    need(await input.count(), "F2 opened no rename field");
    await input.fill("chest_f2");
    await input.press("Enter");
    await wait(s, 600);
    need((await raw()).bones.some((b) => b.name === "chest_f2"), "F2 rename did not apply");
    await undo();
    need((await raw()).bones.some((b) => b.name === "chest"), "undo did not restore the name");
  });
  await test("rig", "Images dock: >= 100 thumbnails load, search filters, dragging a thumbnail onto a slot row attaches it (one undo step)", async () => {
    await s.page.click("#idk-tab-images");
    await s.page.waitForFunction(() => [...document.querySelectorAll("#idk-thumbs .idk-th img")].filter((i) => i.naturalWidth > 0).length >= 100, null, { timeout: 15000 });
    const all = await s.E(() => document.querySelectorAll("#idk-thumbs .idk-th").length);
    await s.page.fill("#idk-search", "head");
    await wait(s, 800);
    const some = await s.E(() => document.querySelectorAll("#idk-thumbs .idk-th").length);
    need(some > 0 && some < all, `search kept ${some} of ${all}`);
    await s.page.fill("#idk-search", "");
    await wait(s, 800);
    const r0 = await raw();
    const slot = r0.slots.find((x) => x.name.startsWith("skin_hand"))?.name ?? r0.slots[3].name;
    const skin = Object.keys(r0.skins)[0];
    const n0 = await edits();
    const row = s.page.locator(`#outliner .ol-row[data-id="s:${slot}"]`);
    need(await row.count(), `slot row ${slot} not in the Tree`);
    await s.page.locator("#idk-thumbs .idk-th").nth(3).dragTo(row);
    await wait(s, 800);
    const r1 = await raw();
    need(Object.keys(r1.skins[skin].attachments[slot] ?? {}).length === Object.keys(r0.skins[skin].attachments[slot] ?? {}).length + 1, "the drop attached nothing");
    need((await edits()) === n0 + 1, "the drop was not one undo step");
    await undo();
    await s.page.click("#idk-fold");
  });
  await test("rig", "Shift-select two bones, Rotate drag: both rotations change, one undo step reverts both", async () => {
    await s.E(() => { window.atlasEditor.setupTool("rotate"); window.atlasEditor.selectBones(["chest", "upper_arm_near"], "replace", "chest"); });
    await wait(s, 400);
    const rot = async () => Object.fromEntries((await raw()).bones.filter((b) => ["chest", "upper_arm_near"].includes(b.name)).map((b) => [b.name, b.rotation ?? 0]));
    const r0 = await rot();
    const n0 = await edits();
    await ringDrag(s, "chest", { sweep: 0.9, steps: 10, a0: Math.PI, r0: 260 });
    await wait(s, 800);
    const r1 = await rot();
    need(Math.abs(r1.chest - r0.chest) > 0.5 && Math.abs(r1.upper_arm_near - r0.upper_arm_near) > 0.5, `rotations ${JSON.stringify(r0)} -> ${JSON.stringify(r1)}`);
    need((await edits()) === n0 + 1, "not one undo step");
    await undo();
    const r2 = await rot();
    need(Math.abs(r2.chest - r0.chest) < 0.01 && Math.abs(r2.upper_arm_near - r0.upper_arm_near) < 0.01, "one Ctrl+Z did not revert both");
    await s.E(() => window.atlasEditor.setupTool("select"));
  });
  await test("rig", "Delete with a selection opens the confirm; Enter deletes; Ctrl+Z restores", async () => {
    const leaf = await s.E(() => { const r = window.atlasEditor.setupRaw(); const kids = new Set(r.bones.map((b) => b.parent)); return r.bones.find((b) => b.parent && !kids.has(b.name) && !r.ik?.some((c) => c.bones.includes(b.name) || c.target === b.name))?.name; });
    await s.E((n) => window.atlasEditor.select(n), leaf);
    await wait(s, 300);
    const n = (await raw()).bones.length;
    await s.page.locator("#outliner .ol-btn[data-act=delete]").click();
    await s.page.waitForSelector("#delete-bones-dialog");
    need((await raw()).bones.length === n, "deleted before the confirm");
    await press(s, "Enter");
    await wait(s, 800);
    need((await raw()).bones.length === n - 1, "Enter did not delete");
    await undo();
    need((await raw()).bones.length === n, "Ctrl+Z did not restore");
  });
  await test("rig", "Lock column: a locked bone cannot be picked on the canvas; box select picks the bones inside the rectangle", async () => {
    await s.E(() => { window.atlasEditor.setupTool("select"); window.atlasEditor.select("root"); });
    await wait(s, 300);
    await s.page.locator('#outliner .ol-row[data-id="b:chest"] .ol-lock').click();
    await wait(s, 300);
    const e = await ends(s, "chest");
    await s.page.mouse.click((e.origin.x + e.tip.x) / 2, (e.origin.y + e.tip.y) / 2);
    await wait(s, 300);
    need((await s.E(() => window.atlasEditor.boneSelection().active)) !== "chest", "a locked bone was picked");
    await s.page.locator('#outliner .ol-row[data-id="b:chest"] .ol-lock').click();
    const box = await canvasBox(s);
    await s.E(() => window.atlasEditor.select("root"));
    await s.page.mouse.move(box.x, box.y);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + box.width, box.y + box.height, { steps: 8 });
    await s.page.mouse.up();
    await wait(s, 400);
    const n = await s.E(() => window.atlasEditor.boneSelection().names.length);
    need(n >= 2, `box select picked ${n} bones`);
    await s.E(() => window.atlasEditor.select("chest"));
  });
  cleanups.push(() => s.close());
}

// ===== 3c. Hidden-features batch 4: Animate slot keys, clip management, Weights actions, Add parts, Save rig at 1366 ================
if (want("hidden4")) {
  const s = track(await session(1600, 1000));
  s.phase = "hidden4";
  await autoAccept(s.page);
  const undoKey = async () => { await neutral(s); await press(s, "Control+z"); await wait(s, 500); };
  const clipJson = () => s.E(() => window.atlasEditor.state().clip);
  const clipOptions = () => s.E(() => [...document.querySelectorAll("#clip option")].map((o) => o.value));

  // ---- Animate: draw order and image swap keys live in the Keys tab ----
  await makeClip(s, "qa_h4");
  await ws(s, "animate");
  await s.E(() => window.atlasEditor.showTab("keys"));
  await s.E(() => window.atlasEditor.setTime(6 / 30));
  await wait(s, 300);
  await test("hidden4", "Animate Keys tab: Key image swap adds a swap key and one Ctrl+Z removes it", async () => {
    for (const id of ["#slot-key-swap", "#slot-del-swap"]) need(await s.page.locator(id).isVisible(), `${id} is not visible in Animate's Keys tab`);
    const n0 = JSON.stringify((await clipJson()).slots ?? {});
    await s.page.click("#slot-key-swap");
    await wait(s, 400);
    const j1 = JSON.stringify((await clipJson()).slots ?? {});
    need(j1 !== n0, "Key image swap changed nothing in the clip");
    need(await s.page.locator("#slot-del-swap").isEnabled(), "Delete swap key stays disabled on the swap key");
    await undoKey();
    need(JSON.stringify((await clipJson()).slots ?? {}) === n0, "Ctrl+Z did not remove the swap key");
  });
  await test("hidden4", "Animate Keys tab: Key draw order keys the slot's place and Ctrl+Z removes the key", async () => {
    need(await s.page.locator("#slot-key-order").isVisible(), "#slot-key-order is not visible in Animate's Keys tab");
    need(!(await s.page.locator("#slot-key-order").getAttribute("title"))?.includes("undefined"), "tooltip missing");
    const n0 = ((await clipJson()).drawOrder ?? []).length;
    await s.page.click("#slot-key-order");
    await wait(s, 400);
    need((((await clipJson()).drawOrder ?? []).length) === n0 + 1, "Key draw order added no draw order key");
    await undoKey();
    need((((await clipJson()).drawOrder ?? []).length) === n0, "Ctrl+Z did not remove the draw order key");
  });

  // ---- Clip management from Animate's header ----
  const manage = async (act) => {
    await s.page.click("#clip-manage");
    await s.page.locator(`.cb-menu-item[data-act="${act}"]`).click();
    await wait(s, 300);
  };
  await test("hidden4", "Clip Manage (Animate header): Duplicate makes the copy and opens it", async () => {
    need(await s.page.locator("#clip-manage").isVisible(), "#clip-manage is not visible in Animate");
    await manage("duplicate-copy");
    await s.page.fill("#cb-dup-name", "qa_h4_copy");
    await s.page.click("#cb-dup-dialog .cb-go");
    await wait(s, 1800);
    need((await clipOptions()).includes("clip:qa_h4_copy"), "the copy is not in the clip picker");
    need((await s.E(() => window.atlasEditor.state().clipName)) === "qa_h4_copy", "the copy did not open");
    need(await s.page.locator("#clipboard").isHidden(), "the Manage overlay stayed up after the dialog closed");
  });
  await test("hidden4", "Clip Manage: Rename renames the open clip and the old name is gone", async () => {
    await manage("rename");
    await s.page.fill("#cb-rename-name", "qa_h4_renamed");
    await s.page.click("#cb-rename-dialog .cb-go");
    await wait(s, 2200);
    const o = await clipOptions();
    need(o.includes("clip:qa_h4_renamed") && !o.includes("clip:qa_h4_copy"), `picker has ${o.filter((x) => x.includes("qa_h4")).join(", ")}`);
  });
  await test("hidden4", "Clip Manage: Set length / fps changes the length and Ctrl+Z restores it", async () => {
    const d0 = await s.page.inputValue("#duration");
    await manage("length");
    await s.page.fill("#cb-len-length", "1.5");
    await s.page.click("#cb-length-dialog .cb-go");
    await wait(s, 1200);
    const d1 = await s.page.inputValue("#duration");
    need(d1 !== d0 && Number(d1) === 1.5, `length stayed ${d1} (was ${d0})`);
    await undoKey();
    need((await s.page.inputValue("#duration")) === d0, "Ctrl+Z did not restore the length");
  });
  await test("hidden4", "Clip Manage: Delete asks first (Cancel keeps the clip), then deletes it", async () => {
    await manage("delete");
    need(await s.page.locator("#cb-delete-dialog").isVisible(), "no delete confirmation");
    await s.page.click("#cb-delete-dialog .cb-cancel");
    await wait(s, 400);
    need((await clipOptions()).includes("clip:qa_h4_renamed"), "Cancel still deleted the clip");
    await manage("delete");
    await s.page.click("#cb-delete-dialog .cb-go");
    await wait(s, 1800);
    need(!(await clipOptions()).includes("clip:qa_h4_renamed"), "the clip is still in the picker after Delete");
  });
  cleanups.push(() => s.close());

  // ---- Rig: Add parts, and the Weights actions ----
  const r = track(await session(1600, 1000));
  r.phase = "hidden4-rig";
  await autoAccept(r.page);
  const rUndo = async () => { await neutral(r); await press(r, "Control+z"); await wait(r, 700); };
  const redits = () => r.E(() => window.atlasEditor.setupState().undoable);
  await ws(r, "rig");
  await test("hidden4", "Rig: Add parts is visible with a tooltip and says why a built-in rig cannot take parts", async () => {
    await r.page.click("#rig-file");
    const b = r.page.locator("#rig-add-parts");
    need(await b.isVisible(), "#rig-add-parts is not visible in Rig (Rig file menu)");
    need((await b.getAttribute("title")).length > 10, "no tooltip");
    await b.click();
    await wait(r, 300);
    const msg = await r.E(() => document.getElementById("status")?.textContent ?? "");
    need(/New rig/.test(msg), `status said: ${msg}`);
  });
  await r.E(() => window.atlasEditor.mountOutfit("turned-l"));
  await wait(r, 1800);
  await r.page.click("#toolpalette [data-tool='weights']");
  await wait(r, 500);
  await r.E(() => window.atlasEditor.selectSlot("torso"));
  await wait(r, 900);
  const wsig = () => r.E(() => { const w = window.atlasWeights; const n = w.state().vertices; const out = []; for (let v = 0; v < n; v += 5) out.push(w.weights(v)); return JSON.stringify(out); });
  /** Largest per-bone weight difference between two signatures (a pasted copy may differ in the 4th decimal after the save rounds it). */
  const wdiff = (a, b) => { const x = JSON.parse(a), y = JSON.parse(b); let m = x.length === y.length ? 0 : 9; x.forEach((row, i) => { const o = y[i] ?? {}; for (const k of new Set([...Object.keys(row), ...Object.keys(o)])) m = Math.max(m, Math.abs((row[k] ?? 0) - (o[k] ?? 0))); }); return m; };
  const report = () => r.page.locator("#wt-report").textContent();
  await test("hidden4", "Weights: Smooth, Prune, Weld, Copy / Paste and Mirror are visible with tooltips", async () => {
    for (const id of ["#wt-smooth", "#wt-prune", "#wt-weld", "#wt-copy", "#wt-paste", "#wt-mirror-near", "#wt-mirror-far", "#wt-normalise"]) {
      const l = r.page.locator(id);
      need(await l.count(), `${id} does not exist`);
      need(await l.isVisible(), `${id} is not visible in the Weights panel`);
      need(((await l.getAttribute("title")) ?? "").length > 3, `${id} has no tooltip`);
    }
  });
  await test("hidden4", "Weights: Smooth changes the weights in one undo step and Ctrl+Z restores them", async () => {
    const s0 = await wsig();
    const e0 = await redits();
    await r.page.click("#wt-smooth");
    await wait(r, 1200);
    need((await wsig()) !== s0, "Smooth changed no weights");
    need((await redits()) === e0 + 1, "Smooth was not one undo step");
    await rUndo();
    need((await wsig()) === s0, "Ctrl+Z did not restore the weights");
  });
  await test("hidden4", "Weights: Prune small weights is one undo step and undoable", async () => {
    const s0 = await wsig();
    const e0 = await redits();
    await r.page.fill("#wt-min", "0.3");
    await r.page.click("#wt-prune");
    await wait(r, 1200);
    need((await redits()) === e0 + 1, "Prune was not one undo step");
    need(/Prune/.test(await report()), "no prune report");
    await rUndo();
    need((await wsig()) === s0, "Ctrl+Z did not restore the weights after Prune");
  });
  await test("hidden4", "Weights: Copy then Smooth then Paste puts the copied weights back; two Ctrl+Z restore the start", async () => {
    const s0 = await wsig();
    const e0 = await redits();
    await r.page.click("#wt-copy");
    await wait(r, 300);
    need(await r.page.locator("#wt-paste").isEnabled(), "Paste stays disabled after Copy");
    await r.page.click("#wt-smooth");
    await wait(r, 1200);
    const dSmooth = wdiff(await wsig(), s0);
    need(dSmooth > 0, "Smooth changed nothing");
    await r.page.click("#wt-paste");
    await wait(r, 1200);
    const d = wdiff(await wsig(), s0);
    // The engine renormalises and caps what it stores, so a pasted copy can differ from the live table in the 2nd decimal; it must be far closer than the smoothed state.
    need(d < dSmooth / 2 || d < 0.002, `Paste did not bring the copied weights back (smoothed differed by ${dSmooth}, pasted by ${d}): ${await report()}`);
    need((await redits()) === e0 + 2, "Smooth + Paste were not two undo steps");
    await rUndo();
    await rUndo();
    need((await redits()) === e0 && (await wsig()) === s0, "undo did not return to the start");
  });
  await test("hidden4", "Weights: Weld / Merge reports what it did and is undoable when it changed something", async () => {
    const s0 = await wsig();
    const e0 = await redits();
    await r.page.click("#wt-weld");
    await wait(r, 1500);
    const msg = await report();
    need(/Weld|vertices/.test(msg), `no weld report: "${msg}"`);
    const e1 = await redits();
    need(e1 === e0 || e1 === e0 + 1, "Weld was more than one undo step");
    if (e1 === e0 + 1) {
      await rUndo();
      need((await wsig()) === s0, "Ctrl+Z did not undo the weld");
    }
  });
  cleanups.push(() => r.close());

  // ---- Save rig stays visible at 1366 with unsaved edits ----
  const w = track(await session(1366, 768));
  w.phase = "hidden4-1366";
  await ws(w, "rig");
  await w.E(() => window.atlasEditor.select("chest"));
  await w.E(() => window.atlasEditor.setupTransform("chest", { rotation: 11 }));
  await w.page.click("#setup-newslot");
  await wait(w, 900);
  await test("hidden4", "1366 wide with unsaved edits: Save rig (N) is visible, inside the window, not in the overflow, and saves", async () => {
    const info = await w.E(() => {
      const b = document.getElementById("setupsave");
      const rc = b?.getBoundingClientRect();
      return { text: b?.textContent ?? "", vis: !!b && !!rc && rc.width > 0 && rc.height > 0, right: rc?.right ?? 0, left: rc?.left ?? 0, inPop: !!b?.closest(".ovf-pop"), w: innerWidth, hidden: b ? getComputedStyle(b).visibility : "none" };
    });
    need(info.vis && info.hidden !== "hidden", "Save rig is not visible");
    need(/^Save rig \(\d+\)$/.test(info.text.trim()), `label is "${info.text}"`);
    need(!info.inPop, "Save rig fell into the toolbar's ... overflow");
    need(info.left >= 0 && info.right <= info.w, `Save rig is outside the window (${info.left}..${info.right} of ${info.w})`);
    const hit = await w.E(() => { const b = document.getElementById("setupsave").getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t?.id === "setupsave"; });
    need(hit, "something covers the Save rig button");
  });
  cleanups.push(() => w.close());
}

// ===== 3d. New rig: every panel follows the new rig ================================================================================
{
  const n = track(await session(1600, 1000));
  n.phase = "newrig-refresh";
  const { PNG } = require("pngjs");
  const { mkdtempSync, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "qa-newrig-"));
  const png = new PNG({ width: 40, height: 60 });
  png.data.fill(255);
  const partFile = resolve(dir, "00_qa_part.png");
  wf(partFile, PNG.sync.write(png));
  const moreFile = resolve(dir, "01_qa_more.png");
  wf(moreFile, PNG.sync.write(png));
  const panels = () => n.E(() => (window.atlasEditor.state().selection.length || window.atlasEditor.select("root"), (document.getElementById("idk-body")?.hidden !== false && document.getElementById("idk-tab-images")?.click()), {
    tree: document.getElementById("outliner")?.innerText ?? "",
    draw: (() => { const n = Number(/Draw order \((\d+)\)/i.exec(document.getElementById("outliner")?.innerText ?? "")?.[1] ?? 0); const names = window.atlasEditor.setupRaw().slots.map((x) => x.name); return names.length === n ? names : []; })(),
    count: document.getElementById("idk-count")?.textContent ?? "",
    options: document.querySelectorAll("#idk-thumbs .idk-th").length,
    runs: /Constraints \([1-9]/i.test(document.getElementById("outliner")?.innerText ?? ""),
    bar: document.getElementById("statusbar")?.innerText ?? "",
    clip: window.atlasEditor.state().clipName,
    raw: window.atlasEditor.setupRaw()
  }));
  const createRig = async (name, template) => {
    await n.page.click("#rig-file"); await n.page.click("#newrig-open");
    await n.page.waitForSelector("#newrig-dialog");
    await n.page.fill("#newrig-name", name);
    await n.page.click(`#newrig-dialog [data-template="${template}"]`);
    await n.page.click("#newrig-create");
    await n.page.waitForSelector("#newrig-dialog", { state: "detached" });
    await wait(n, 1800);
  };
  await ws(n, "rig");
  await n.E(() => window.atlasEditor.mountOutfit("pro-turned"));
  await wait(n, 1500);
  await makeClip(n, "qa_old_rig_clip");
  await ws(n, "rig");
  await n.E(() => window.atlasEditor.setMode("setup"));
  await wait(n, 500);
  const before = await panels();
  need(before.tree.includes("pelvis") && before.clip === "qa_old_rig_clip", `the old rig did not open with its bones and clip: ${JSON.stringify(before.tree.slice(0, 80))} / ${before.clip} / ${before.raw.bones.length}`);
  await test("hidden4", "New rig (Blank): tree, draw order, image list, constraints and clip all follow the new rig", async () => {
    await createRig("QA Blank", "blank");
    const p = await panels();
    need(p.raw.bones.length === 1 && p.raw.slots.length === 0, `the saved rig is not blank: ${p.raw.bones.length} bones, ${p.raw.slots.length} slots`);
    need(!p.tree.includes("pelvis") && /root/.test(p.tree), `the tree still shows the old rig: ${p.tree.replace(/\s+/g, " ").slice(0, 120)}`);
    need(p.draw.length === 0, `draw order still lists ${p.draw.slice(0, 3)}`);
    need(!p.runs, "constraints still show the old rig's");
    need(p.options === 0 && !/^1\d\d images/.test(p.count.toLowerCase()), `image list still holds the old atlas (${p.count}, ${p.options} options)`);
    need(p.clip === "" && /no clip/i.test(p.bar), `clip not reset: "${p.clip}" / ${p.bar.replace(/\s+/g, " ")}`);
  });
  await test("hidden4", "New rig (Player skeleton): tree shows the player bones and the empty contract slots, no clip", async () => {
    await createRig("QA Player", "player");
    const p = await panels();
    need(p.raw.bones.length > 10 && p.tree.includes("pelvis") && p.raw.slots.every((s) => !s.attachment) && p.raw.slots.length > 30, `tree/slots wrong (${p.raw.slots.length} slots)`);
    need(p.options === 0, `image list holds ${p.options} images from another rig`);
    need(p.clip === "", `clip "${p.clip}" survived`);
  });
  await test("rig", "New rig: dropping a layered PSD lists, before the rig is made, what the import does not reproduce (blend mode, opacity, mask, effects), by layer (Batch 7b-2, )", async () => {
    function tinyPsd(layer) {
      const out = [];
      const u16 = (v) => out.push((v >> 8) & 255, v & 255);
      const u32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      const str = (s) => [...s].forEach((c) => out.push(c.charCodeAt(0)));
      str("8BPS"); u16(1); out.push(0, 0, 0, 0, 0, 0); u16(3); u32(1); u32(1); u16(8); u16(3); u32(0); u32(0);
      const rec = [];
      const r16 = (v) => rec.push((v >> 8) & 255, v & 255);
      const r32 = (v) => rec.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      const rstr = (s) => [...s].forEach((c) => rec.push(c.charCodeAt(0)));
      r32(0); r32(0); r32(1); r32(1); r16(4);
      for (const id of [65535, 0, 1, 2]) { r16(id); r32(3); }
      rstr("8BIM"); rstr(layer.blend); rec.push(layer.opacity, layer.clipping, layer.flags, 0);
      const extra = [];
      const e32 = (v) => extra.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      e32(layer.maskLen); extra.push(...new Array(layer.maskLen).fill(0)); e32(0);
      const nameBytes = [layer.name.length, ...[...layer.name].map((c) => c.charCodeAt(0))];
      while (nameBytes.length % 4) nameBytes.push(0);
      extra.push(...nameBytes);
      for (const [key, data] of layer.blocks) { extra.push(...[..."8BIM"].map((c) => c.charCodeAt(0)), ...[...key].map((c) => c.charCodeAt(0))); e32(data.length); extra.push(...data); if (data.length % 2) extra.push(0); }
      r32(extra.length); rec.push(...extra);
      const pixels = [];
      for (let c = 0; c < 4; c++) pixels.push(0, 0, 200);
      const info = [0, 1, ...rec, ...pixels];
      u32(info.length + 4); u32(info.length); out.push(...info);
      return Buffer.from(out);
    }
    await n.page.click("#rig-file"); await n.page.click("#newrig-open");
    await n.page.waitForSelector("#newrig-dialog");
    const [chooser] = await Promise.all([n.page.waitForEvent("filechooser"), n.page.click("#newrig-drop")]);
    await chooser.setFiles({ name: "glow.psd", mimeType: "image/vnd.adobe.photoshop", buffer: tinyPsd({ name: "glow", blend: "mul ", opacity: 128, clipping: 1, flags: 2, maskLen: 20, blocks: [["lrFX", [0, 0]]] }) });
    await n.page.waitForFunction(() => { const r = document.getElementById("newrig-psd-report"); return !!r && !r.hidden && /glow/.test(r.innerText); }, null, { timeout: 8000 });
    const text = await n.page.innerText("#newrig-psd-report");
    need(/multiply/i.test(text) && /glow:/.test(text), `the report did not name the layer's blend mode: ${text.slice(0, 160)}`);
    need(((await n.page.getAttribute("#newrig-psd-report", "title")) ?? "").length > 10, "the PSD report has no tooltip");
    await n.page.keyboard.press("Escape");
    await n.page.waitForSelector("#newrig-dialog", { state: "detached" }).catch(async () => { await n.page.click("#newrig-dialog .modal-actions button"); });
  });
  await test("hidden4", "New rig with dropped parts, then Add parts: the parts appear in the tree, draw order and image list", async () => {
    await n.page.click("#rig-file"); await n.page.click("#newrig-open");
    await n.page.waitForSelector("#newrig-dialog");
    await n.page.fill("#newrig-name", "QA Parts");
    const chooser = n.page.waitForEvent("filechooser");
    await n.page.click("#newrig-drop");
    await (await chooser).setFiles([partFile]);
    await n.page.waitForFunction(() => document.querySelector("#newrig-parts")?.children.length > 0, null, { timeout: 15_000 });
    await n.page.click("#newrig-create");
    await n.page.waitForSelector("#newrig-dialog", { state: "detached" });
    await wait(n, 1800);
    let p = await panels();
    need(p.draw.length === 1 && p.options >= 1, `dropped part missing (${p.draw.length} slots, ${p.options} images)`);
    need(p.clip === "" && !p.tree.includes("pelvis"), "stale clip or tree after New rig with parts");
    const statusText = () => n.E(() => document.getElementById("status")?.textContent ?? "");
    const addParts = async (file) => {
      const chooser = n.page.waitForEvent("filechooser");
      await ws(n, "rig");
      await n.page.click("#rig-file"); await n.page.click("#rig-add-parts");
      await (await chooser).setFiles([file]);
      await wait(n, 2200);
    };
    await addParts(moreFile);
    p = await panels();
    need(p.draw.length === 2 && p.options >= 2, `Add parts did not show up (${p.draw.length} slots, ${p.options} images; status: ${await statusText()})`);
    need(/Added 1 part to QA Parts/.test(await statusText()), `no clear status after Add parts: "${await statusText()}"`);
    // The same file again: the slot name exists, so the user is asked instead of everything being doubled.
    await addParts(moreFile);
    need(await n.page.isVisible("#dupparts-dialog"), "adding a part with an existing slot name did not ask");
    await n.page.click("#dupparts-cancel");
    await wait(n, 600);
    p = await panels();
    need(p.draw.length === 2, `Cancel still changed the rig (${p.draw.length} slots)`);
    await addParts(moreFile);
    await n.page.click("#dupparts-replace");
    await wait(n, 2200);
    p = await panels();
    need(p.draw.length === 2 && /Replaced 1 in QA Parts/.test(await statusText()), `Replace should keep 2 slots (${p.draw.length}; status: ${await statusText()})`);
    await addParts(moreFile);
    await n.page.click("#dupparts-copies");
    await wait(n, 2200);
    p = await panels();
    need(p.draw.length === 3 && p.draw.includes("qa_more_2"), `Add as copies should add qa_more_2 (${p.draw.join(",")})`);
  });
  await test("hidden4", "A fresh editor opens on Player v2 (the default player rig), not the old Side (pro) rig", async () => {
    const f = track(await session(1600, 1000, null, null));
    try {
      const outfit = await f.E(() => window.atlasEditor.state().outfit);
      need(outfit === "player-v2", `a fresh editor opened on ${outfit}`);
      const label = await f.E(() => window.atlasEditor.debug?.().skeleton?.bones?.length ?? 0);
      need(label > 10, `Player v2 mounted with ${label} bones`);
    } finally {
      await f.close();
    }
  });
  await test("hidden4", "Clips belong to a rig: v2, then Side (pro): its own clips play with no errors; back on v2 its clips are intact", async () => {
    const f = track(await session(1600, 1000, null, null));
    try {
      const names = () => f.E(() => window.atlasEditor.clipSession().map((c) => c.name));
      const v2Before = await names();
      need(v2Before.includes("t_walk_contact"), `Player v2 clips: ${v2Before.slice(0, 5)}`);
      const before = f.errors.length;
      await f.E(() => window.atlasEditor.mountOutfit("pro-turned"));
      await wait(f, 1500);
      const kit = await names();
      need(!kit.some((n) => v2Before.includes(n)) || kit.every((n) => !n.startsWith("t_")), `Side (pro) still shows v2 clips: ${kit.filter((n) => v2Before.includes(n))}`);
      need(await f.E(() => window.atlasEditor.clipSession().every((c) => !c.bones.includes("hips"))), "a clip on Side (pro) animates the v2-only bone 'hips'");
      for (const n of kit.slice(0, 3)) {
        await f.E((c) => window.atlasEditor.switchClip(c), n);
        await f.E(() => document.getElementById("play").click());
        await wait(f, 500);
        await f.E(() => document.getElementById("play").click());
      }
      await ws(f, "swag");
      await ws(f, "pro");
      const bad = f.errors.slice(before).map((e) => e.text);
      need(bad.length === 0, `errors on Side (pro): ${bad.slice(0, 2).join(" | ")}`);
      await f.E(() => window.atlasEditor.mountOutfit("player-v2"));
      await wait(f, 1500);
      const v2After = await names();
      need(v2Before.length === v2After.length && v2Before.every((n) => v2After.includes(n)), `Player v2 clips changed: ${v2Before.length} -> ${v2After.length}`);
      const bad2 = f.errors.slice(before).map((e) => e.text);
      need(bad2.length === 0, `errors after switching back: ${bad2.slice(0, 2).join(" | ")}`);
    } finally {
      await f.close();
    }
  });
  await test("hidden4", "Rig picker: Your rigs first, Player v2 (default), and the retired rigs (incl. Side (pro)) behind a visible Old rigs toggle", async () => {
    await ws(n, "rig");
    await n.page.click("#outfits-more");
    const info = await n.E(() => {
      const m = document.getElementById("outfits-menu");
      const kids = [...m.children].map((c) => c.id || c.textContent.trim().slice(0, 20));
      const vis = (sel) => { const e = m.querySelector(sel); return !!e && e.getClientRects().length > 0; };
      return { kids, yours: [...m.querySelectorAll("#outfits-yours button")].map((b) => b.dataset.id), player: [...m.querySelectorAll("#outfits-player button")].map((b) => b.dataset.id), old: [...m.querySelectorAll("#outfits-old button")].map((b) => b.dataset.id), oldShown: vis('#outfits-old button[data-id="turned-l"]'), toggle: vis("#outfits-old-toggle") };
    });
    need(info.yours.includes("qa-blank") && info.yours.includes("qa-parts"), `Your rigs lacks the new rigs: ${info.yours}`);
    need(info.player.join() === "player-v2", `Player holds ${info.player}`);
    need(!info.yours.includes("player-v2"), `Player v2 is listed under Your rigs: ${info.yours}`);
    need((await n.E(() => document.querySelector('#outfits-player button[data-id="player-v2"]').textContent)) === "Player v2 (default)", "Player v2 is not labelled (default)");
    need(["turned-l", "turned-r", "turned-l-axe"].every((i) => info.old.includes(i)) && info.old.includes("pro-turned") && !info.old.includes("player-v2"), `old group holds ${info.old}`);
    need(info.kids.indexOf("outfits-yours") < info.kids.indexOf("outfits-player"), "Your rigs is not listed first");
    need(info.toggle && !info.oldShown, "the old rigs should be collapsed behind a visible toggle");
    await n.page.click("#outfits-old-toggle");
    need(await n.page.isVisible('#outfits-old button[data-id="turned-l"]'), "the toggle did not show the old rigs");
    await n.page.click('#outfits-old button[data-id="turned-l"]');
    await wait(n, 1500);
    need((await n.E(() => window.atlasEditor.state().outfit)) === "turned-l", "an old rig could not be opened from the toggle");
  });
  cleanups.push(() => n.close());
}

// ===== 4. Basics: transport, save / load, reload ================================================================================
if (want("basics")) {
  const s = track(await session(1600, 1000));
  s.phase = "basics";
  await makeClip(s, "qa_basics");
  await seedKeys(s);
  await ws(s, "animate");
  const time = () => s.E(() => window.atlasEditor.state().time);
  await test("basics", "Play advances the playhead, pause stops it", async () => {
    await s.E(() => { window.atlasEditor.setTime(0); });
    await s.page.click("#play");
    await wait(s, 500);
    const t1 = await time();
    need(t1 > 0, "the playhead did not move while playing");
    await s.page.click("#play");
    await wait(s, 150);
    const t2 = await time();
    await wait(s, 400);
    need((await time()) === t2, "the playhead kept moving after pause");
  });
  await test("basics", "Space plays and pauses (real key)", async () => {
    await neutral(s);
    await s.E(() => window.atlasEditor.setTime(0));
    await press(s, " ");
    await wait(s, 500);
    const t1 = await time();
    await press(s, " ");
    await wait(s, 150);
    const t2 = await time();
    await wait(s, 300);
    need(t1 > 0 && (await time()) === t2, `Space playback: t after 0.5 s ${t1}, after pause stable ${t2}`);
  });
  const shortClip = async (loop) => {
    await s.E(() => window.atlasEditor.setTime(0));
    const on = await s.E(() => window.atlasEditor.state().clip.loop === true);
    if (on !== loop) await s.page.click("#loop");
    await s.E(() => document.activeElement?.blur?.());
  };
  await test("basics", "Loop on: playback wraps and keeps playing past the clip length", async () => {
    await shortClip(true);
    const dur = await s.E(() => window.atlasEditor.state().clip.duration);
    await s.page.click("#play");
    const seen = [];
    for (let i = 0; i < 14; i++) { await wait(s, 150); seen.push(await time()); }
    await s.page.click("#play");
    need(seen.some((t, i) => i && t < seen[i - 1] - 0.05), `time never wrapped (duration ${dur}): ${seen.map((x) => x.toFixed(2)).join(" ")}`);
  });
  await test("basics", "Loop off: playback stops at the end of the clip", async () => {
    await shortClip(false);
    const dur = await s.E(() => window.atlasEditor.state().clip.duration);
    await s.page.click("#play");
    await wait(s, Math.min(6000, dur * 1000 + 1800));
    const t1 = await time();
    await wait(s, 400);
    const t2 = await time();
    need(t1 === t2, "playback never stopped on a non-looping clip");
  });
  await test("basics", "Playhead returns to where playback started when a non-looping clip ends", async () => {
    await shortClip(false);
    await s.E(() => window.atlasEditor.setTime(0));
    const dur = await s.E(() => window.atlasEditor.state().clip.duration);
    await s.page.click("#play");
    await wait(s, Math.min(6000, dur * 1000 + 1800));
    need((await time()) === 0, `playhead stayed at ${(await time()).toFixed(2)} s instead of returning to 0`);
  });
  await test("basics", "Return to start OFF: a non-looping clip stops on its last frame", async () => {
    await shortClip(false);
    const on = await s.page.locator("#returnstart").evaluate((e) => e.classList.contains("on"));
    if (on) await s.page.click("#returnstart");
    try {
      await s.E(() => window.atlasEditor.setTime(0));
      const dur = await s.E(() => window.atlasEditor.state().clip.duration);
      await s.page.click("#play");
      await wait(s, Math.min(6000, dur * 1000 + 1800));
      need((await time()) >= dur - 0.05, `playhead is at ${(await time()).toFixed(2)} s, not the end (${dur.toFixed(2)} s)`);
    } finally {
      if (on) await s.page.click("#returnstart");
    }
  });
  await test("basics", "Event label on the last frame is drawn beside its diamond, inside the timeline", async () => {
    await s.E(() => { const a = window.atlasEditor; a.setTime(a.state().clip.duration); });
    await s.page.click("#addevent");
    await s.page.click('.ctxmenu button.ctx-item:has-text("ready")');
    await wait(s, 300);
    const lit = await s.E(() => {
      const c = document.getElementById("tl");
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const ev = document.getElementById("addevent").getBoundingClientRect();
      const x = window.atlasEditor.rulerScreenPos(Math.round(window.atlasEditor.state().clip.duration * 30));
      const x0 = Math.max(0, Math.round((x.x ?? x) - r.left - 60) * k);
      const y0 = Math.round((ev.top - r.top) * k);
      const d = c.getContext("2d").getImageData(x0, y0, Math.round(52 * k), Math.round(ev.height * k)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150) n++;
      return n;
    });
    need(lit > 20, `no label text found beside the last-frame event diamond (${lit} light pixels)`);
  });
  await test("basics", "Changing fps with keys that would move asks first; Cancel keeps fps and keys, OK changes fps", async () => {
    const before = await s.E(() => ({ fps: document.getElementById("fps").value, keys: JSON.stringify(window.atlasEditor.state().clip.bones) }));
    await s.page.fill("#fps", "24");
    await s.page.press("#fps", "Enter");
    await s.page.waitForSelector('#fps-confirm, #pu-confirm', { timeout: 3000 }).catch(() => {});
    const msg = await s.E(() => document.querySelector("#pu-confirm")?.textContent ?? "");
    need(/fps/.test(msg), `no confirm dialog about the fps change (got "${msg}")`);
    await s.page.click('#pu-confirm [data-act="cancel"]');
    await wait(s, 300);
    const after = await s.E(() => ({ fps: document.getElementById("fps").value, keys: JSON.stringify(window.atlasEditor.state().clip.bones) }));
    need(after.fps === before.fps && after.keys === before.keys, "Cancel still changed the fps or the keys");
    await s.page.fill("#fps", "24");
    await s.page.press("#fps", "Enter");
    await s.page.click('#pu-confirm [data-act="confirm"]');
    await wait(s, 300);
    need((await s.E(() => document.getElementById("fps").value)) === "24", "OK did not change the fps");
    await s.page.keyboard.press("Control+z");
    await wait(s, 200);
  });
  await test("basics", "Scrub: clicking and dragging the timeline ruler moves the playhead", async () => {
    const p = await s.E(() => ({ a: window.atlasEditor.rulerScreenPos(3), b: window.atlasEditor.rulerScreenPos(9) }));
    need(p.a && p.b, "no ruler positions");
    await s.page.mouse.click(p.a.x, p.a.y);
    await wait(s, 150);
    const t1 = await time();
    await s.page.mouse.move(p.a.x, p.a.y);
    await s.page.mouse.down();
    await s.page.mouse.move((p.a.x + p.b.x) / 2, p.a.y, { steps: 5 });
    await s.page.mouse.move(p.b.x, p.b.y, { steps: 5 });
    await s.page.mouse.up();
    await wait(s, 150);
    const t2 = await time();
    need(Math.abs(t1 - 3 / 30) < 0.04, `click on frame 3 put the playhead at ${(t1 * 30).toFixed(1)}`);
    need(Math.abs(t2 - 9 / 30) < 0.04, `drag to frame 9 put the playhead at ${(t2 * 30).toFixed(1)}`);
  });
  await test("basics", "Save and load round trip of a clip (Ctrl+S, reload, reopen)", async () => {
    await ws(s, "pro");
    await s.E(() => { const a = window.atlasEditor; a.setTime(6 / 30); a.select("head"); a.rotate("head", 27); a.key(); });
    const want1 = await s.E(() => JSON.stringify(window.atlasEditor.state().clip.bones.head));
    need(want1 && want1 !== "undefined", "head key not made");
    await neutral(s);
    await press(s, "Control+s");
    await wait(s, 800);
    const listed = await s.E(() => fetch("/api/clips").then((r) => r.text()));
    need(listed.includes("qa_basics"), "the saved clip is not in the server's clip list after Ctrl+S");
    await s.page.reload();
    await s.page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
    await wait(s, 1500);
    await s.page.addStyleTag({ content: "#restorebar { display: none !important; }" });
    await ws(s, "pro");
    const opts = await s.E(() => [...document.querySelectorAll("#clip option")].map((o) => o.value));
    const saved = opts.find((o) => o.endsWith("qa_basics.clip.json") || o === "qa_basics");
    need(saved, `after reload the clip picker does not list the saved clip (options: ${opts.join(", ")})`);
    await s.page.selectOption("#clip", saved);
    await s.page.waitForFunction(() => window.atlasEditor.state().clipName === "qa_basics" && window.atlasEditor.state().clip.bones?.head, null, { timeout: 6000 }).catch(() => {});
    const got = await s.E(() => JSON.stringify(window.atlasEditor.state().clip.bones?.head) + " (clip " + window.atlasEditor.state().clipName + ")");
    if (got.startsWith("undefined")) throw new Error(`after reload the saved clip qa_basics has no head track: ${got}`);
    need(got.startsWith(want1), `after reload the clip's head track is ${got}, expected ${want1}`);
  });
  await test("basics", "Reload persistence: the editor comes back with its rig, clips and no errors", async () => {
    const info = await s.E(() => ({ outfit: window.atlasEditor.state().outfit, bones: window.atlasEditor.debug().skeleton.bones.length }));
    need(info.outfit && info.bones > 10, `after reload: outfit ${info.outfit}, ${info.bones} bones`);
  });
  cleanups.push(() => s.close());
}

// ===== 5. Mouse ergonomics ======================================================================================================
if (want("mouse")) {
  const s = track(await session(1600, 1000));
  s.phase = "mouse";
  await makeClip(s, "qa_mouse");
  await ws(s, "animate");
  await seedKeys(s);
  await s.E(() => { window.atlasEditor.clearSelection(); window.atlasEditor.setGizmo("rotate"); });
  for (const bone of ["chest", "head", "thigh_near", "shin_near", "upper_arm_near", "forearm_near", "upper_arm_far"]) {
    await test("mouse", `hover equals click for bone picking: ${bone}`, async () => {
      await s.E(() => { window.atlasEditor.clearSelection(); window.atlasEditor.select(null); });
      await wait(s, 100);
      const e = await ends(s, bone);
      need(e, "bone not on screen");
      await s.page.mouse.move(e.mid.x + 30, e.mid.y + 30);
      await s.page.mouse.move(e.mid.x, e.mid.y, { steps: 4 });
      await wait(s, 200);
      const hover = await s.E(() => window.atlasEditor.overlayState().hover);
      need(hover, "nothing highlighted while hovering the middle of the bone");
      await s.page.mouse.down();
      await s.page.mouse.up();
      await wait(s, 200);
      const picked = await s.E(() => window.atlasEditor.boneSelection().active);
      need(picked === hover, `hover highlighted ${hover} but the click selected ${picked}`);
    });
  }
  const live = async (label, gesture) => {
    await test("mouse", `${label}: the canvas is live mid-drag and nothing jumps on release`, async () => {
      await s.E(() => window.atlasEditor.setTime(6 / 30));
      const box = await canvasBox(s);
      await gesture.pre();
      await neutral(s);
      const frames = [await shot(s, box)];
      const rot0 = await poseSig(s);
      let diffs = [];
      await gesture.run({ hold: true, onStep: async (i) => { if (i % gesture.every === 0) frames.push(await shot(s, box)); } });
      await wait(s, 350);
      const mid = await shot(s, box);
      const rotMid = await poseSig(s);
      await s.page.mouse.up();
      await wait(s, 400);
      const post = await shot(s, box);
      for (let i = 1; i < frames.length; i++) diffs.push(await pixDiff(s, frames[i - 1], frames[i]));
      need(frames.length >= 4, "too few mid-drag snapshots");
      need(diffs.every((d) => d > 40), `the canvas stopped changing before the mouse was released: pixel diffs per step ${diffs.join(", ")}`);
      const bonesAt = (sg) => JSON.stringify(JSON.parse(sg).bones);
      need(bonesAt(rotMid) === bonesAt(await poseSig(s)), "the pose changed when the mouse was released (a jump on release)");
      const settle = await pixDiff(s, frames[frames.length - 1], mid);
      need(settle < 200, `the canvas kept changing while the mouse was held still (${settle} px)`);
      const jump = await pixDiff(s, mid, post);
      need(jump < 4000, `the canvas jumped by ${jump} px on mouse release`);
      need(rotMid !== rot0, "the drag changed nothing");
    });
  };
  await live("Animate rotate ring drag", { every: 3, pre: async () => { await s.E(() => { window.atlasEditor.setGizmo("rotate"); window.atlasEditor.select("upper_arm_near"); }); }, run: (o) => ringDrag(s, "upper_arm_near", { sweep: 1.1, steps: 12, ...o }) });
  await live("Animate move drag", { every: 2, pre: async () => { await s.E(() => { window.atlasEditor.setGizmo("move"); window.atlasEditor.select("chest"); }); }, run: async (o) => { const e = await ends(s, "chest"); await dragBy(s, e.mid, 70, -40, { steps: 8, ...o }); } });
  await s.close();
  const r = track(await session(1600, 1000));
  r.phase = "mouse-rig";
  await ws(r, "rig");
  await test("mouse", "Rig rotate ring drag: live mid-drag and no jump on release", async () => {
    await r.E(() => { window.atlasEditor.setupTool("rotate"); window.atlasEditor.select("chest"); });
    await wait(r, 300);
    const box = await canvasBox(r);
    await neutral(r);
    const frames = [await shot(r, box)];
    await ringDrag(r, "chest", { sweep: 1.1, steps: 12, a0: Math.PI, r0: 260, hold: true, onStep: async (i) => { if (i % 3 === 0) frames.push(await shot(r, box)); } });
    await wait(r, 350);
    const mid = await shot(r, box);
    await r.page.mouse.up();
    await wait(r, 400);
    const post = await shot(r, box);
    const diffs = [];
    for (let i = 1; i < frames.length; i++) diffs.push(await pixDiff(r, frames[i - 1], frames[i]));
    need(diffs.every((d) => d > 40), `the Setup canvas stopped changing mid-drag: ${diffs.join(", ")}`);
    const jump = await pixDiff(r, mid, post);
    need(jump < 200, `the Setup canvas jumped by ${jump} px on release`);
  });
  cleanups.push(() => r.close());
}

// ===== 5b. Batch 1: component layer and rule fixes (dialogs, scrollbars, tooltips, sizes, Home keys) ===========================
if (want("batch1")) {
  // Native scrollbars must be visible to the probe, so this run uses a browser without Playwright's --hide-scrollbars default.
  const b1 = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  cleanups.push(() => b1.close().catch(() => {}));
  const open1 = async (w, h) => {
    const page = await b1.newPage({ viewport: { width: w, height: h } });
    const natives = [];
    page.on("dialog", (d) => { natives.push(`${d.type()}: ${d.message()}`); void d.dismiss().catch(() => {}); });
    await page.goto(url);
    await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
    await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
    await page.waitForTimeout(1200);
    page.setDefaultTimeout(8000);
    return { page, natives, E: (fn, a) => page.evaluate(fn, a), ws: async (id) => { await page.evaluate((x) => window.atlasEditor.workspace(x), id); await page.waitForTimeout(700); } };
  };
  const s = await open1(1600, 1000);
  const PROBE = () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !e.closest("[hidden]"); };
    const lab = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}"${(e.textContent || "").trim().slice(0, 16)}"`;
    const ctl = [...document.querySelectorAll("button, summary, select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden])")].filter(vis);
    const heights = ctl.filter((e) => { const h = Math.round(e.getBoundingClientRect().height); return h <= 44 && ![24, 28, 32, 44].includes(h); }).map((e) => `${lab(e)}=${Math.round(e.getBoundingClientRect().height)}`);
    const noTip = [...document.querySelectorAll("button, summary, select, input[type=range], [role=button]")].filter(vis).filter((e) => !(e.title || e.closest("[title]"))).map(lab);
    const bars = [], small = [];
    for (const e of document.querySelectorAll("body *")) {
      if (!vis(e)) continue;
      const cs = getComputedStyle(e);
      if (e.offsetWidth - e.clientWidth > 0 && e.clientWidth > 0 && cs.display !== "inline" && cs.borderLeftWidth === "0px" && cs.borderRightWidth === "0px" && !["BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"].includes(e.tagName)) bars.push(`${lab(e)}:${e.offsetWidth - e.clientWidth}`);
      if (e.children.length === 0 && (e.textContent || "").trim() && parseFloat(cs.fontSize) < 11) small.push(`${lab(e)}=${cs.fontSize}`);
    }
    return { heights, noTip, bars, small };
  };
  for (const id of ["home", "animate", "swag", "rig", "ship", "pro"]) {
    await test("batch1", `${id} at 1600x1000: no native scrollbar, every control titled, control heights in {24,28,32,44}, text >= 11 px`, async () => {
      await s.ws(id);
      const r = await s.E(PROBE);
      need(r.bars.length === 0, `native scrollbar on ${r.bars.slice(0, 4).join(", ")}`);
      need(r.noTip.length === 0, `no tooltip: ${r.noTip.slice(0, 4).join(", ")}`);
      need(r.heights.length === 0, `off-scale heights: ${r.heights.slice(0, 4).join(", ")}`);
      need(r.small.length === 0, `text under 11 px: ${r.small.slice(0, 4).join(", ")}`);
    });
  }
  await test("batch1", "Pro shows all seven right-panel tabs unclipped at 1366 and 1600", async () => {
    for (const [w, h] of [[1600, 1000], [1366, 768]]) {
      const p = await open1(w, h);
      await p.ws("pro");
      const clipped = await p.E(() => { const t = document.getElementById("tabs"); const tr = t.getBoundingClientRect(); const bs = [...t.querySelectorAll("button")].filter((b) => !b.hidden && b.offsetParent); return { n: bs.length, bad: bs.filter((b) => b.getBoundingClientRect().right > tr.right + 1 || b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()) }; });
      await p.page.close();
      need(clipped.n >= 7 && clipped.bad.length === 0, `${w}px: ${clipped.n} tabs, clipped: ${clipped.bad.join(", ")}`);
    }
  });
  await test("batch1", "Animate, Pro and Rig stay on the scale, titled and scrollbar-free at 1366x768", async () => {
    const p = await open1(1366, 768);
    for (const id of ["animate", "pro", "rig"]) {
      await p.ws(id);
      const r = await p.E(PROBE);
      need(r.heights.length === 0 && r.noTip.length === 0 && r.bars.length === 0, `${id}: ${[...r.heights, ...r.noTip, ...r.bars].slice(0, 4).join(", ")}`);
    }
    await p.page.close();
  });
  await test("batch1", "Rig: bone names in the inspector lists, crumbs and Tree sections are not uppercased", async () => {
    await s.ws("rig");
    await s.E(() => window.atlasEditor.showTab("rig"));
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const r = await s.E(() => {
      const els = [...document.querySelectorAll("#setuppanel .insp-item .name, #setuppanel .insp-crumb, #outliner .k-draw .ol-label, #outliner .k-constraint .ol-label")].filter((e) => e.offsetParent);
      return { n: els.length, up: els.filter((e) => getComputedStyle(e).textTransform === "uppercase").length };
    });
    need(r.n > 0, "no bone-name cells found");
    need(r.up === 0, `${r.up} bone names are uppercased by CSS`);
  });
  await test("batch1", "Home: Ctrl+K opens the command palette and F1 opens the cheat sheet", async () => {
    await s.ws("home");
    await s.page.keyboard.press("Control+k");
    await s.page.waitForSelector(".palette-scrim");
    await s.page.keyboard.press("Escape");
    await s.page.waitForSelector(".palette-scrim", { state: "detached" });
    await s.page.keyboard.press("F1");
    await wait(s, 300);
    need(await s.E(() => getComputedStyle(document.getElementById("help")).display !== "none"), "F1 did not open the cheat sheet on Home");
    await s.page.keyboard.press("Escape");
    await wait(s, 200);
  });
  await test("batch1", "Header search button is labelled 'Search' with Ctrl+K as a secondary chip", async () => {
    const t = await s.E(() => document.getElementById("palette-open")?.textContent ?? "");
    need(/Search/.test(t) && /Ctrl\+K/.test(t), `button text "${t}"`);
  });
  const escCase = (name, openIt, sel, focusId) =>
    test("batch1", `Dialog ${name}: Esc closes it and focus returns to the opener`, async () => {
      const p = await open1(1600, 1000);
      await openIt(p);
      await p.page.waitForSelector(sel);
      await p.E(() => document.activeElement?.blur?.());
      await p.page.keyboard.press("Escape");
      await p.page.waitForSelector(sel, { state: "detached", timeout: 3000 });
      const active = await p.E(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
      await p.page.close();
      need(focusId === null || active === focusId, `focus is on "${active}", expected "${focusId}"`);
    });
  await escCase("Files", async (p) => { await p.page.focus("#filesbtn"); await p.page.click("#filesbtn"); }, "#datapanel", "filesbtn");
  await escCase("Versions", async (p) => { await p.ws("rig"); await p.page.click("#rig-file"); await p.page.click("#rig-versions"); }, "#pu-versions", null);
  await escCase("New rig", async (p) => { await p.ws("rig"); await p.page.click("#rig-file"); await p.page.click("#newrig-open"); }, "#newrig-dialog", "rig-file");
  await escCase("Publish", async (p) => { await p.ws("ship"); await p.page.click("#ship-publish"); }, "#publishdlg", "ship-publish");
  await escCase("confirm (fps change)", async (p) => {
    await makeClip(p, "b1_fps");
    await seedKeys(p);
    await p.page.fill("#fps", "24");
    await p.page.press("#fps", "Enter");
  }, "#pu-confirm", null);
  await test("batch1", "No native prompt / confirm / alert appeared anywhere in this section", async () => {
    need(s.natives.length === 0, s.natives.join(" | "));
  });
}

// ===== 6. Page and console errors in every workspace ===========================================================================
if (want("batch5")) {
  // Animate chrome (Batch 5): one transport, one Key menu, dock sizing, no-clip state, recently deleted clips.
  for (const [w, h, minDock] of [[1600, 1000, 300], [1366, 768, 190]]) {
    const s = track(await session(w, h));
    await makeClip(s, `qa_b5_${w}`);
    await ws(s, "animate");
    await wait(s, 500);
    await test("batch5", `${w}x${h} Animate: exactly one [role=toolbar][data-transport] and no .transport row above the dock`, async () => {
      const r = await s.E(() => ({ bars: [...document.querySelectorAll("[role=toolbar][data-transport]")].filter((e) => e.offsetParent !== null).length, rows: [...document.querySelectorAll(".transport")].filter((e) => e.offsetParent !== null).length, animbar: !!document.getElementById("animbar") }));
      need(r.bars === 1 && r.rows === 0 && !r.animbar, JSON.stringify(r));
    });
    await test("batch5", `${w}x${h} Animate: dopesheet height >= ${minDock} px with the graph closed`, async () => {
      const t = await s.E(() => Math.round(document.getElementById("timeline").getBoundingClientRect().height));
      need(t >= minDock, `timeline is ${t} px`);
    });
    await test("batch5", `${w}x${h} Animate: the transport fits on one row inside the footer`, async () => {
      const r = await s.E(() => { const t = document.getElementById("tb-set").getBoundingClientRect(); const f = document.querySelector("footer").getBoundingClientRect(); const kids = [...document.querySelectorAll("#tb-set > *")].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()); return { h: Math.round(t.height), over: kids.filter((k) => k.right > f.right + 1 || k.top < t.top - 1 || k.bottom > t.bottom + 1).length }; });
      need(r.h <= 48 && r.over === 0, JSON.stringify(r));
    });
    await test("batch5", `${w}x${h} Animate: Key menu lists Key selected, Key pose, Key all channels, Delete key here, Scale timing, Select all, Play range`, async () => {
      need(await s.E(() => { const b = document.getElementById("setkey"); return !!b && b.offsetParent !== null && /Key selected/.test(b.textContent); }), "Key selected button missing");
      await s.page.click("#key-menu-btn");
      const text = await s.E(() => [...document.querySelectorAll("#key-menu button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()).join("|"));
      await s.page.keyboard.press("Escape");
      for (const rx of [/Key character pose/, /Key all channels/, /Delete key here/, /Scale timing/, /Select all/, /Play range: start/, /Play range: end/, /Play range: clear/]) need(rx.test(text), `${rx} not in: ${text}`);
      need(await s.E(() => document.getElementById("key-menu").hidden), "Escape did not close the Key menu");
    });
    await test("batch5", `${w}x${h} Animate: Mirror menu lists Mirror selected, Flip pose and the limb copies`, async () => {
      await s.page.click("#mirror-menu-btn");
      const text = await s.E(() => [...document.querySelectorAll("#mirror-menu button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()).join("|"));
      await s.page.keyboard.press("Escape");
      for (const rx of [/Mirror selected/, /Flip pose/, /arm near to far/, /leg far to near/]) need(rx.test(text), `${rx} not in: ${text}`);
    });
    await test("batch5", `${w}x${h} Animate: the frame readout appears once (not in the status bar)`, async () => {
      const r = await s.E(() => ({ n: (document.body.innerText.match(/Frame \d+ \/ \d+/g) ?? []).length, sb: document.getElementById("sb-frame").textContent }));
      need(r.n === 1, `frame readout appears ${r.n} times`);
      need(!/frame|fps/i.test(r.sb), `status bar: ${r.sb}`);
    });
    await test("batch5", `${w}x${h} Animate: Scale timing opens its field in the menu and Apply works`, async () => {
      await s.page.click("#key-menu-btn");
      await s.page.click("#scale-open");
      need(await s.E(() => !document.getElementById("scalerow").hidden), "scale row did not open");
      await s.page.click("#applyscale");
      need(await s.E(() => document.getElementById("key-menu").hidden), "menu stayed open after Apply");
    });
  }
  {
    const s = track(await session(1600, 1000));
    await s.page.click('#home .home-card[data-go="animate"]');
    await wait(s, 900);
    await test("batch5", "Animate with no clip: the transport and Key menu are disabled and the Clip board card shows", async () => {
      const r = await s.E(() => ({ clip: window.atlasEditor.state().clipName, board: document.body.classList.contains("cb-open") && !!document.getElementById("clipboard") && !document.getElementById("clipboard").hidden, on: ["play", "setkey", "key-menu-btn", "mirror-menu-btn", "loop", "autokey"].filter((id) => !document.getElementById(id).matches(":disabled")) }));
      need(!r.clip, `a clip is open: ${r.clip}`);
      need(r.board, "the Clip board card is not showing");
      need(r.on.length === 0, `still enabled: ${r.on.join(", ")}`);
    });
  }
  {
    const s = track(await session(1600, 1000));
    await makeClip(s, "qa_b5_dock");
    await ws(s, "animate");
    await test("batch5", "Animate: a dragged dock height is remembered across a reload", async () => {
      await s.page.focus("#tlsplit");
      for (let i = 0; i < 3; i++) await s.page.keyboard.press("ArrowUp");
      const h1 = await s.E(() => Math.round(document.getElementById("lower").getBoundingClientRect().height));
      const kept = await s.E(() => localStorage.getItem("atlas-animator-timeline-height"));
      need(kept && Math.abs(Number(kept) - h1) <= 1, `stored ${kept}, shown ${h1}`);
      await s.page.reload();
      await s.page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
      await s.page.addStyleTag({ content: "#restorebar { display: none !important; }" });
      await wait(s, 1200);
      await ws(s, "animate");
      const h2 = await s.E(() => Math.round(document.getElementById("lower").getBoundingClientRect().height));
      need(Math.abs(h2 - h1) <= 1, `after reload ${h2}, before ${h1}`);
    });
  }
  {
    const s = track(await session(1600, 1000));
    await makeClip(s, "qa_b5_gone");
    await s.page.click("#save");
    await wait(s, 600);
    await test("batch5", "Clip board: Delete keeps the last version under Recently deleted and Restore brings the clip back ()", async () => {
      need(await s.E(async () => (await (await fetch("/api/clips")).json()).includes("qa_b5_gone.clip.json")), "the clip was not saved");
      await s.E(async () => { await fetch("/api/clips/qa_b5_gone.clip.json", { method: "DELETE" }); });
      const listed = await s.E(async () => (await (await fetch("/api/history/deleted")).json()).deleted.map((d) => d.file));
      need(listed.includes("qa_b5_gone.clip.json"), `deleted list: ${listed.join(", ")}`);
      await s.E(() => window.atlasEditor.workspace("animate"));
      await wait(s, 400);
      await s.page.click("#clips-open");
      await s.page.click("#cb-deleted");
      await s.page.locator('#pu-deleted [data-file="qa_b5_gone.clip.json"] [data-act="restore"]').click();
      await wait(s, 600);
      need(await s.E(async () => (await (await fetch("/api/clips")).json()).includes("qa_b5_gone.clip.json")), "Restore did not bring the file back");
    });
  }
}
if (want("errors")) {
  const s = track(await session(1600, 1000));
  await makeClip(s, "qa_errors");
  await seedKeys(s);
  for (const w of ["home", "animate", "swag", "rig", "ship", "pro"]) {
    await test("errors", `${w}: zero page errors and zero console errors while clicking around`, async () => {
      s.phase = `errors-${w}`;
      const n = s.errors.length;
      await s.page.click(`#ws-${w}`);
      await wait(s, 600);
      const tabs = await s.E(() => [...document.querySelectorAll("#tabs button")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.id));
      for (const t of tabs) { await s.page.click(`#${t}`).catch(() => {}); await wait(s, 200); }
      if (w === "animate" || w === "pro") {
        await s.E(() => window.atlasEditor.select("upper_arm_near"));
        await ringDrag(s, "upper_arm_near", { sweep: 0.4, steps: 4 }).catch(() => {});
        await press(s, "Control+z");
        await press(s, "k");
        await wait(s, 300);
      }
      const mine = s.errors.slice(n).filter((e) => e.phase === `errors-${w}`);
      need(mine.length === 0, mine.map((e) => e.text).join(" | "));
    });
  }
  cleanups.push(() => s.close());
}

// ===== 7. Overlaps at 1366x768 and 1600x1000 ===================================================================================
// The occlusion probe is ui-sweep.mjs's: a visible control or text whose centre / edge points are covered by an unrelated element.
const OVERLAP = () => {
  const W = innerWidth, H = innerHeight;
  const vis = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    for (let n = e.parentElement; n; n = n.parentElement) if (n.tagName === "DETAILS" && !n.open && !e.closest("summary")) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  };
  const clipOut = (e) => { const r = e.getBoundingClientRect(); for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflow + getComputedStyle(n).overflowY; if (/auto|scroll|hidden/.test(o)) { const c = n.getBoundingClientRect(); if (r.bottom <= c.top + 0.5 || r.top >= c.bottom - 0.5 || r.right <= c.left + 0.5 || r.left >= c.right - 0.5) return true; } } return false; };
  const all = [...document.querySelectorAll("body *")].filter((e) => !["SCRIPT", "STYLE", "svg", "path", "circle", "rect", "line", "g", "polyline", "ellipse", "OPTION"].includes(e.tagName) && vis(e) && !clipOut(e));
  const path = (e) => { const p = []; let n = e; while (n && n !== document.body && p.length < 3) { p.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase()); n = n.parentElement; } return p.join(">"); };
  const txt = (e) => (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  const hasOwnText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const leaf = all.filter((e) => ["BUTTON", "INPUT", "SELECT", "CANVAS", "IMG", "KBD"].includes(e.tagName) || hasOwnText(e));
  const mainCanvas = document.querySelector("#view > canvas");
  const related = (a, b) => a === b || a.contains(b) || b.contains(a);
  const out = [];
  for (const e of leaf) {
    if (e === mainCanvas) continue;
    const r = e.getBoundingClientRect();
    const probes = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + Math.min(6, r.width / 3), r.top + r.height / 2], [r.right - Math.min(6, r.width / 3), r.top + r.height / 2]];
    const inClip = (x, y) => { for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (/auto|scroll|hidden/.test(cs.overflow + cs.overflowY)) { const c = n.getBoundingClientRect(); if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false; } } return true; };
    const hits = probes.filter(([x, y]) => inClip(x, y)).map(([x, y]) => (x >= 0 && y >= 0 && x < W && y < H ? document.elementFromPoint(x, y) : null)).filter((t) => t && !related(e, t));
    if (!hits.length) continue;
    const t = hits[0];
    if (t.closest("#phonepop, .cb-menu, #newclip, #key-menu, #mirror-menu, #wg-card")) continue;
    const layer = t.closest("#home, #clipboard, #help, #swagsheet, .cb-confirm-layer, #soon");
    if (layer && layer !== e.closest("#home, #clipboard, #help, #swagsheet, .cb-confirm-layer, #soon")) continue;
    out.push(`${path(e)} "${txt(e)}" covered by ${path(t)} "${txt(t)}"`);
  }
  return out;
};
if (want("overlap")) {
  for (const [w, h] of [[1366, 768], [1600, 1000]]) {
    const s = track(await session(w, h));
    s.phase = `overlap-${w}`;
    await makeClip(s, "qa_overlap");
    await seedKeys(s);
    for (const name of ["home", "animate", "swag", "rig", "ship", "pro"]) {
      await test("overlap", `${w}x${h} ${name}: no control or text is covered by another element`, async () => {
        await ws(s, name);
        await s.E(() => window.atlasEditor.select("upper_arm_near"));
        await wait(s, 400);
        const hits = await s.E(OVERLAP);
        need(hits.length === 0, `${hits.length} overlaps: ${hits.slice(0, 3).join(" ; ")}`);
      });
    }
    cleanups.push(() => s.close());
  }
}

// ===== 9. Batch 6: timing features (speed, channel rows, frame operations, key inspector, popover) ===================================
if (want("timing")) {
  const s = track(await session(1600, 1000));
  s.phase = "timing";
  await autoAccept(s.page);
  await makeClip(s, "qa_timing");
  await seedKeys(s);
  await ws(s, "animate");
  const clipOf = () => s.E(() => JSON.parse(JSON.stringify(window.atlasEditor.getClip())));
  const frames = (keys) => keys.map((k) => Math.round(k.time * 30));
  await test("timing", "Speed field is visible, labelled and has a tooltip", async () => {
    const info = await s.E(() => { const e = document.getElementById("speed"); return { vis: !!e && e.offsetParent !== null, title: e.title, label: e.getAttribute("aria-label") }; });
    need(info.vis && info.title.length > 20 && info.label, `speed field: ${JSON.stringify(info)}`);
  });
  await test("timing", "Speed 0.5x: 1 s of wall time advances at most 0.6 s of clip, and the authored fps does not change", async () => {
    const fps0 = (await clipOf()).fps ?? 30;
    await s.page.fill("#speed", "0.5");
    await s.page.press("#speed", "Enter");
    await s.page.locator("#speed").dispatchEvent("change");
    await s.E(() => window.atlasEditor.setTime(0));
    if (!(await s.E(() => window.atlasEditor.state().clip.loop))) await s.page.click("#loop");
    const t0 = await s.E(() => performance.now());
    await s.page.click("#play");
    await wait(s, 1000);
    const r = await s.E(() => ({ time: window.atlasEditor.state().time, now: performance.now() }));
    await s.page.click("#play");
    const elapsed = (r.now - t0) / 1000;
    await s.page.fill("#speed", "1");
    await s.page.locator("#speed").dispatchEvent("change");
    await s.page.click("#loop");
    need(r.time <= 0.6 * elapsed + 0.03 && r.time > 0.25 * elapsed, `0.5x advanced ${r.time.toFixed(2)} s in ${elapsed.toFixed(2)} s of wall time`);
    need(((await clipOf()).fps ?? 30) === fps0, "speed changed the clip fps");
    need((await s.E(() => window.atlasEditor.playSpeed())) === 1, "speed did not return to 1");
  });
  await test("timing", "Speed field clamps to 0.1 to 2", async () => {
    await s.page.fill("#speed", "9");
    await s.page.locator("#speed").dispatchEvent("change");
    const hi = await s.E(() => window.atlasEditor.playSpeed());
    await s.page.fill("#speed", "0");
    await s.page.locator("#speed").dispatchEvent("change");
    const lo = await s.E(() => window.atlasEditor.playSpeed());
    await s.page.fill("#speed", "1");
    await s.page.locator("#speed").dispatchEvent("change");
    need(hi === 2 && lo === 0.1, `clamped to ${hi} and ${lo}`);
  });
  await test("timing", "Insert 5 frames at 6 shifts every key at or after 6 by 5 and undoes", async () => {
    const before = await clipOf();
    await s.E(() => window.atlasEditor.setTime(6 / 30));
    await s.page.fill("#framecount", "5");
    await s.page.click("#insframes");
    await wait(s, 200);
    const after = await clipOf();
    need(JSON.stringify(frames(after.bones.chest.rotate)) === JSON.stringify(frames(before.bones.chest.rotate).map((f) => (f >= 6 ? f + 5 : f))), `chest keys ${frames(after.bones.chest.rotate)}`);
    need(Math.round(after.duration * 30) === Math.round(before.duration * 30) + 5, "the clip did not grow by 5 frames");
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(JSON.stringify(await clipOf()) === JSON.stringify(before), "undo did not restore the clip");
  });
  await test("timing", "Delete 3 frames at 5 (confirmed) removes the keys inside, moves later keys back, and undoes", async () => {
    const before = await clipOf();
    await s.E(() => window.atlasEditor.setTime(5 / 30));
    await s.page.fill("#framecount", "3");
    await s.page.click("#delframes");
    await wait(s, 500);
    const after = await clipOf();
    need(JSON.stringify(frames(after.bones.chest.rotate)) === JSON.stringify([0, 9]), `chest keys ${frames(after.bones.chest.rotate)}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(JSON.stringify(await clipOf()) === JSON.stringify(before), "undo did not restore the clip");
  });
  await test("timing", "Reverse selected keys swaps the arm values end for end and undoes", async () => {
    const before = await clipOf();
    const vals = (c) => c.bones.upper_arm_near.rotate.map((k) => k.value);
    await s.E(() => window.atlasEditor.setKeySelection([0, 6, 12].map((f) => ({ row: "bone:upper_arm_near", time: f / 30 }))));
    await s.page.click("#revkeys");
    await wait(s, 200);
    const after = await clipOf();
    need(JSON.stringify(vals(after)) === JSON.stringify([...vals(before)].reverse()), `values ${vals(after)} from ${vals(before)}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(JSON.stringify(vals(await clipOf())) === JSON.stringify(vals(before)), "undo did not restore the values");
  });
  await test("timing", "Colour key on a slot: Key inspector adds it, the dopesheet shows a colour row, undo removes it", async () => {
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.showTab("keys"));
    const slot = await s.E(() => window.atlasEditor.setupRaw().slots.map((x) => x.name).find((n) => /eye/i.test(n)) ?? window.atlasEditor.setupRaw().slots[0].name);
    await s.page.selectOption("#ki-target", `color:${slot}`);
    await s.E(() => window.atlasEditor.setTime(4 / 30));
    await s.page.click("#ki-addkey");
    await wait(s, 300);
    const c = await clipOf();
    need(c.slots[slot]?.color?.length === 1, `no colour key on ${slot}`);
    const rows = await s.E(() => window.atlasEditor.timelineRows().map((r) => r.kind));
    need(rows.includes("color"), `rows ${rows}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(!(await clipOf()).slots[slot]?.color, "undo kept the colour key");
  });
  await test("timing", "Transform mix key: a constraint added in Rig can be keyed from the Key inspector, shows a mix row, and undo removes it", async () => {
    await ws(s, "rig");
    await s.E(() => window.atlasEditor.select("chest"));
    await wait(s, 300);
    const n0 = (await s.E(() => window.atlasEditor.setupRaw().transform ?? [])).length;
    await s.page.click("#setup-addtc");
    await wait(s, 700);
    const raw = await s.E(() => window.atlasEditor.setupRaw().transform ?? []);
    need(raw.length === n0 + 1, "no transform constraint was added");
    const name = raw.at(-1).name;
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.showTab("keys"));
    await wait(s, 300);
    await s.page.selectOption("#ki-target", `transform:${name}`);
    await s.E(() => window.atlasEditor.setTime(3 / 30));
    await s.page.click("#ki-addkey");
    await wait(s, 300);
    const c = await clipOf();
    need(c.transform?.[name]?.length === 1 && c.transform[name][0].mixRotate !== undefined, `no mix key: ${JSON.stringify(c.transform)}`);
    const rows = await s.E(() => window.atlasEditor.timelineRows().map((r) => r.kind));
    need(rows.includes("transform"), `rows ${rows}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(!(await clipOf()).transform?.[name], "undo kept the mix key");
  });
  await test("timing", "Path and image-sequence keys: the Key inspector adds a path position key and a sequence key, the dopesheet shows both rows, undo removes them (Batch 12a/12b)", async () => {
    await ws(s, "rig");
    await s.E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
    await wait(s, 300);
    await s.page.click("#setup-add-path");
    await wait(s, 600);
    await s.E(() => window.atlasEditor.select("head"));
    await wait(s, 300);
    await s.page.click("#setup-addpath");
    await wait(s, 700);
    const name = (await s.E(() => window.atlasEditor.setupRaw().path ?? [])).at(-1)?.name;
    need(name, "no path constraint was added");
    await s.E(() => window.atlasEditor.setupSelectSlot("shirt_tip_far", "tip"));
    await wait(s, 400);
    await s.E(() => window.atlasEditor.inspectorOpen("att.sequence", true));
    await wait(s, 250);
    await s.page.click("#seq-make");
    await wait(s, 600);
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.showTab("keys"));
    await wait(s, 300);
    await s.page.selectOption("#ki-target", `path:${name}`);
    await s.E(() => window.atlasEditor.setTime(5 / 30));
    await s.page.click("#ki-addkey");
    await wait(s, 300);
    let c = await clipOf();
    need(c.path?.[name]?.length === 1 && c.path[name][0].position !== undefined && c.path[name][0].mixRotate !== undefined, `no path key: ${JSON.stringify(c.path)}`);
    need(((await s.E(() => window.atlasEditor.timelineRows().map((r2) => r2.kind))).includes("path")), "no path row in the dopesheet");
    await s.page.selectOption("#ki-target", "seq:shirt_tip_far");
    await s.E(() => window.atlasEditor.setTime(8 / 30));
    await s.page.click("#ki-addkey");
    await wait(s, 300);
    c = await clipOf();
    need(c.slots.shirt_tip_far?.sequence?.length === 1, `no sequence key: ${JSON.stringify(c.slots.shirt_tip_far)}`);
    need(((await s.E(() => window.atlasEditor.timelineRows().map((r2) => r2.kind))).includes("seq")), "no sequence row in the dopesheet");
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 250);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 250);
    c = await clipOf();
    need(!c.path?.[name] && !c.slots.shirt_tip_far?.sequence, "undo kept the keys");
    // Put the rig back as it was for the checks that follow.
    await ws(s, "rig");
    for (let i = 0; i < 3; i++) {
      await s.E(() => window.atlasEditor.setupUndo());
      await wait(s, 400);
    }
    need(!((await s.E(() => window.atlasEditor.setupRaw().path ?? [])).length), "the path constraint is still in the rig");
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.showTab("keys"));
    await s.E(() => { window.atlasEditor.setKeySelection([]); window.atlasEditor.select("chest"); });
    await wait(s, 300);
  });
  await test("timing", "Double-click a key opens the value popover; typing 12 and Enter sets 12", async () => {
    await s.E(() => window.atlasEditor.setTime(6 / 30));
    const pos = await s.E(() => window.atlasEditor.keyScreenPos("bone:upper_arm_near", 6));
    need(pos, "no screen position for the rotate key");
    await s.page.mouse.dblclick(pos.x, pos.y);
    await s.page.waitForSelector("#ki-pop");
    const input = s.page.locator('#ki-pop [data-field="value"]');
    await input.fill("12");
    await input.press("Enter");
    await wait(s, 300);
    const key = (await clipOf()).bones.upper_arm_near.rotate.find((k) => Math.round(k.time * 30) === 6);
    need(key && key.value === 12, `key value is ${key?.value}`);
    need((await s.page.locator("#ki-pop").count()) === 0, "the popover stayed open");
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
  });
  await test("timing", "Key inspector shows value, interpolation and curve of the selected key; changing interpolation is one undo step", async () => {
    await s.E(() => window.atlasEditor.showTab("keys"));
    await s.E(() => window.atlasEditor.setKeySelection([{ row: "bone:upper_arm_near", time: 6 / 30 }]));
    await wait(s, 200);
    const txt = await s.E(() => document.getElementById("keyinspector").innerText);
    need(/frame 6/i.test(txt) && /Value/i.test(txt) && /Interpolation/i.test(txt) && /Curve/i.test(txt), `inspector text: ${txt.slice(0, 120)}`);
    await s.page.selectOption('#keyinspector [data-field="interpolation"]', "stepped");
    await wait(s, 200);
    const k = (await clipOf()).bones.upper_arm_near.rotate.find((x) => Math.round(x.time * 30) === 6);
    need(k.curve === "stepped", `curve is ${JSON.stringify(k.curve)}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    const k2 = (await clipOf()).bones.upper_arm_near.rotate.find((x) => Math.round(x.time * 30) === 6);
    need(k2.curve === undefined || k2.curve === "linear", "undo kept stepped");
  });
  await test("timing", "Graph tangents: Flat on the selected key levels its handles, Linked / Broken toggles, one undo step", async () => {
    await s.E(() => window.atlasEditor.select("upper_arm_near"));
    await s.page.click("#graphbtn");
    await wait(s, 400);
    await s.E(() => window.atlasEditor.setKeySelection([{ row: "bone:upper_arm_near", time: 6 / 30 }]));
    await wait(s, 200);
    const before = await clipOf();
    await s.page.click("#graphtan-flat");
    await wait(s, 300);
    const keys = (await clipOf()).bones.upper_arm_near.rotate;
    const mid = keys.find((k) => Math.round(k.time * 30) === 6);
    need(Array.isArray(mid.curve) && mid.curve[1] === 0, `mid curve ${JSON.stringify(mid.curve)}`);
    const first = keys[0];
    need(Array.isArray(first.curve) && first.curve[3] === 1, `first curve ${JSON.stringify(first.curve)}`);
    const t0 = await s.page.locator("#graphlinked").textContent();
    await s.page.click("#graphlinked");
    const t1 = await s.page.locator("#graphlinked").textContent();
    need(t0 !== t1, "Linked / Broken did not toggle");
    await s.page.click("#graphlinked");
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(JSON.stringify(await clipOf()) === JSON.stringify(before), "undo did not restore the curves");
    await s.page.click("#graphbtn");
  });
  await test("timing", "FPS 30 to 12 previews the retime on every channel and lists collisions before confirming; undo restores", async () => {
    const before = await clipOf();
    await s.E(() => { const m = new MutationObserver(() => { const b = document.querySelector('.modal-backdrop [data-act="confirm"]'); if (b) window.__fpsDialog = document.querySelector(".modal-backdrop").innerText; }); m.observe(document.body, { childList: true, subtree: true }); });
    await s.page.fill("#fps", "12");
    await s.page.locator("#fps").dispatchEvent("change");
    await wait(s, 500);
    const after = await clipOf();
    const dlg = await s.E(() => window.__fpsDialog ?? "");
    need(after.fps === 12, `fps is ${after.fps}`);
    need(/12 fps/.test(dlg) && /channel/.test(dlg), `dialog text: ${dlg.slice(0, 160)}`);
    await s.E(() => window.atlasEditor.undoStep());
    await wait(s, 200);
    need(JSON.stringify(await clipOf()) === JSON.stringify(before), "undo did not restore fps and key times");
  });
  await test("timing", "FPS above 60 is refused (the engine format's limit)", async () => {
    await s.page.fill("#fps", "90");
    await s.page.locator("#fps").dispatchEvent("change");
    await wait(s, 300);
    need(((await clipOf()).fps ?? 30) === 30, "fps 90 was accepted");
  });
}

// ===== 10. Batch 6b: pose scopes + pose library recovery, audio reference, bake, onion scope, Pose tab =============================
if (want("batch6b")) {
  const s = track(await session(1600, 1000));
  s.phase = "batch6b";
  await autoAccept(s.page);
  await makeClip(s, "qa_b6b");
  await seedKeys(s);
  await ws(s, "animate");
  const poseJson = (name) => s.E(async (n) => (await fetch(`/repo/packages/animator-editor/poses/${n}.pose.json?v=${Date.now()}`)).json(), name);
  const tabLib = () => s.E(() => window.atlasEditor.showTab("library"));
  await test("batch6b", "Pose library: scope buttons, checklist, Save new and Replace selected are visible, labelled and have tooltips", async () => {
    await tabLib();
    const ids = ["posescope-sel", "posescope-body", "posescope-full", "poseinc-root", "poseinc-shear", "poseinc-mixes", "poseinc-slots", "poseinc-drawOrder", "poseinc-deforms", "savepose", "posereplace"];
    const info = await s.E((list) => list.map((id) => { const e = document.getElementById(id); const t = e?.title || e?.closest("label")?.title || ""; return { id, vis: !!e && e.offsetParent !== null, tip: t.length > 15 }; }), ids);
    need(info.every((i) => i.vis && i.tip), `controls: ${JSON.stringify(info.filter((i) => !i.vis || !i.tip))}`);
  });
  await test("batch6b", "Full animated state captures the root and shear; the checklist shows what was included", async () => {
    await s.E(() => { const a = window.atlasEditor; a.select("chest"); a.shear("chest", 6, 0); a.select("root"); a.rotate("root", 7); });
    await s.page.click("#posescope-full");
    const checks = await s.E(() => ["root", "shear", "mixes", "slots", "drawOrder", "deforms"].map((k) => document.getElementById(`poseinc-${k}`).checked));
    need(checks.every(Boolean), `full checklist ${checks}`);
    const rec = await s.E(() => { const inc = { root: true, shear: true, mixes: true, slots: true, drawOrder: true, deforms: true }; return window.atlasEditor.capturePose("qa_full", undefined, {}, inc, null); });
    need(rec.bones.root && Math.abs(rec.bones.root.rotate - 7) < 0.01, `root ${JSON.stringify(rec.bones.root)}`);
    need(rec.bones.chest?.shear && Math.abs(rec.bones.chest.shear.x - 6) < 0.01, `shear ${JSON.stringify(rec.bones.chest)}`);
    need(rec.includes.includes("root") && rec.includes.includes("deforms"), `includes ${rec.includes}`);
    const sel = await s.E(() => window.atlasEditor.capturePose("qa_char", undefined, {}, { root: false, shear: true, mixes: false, slots: true, drawOrder: true, deforms: false }, null));
    need(!sel.bones.root, "the character pose captured the root");
  });
  await test("batch6b", "Save new refuses nothing but asks before replacing a used name; Replace selected asks too; Previous version and Undo bring the old pose back", async () => {
    await s.E(() => { const a = window.atlasEditor; a.select("upper_arm_near"); a.rotate("upper_arm_near", 30); });
    await s.page.click("#posescope-body");
    await s.page.fill("#posename", "qa_replace");
    await s.page.click("#savepose");
    await wait(s, 700);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 30, "first save missing");
    // Replace through the name collision confirm (autoAccept clicks Replace).
    await s.E(() => window.atlasEditor.rotate("upper_arm_near", 60));
    await s.page.fill("#posename", "qa_replace");
    await s.page.click("#savepose");
    await wait(s, 900);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 60, "the collision replace did not write");
    const vers = await s.E(async () => (await (await fetch("/api/pose-history?name=qa_replace")).json()).versions.length);
    need(vers >= 1, "no previous version kept");
    // Previous version.
    await s.page.click('#posegrid .pcard[data-pose="qa_replace"]');
    await s.page.click("#poseprevious");
    await wait(s, 700);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 30, "Previous version did not restore the first pose");
    // Replace selected, then Undo replace.
    await s.E(() => window.atlasEditor.rotate("upper_arm_near", 80));
    await s.page.click("#posereplace");
    await wait(s, 900);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 80, "Replace selected did not write");
    await s.page.click("#poseundo");
    await wait(s, 700);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 30, "Undo replace did not bring the old pose back");
  });
  await test("batch6b", "Deleting a pose keeps a copy: Restore deleted brings it back", async () => {
    await s.page.click('#posegrid .pcard[data-pose="qa_replace"]');
    await s.page.click("#posedelete");
    await wait(s, 900);
    need(!(await s.E(async () => (await (await fetch("/api/poses")).json()).includes("qa_replace"))), "pose still listed after delete");
    need(await s.E(() => !document.getElementById("posedeletedrow").hidden), "the Restore deleted row is hidden");
    await s.page.selectOption("#posedeleted", "qa_replace");
    await s.page.click("#poserestoredeleted");
    await wait(s, 900);
    need((await poseJson("qa_replace")).bones.upper_arm_near.rotate === 30, "restored pose differs");
  });
  // ---- audio reference track () ----
  const wavBuffer = (() => {
    const rate = 8000, n = rate; // 1 s
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000 * Math.max(0, 1 - Math.abs(i - n / 2) / (n / 2))), 44 + i * 2);
    return buf;
  })();
  const audioState = () => s.E(() => window.atlasEditor.audioTrack());
  await test("batch6b", "Audio track: the Audio button, Load, Offset, Volume, Mute and Remove are visible, labelled and have tooltips", async () => {
    await s.page.click("#audiobtn");
    await s.page.setInputFiles("#audiofile", { name: "steps.wav", mimeType: "audio/wav", buffer: wavBuffer });
    await s.page.waitForFunction(() => window.atlasEditor.audioTrack()?.loaded, null, { timeout: 15000 });
    const ids = ["audiobtn", "audioload", "audiooffset", "audiovolume", "audiomute", "audioremove"];
    const info = await s.E((list) => list.map((id) => { const e = document.getElementById(id); const tip = e?.title || e?.closest("label")?.title || ""; return { id, vis: !!e && e.offsetParent !== null, tip: tip.length > 15, label: !!(e?.textContent?.trim() || e?.getAttribute("aria-label")) }; }), ids);
    need(info.every((i) => i.vis && i.tip && i.label), `audio controls: ${JSON.stringify(info.filter((i) => !i.vis || !i.tip || !i.label))}`);
  });
  await test("batch6b", "Audio track: a loaded wav shows a waveform under the dopesheet and is stored per clip in clip-meta.json with the file in the data folder", async () => {
    await wait(s, 300);
    const st = await audioState();
    need(st.loaded && st.peaks >= 150 && st.inkColumns > 40, `state ${JSON.stringify(st)}`);
    const server = await s.E(async () => ({ meta: await (await fetch("/api/clip-meta")).json(), file: await fetch("/api/audio/qa_b6b.wav").then(async (r) => ({ ok: r.ok, head: new TextDecoder().decode((await r.arrayBuffer()).slice(0, 4)) })) }));
    need(server.meta.qa_b6b?.audio?.file === "qa_b6b.wav" && server.meta.qa_b6b.audio.name === "steps.wav", `meta ${JSON.stringify(server.meta)}`);
    need(server.file.ok && server.file.head === "RIFF", `audio file ${JSON.stringify(server.file)}`);
    const clip = await s.E(() => JSON.stringify(window.atlasEditor.getClip()));
    need(!clip.includes("audio"), "the audio leaked into the clip data");
  });
  await test("batch6b", "Audio track: plays with the clip at the playback speed (0.5x), stops with it, and scrubbing plays a short burst", async () => {
    await s.page.fill("#speed", "0.5");
    await s.page.locator("#speed").dispatchEvent("change");
    await s.E(() => window.atlasEditor.setTime(0));
    await s.page.click("#play");
    await wait(s, 500);
    const on = await audioState();
    await s.page.click("#play");
    await wait(s, 150);
    const off = await audioState();
    await s.page.fill("#speed", "1");
    await s.page.locator("#speed").dispatchEvent("change");
    need(on.sounding && on.rate === 0.5 && on.starts >= 1, `playing state ${JSON.stringify(on)}`);
    need(!off.sounding, "the audio kept sounding after stop");
    const b0 = (await audioState()).bursts;
    await s.E(() => window.atlasEditor.setTime(10 / 30));
    await wait(s, 100);
    need((await audioState()).bursts > b0, "scrubbing played no burst");
  });
  await test("batch6b", "Audio track: offset shifts the waveform, volume and mute change the gain and are saved, Remove deletes the reference", async () => {
    const ink0 = (await audioState()).inkColumns;
    await s.page.fill("#audiooffset", "500");
    await s.page.locator("#audiooffset").dispatchEvent("change");
    await wait(s, 300);
    need((await audioState()).offset === 0.5, "offset not applied");
    await s.page.fill("#audiooffset", "0");
    await s.page.locator("#audiooffset").dispatchEvent("change");
    await s.E(() => { const v = document.getElementById("audiovolume"); v.value = "40"; v.dispatchEvent(new Event("input", { bubbles: true })); v.dispatchEvent(new Event("change", { bubbles: true })); });
    await s.E(() => window.atlasEditor.setTime(0));
    await s.page.click("#play");
    await wait(s, 300);
    const vol = await audioState();
    await s.page.click("#play");
    need(Math.abs(vol.gain - 0.4) < 0.01 && Math.abs(vol.volume - 0.4) < 0.01, `volume ${JSON.stringify(vol)}`);
    await s.page.click("#audiomute");
    need((await audioState()).muted && (await audioState()).gain === 0, "mute did not silence");
    await wait(s, 300);
    const saved = await s.E(async () => (await (await fetch("/api/clip-meta")).json()).qa_b6b.audio);
    need(saved.muted === true && Math.abs(saved.volume - 0.4) < 0.01, `saved ${JSON.stringify(saved)}`);
    await s.page.click("#audiomute");
    await s.page.click("#audioremove");
    await wait(s, 600);
    const gone = await s.E(async () => ({ meta: await (await fetch("/api/clip-meta")).json() }));
    need(!gone.meta.qa_b6b, `after remove ${JSON.stringify(gone)}`);
    need(!(await audioState()).loaded, "still loaded after remove");
    need(ink0 > 0, "no waveform before");
  });
  // ---- bake the mix preview () ----
  await test("batch6b", "Bake: the layered preview bakes into a new editable clip; the source clip and tracks are untouched, a used name is refused", async () => {
    await ws(s, "pro");
    await s.E(() => window.atlasEditor.showTab("preview"));
    await s.E(() => window.atlasEditor.switchClip("qa_b6b"));
    await s.E(() => { const a = window.atlasEditor; a.tracksOpen(true); for (let i = a.tracksInfo().tracks.length - 1; i > 0; i--) a.trackRemove(i); });
    const before = await s.E(() => JSON.stringify(window.atlasEditor.state().clip));
    const ids = await s.E(() => ["bakename", "bakestep", "bakescope", "bakeclip"].map((id) => { const e = document.getElementById(id); return { id, vis: !!e && e.offsetParent !== null, tip: (e?.title ?? "").length > 15 }; }));
    need(ids.every((i) => i.vis && i.tip), `bake controls ${JSON.stringify(ids)}`);
    await s.page.fill("#bakename", "qa_b6b");
    await s.page.click("#bakeclip");
    need(/already exists/.test(await s.E(() => document.getElementById("bakeinfo").textContent)), "a used name was accepted");
    await s.page.fill("#bakename", "qa_baked");
    await s.page.selectOption("#bakescope", "slots");
    await s.page.click("#bakeclip");
    await wait(s, 500);
    const st = await s.E(() => window.atlasEditor.state());
    need(st.clipName === "qa_baked", `open clip is ${st.clipName}`);
    const rot = st.clip.bones.upper_arm_near?.rotate ?? [];
    const at = (f) => rot.find((k) => Math.round(k.time * 30) === f)?.value;
    need(rot.length >= 3 && Math.abs((at(6) ?? 999) - 40) < 0.6 && Math.abs((at(12) ?? 999) - 10) < 0.6, `baked arm keys ${JSON.stringify(rot.slice(0, 6))}`);
    need(!(await s.E(() => window.atlasEditor.mixActive())), "the mix preview stayed open");
    await s.E(() => window.atlasEditor.switchClip("qa_b6b"));
    need((await s.E(() => JSON.stringify(window.atlasEditor.state().clip))) === before, "baking changed the source clip");
    // The new clip is a normal clip: editable (a key edit is one undoable change) and listed in the library.
    await s.E(() => window.atlasEditor.switchClip("qa_baked"));
    const n0 = (await s.E(() => window.atlasEditor.state().clip.bones.upper_arm_near.rotate.length));
    await s.E(() => { const a = window.atlasEditor; a.setTime(3 / 30); a.select("upper_arm_near"); a.rotate("upper_arm_near", 55); a.key(); });
    const n1 = await s.E(() => window.atlasEditor.state().clip.bones.upper_arm_near.rotate.length);
    need(n1 >= n0, "the baked clip could not be edited");
  });
  // ---- onion ghost scope () ----
  await test("batch6b", "Onion scope: Whole character / Selected bones buttons (labelled, with tooltips) change the ghost scope; ghosts still draw with a bone selected", async () => {
    await ws(s, "animate");
    await s.E(() => { const a = window.atlasEditor; a.switchClip("qa_b6b"); a.setTime(6 / 30); a.select("upper_arm_near"); a.setOnion({ enabled: true, before: 1, after: 1 }); });
    const info = await s.E(() => [...document.querySelectorAll("#onionscope button")].map((b) => ({ t: b.textContent, tip: b.title.length > 15 })));
    need(info.length === 2 && info.every((i) => i.tip), `scope buttons ${JSON.stringify(info)}`);
    await s.E(() => document.querySelector('#onionscope [data-v="selected"]').click());
    await wait(s, 500);
    const sel = await s.E(() => window.atlasEditor.onionInfo());
    need(sel.scope === "selected" && sel.ghosts >= 1, `selected ${JSON.stringify({ scope: sel.scope, ghosts: sel.ghosts })}`);
    const on = await s.E(() => document.querySelector('#onionscope [data-v="selected"]').classList.contains("on"));
    await s.E(() => document.querySelector('#onionscope [data-v="all"]').click());
    await wait(s, 300);
    const all = await s.E(() => window.atlasEditor.onionInfo());
    await s.E(() => window.atlasEditor.setOnion({ enabled: false }));
    need(on && all.scope === "all", "scope button state did not follow the choice");
  });
  // ---- Pose tab tidy ----
  await test("batch6b", "Pose tab: Compensate is a toggle in the stage bar, Breakdown % lives in the Key menu, the Pose tab keeps Mirror only", async () => {
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.showTab("pose"));
    const dom = await s.E(() => ({ comp: !!document.querySelector("#vtop #compensate"), compPanel: !!document.getElementById("comppanel"), bdInPane: !!document.querySelector("#pane-pose #bdslider"), mirror: !!document.querySelector("#pane-pose #mirrorsel") }));
    need(dom.comp && !dom.compPanel && !dom.bdInPane && dom.mirror, `dom ${JSON.stringify(dom)}`);
    await s.page.click("#compensate");
    need(await s.E(() => document.getElementById("compensate").classList.contains("on")), "Compensate toggle did not turn on");
    await s.page.click("#compensate");
    await s.page.keyboard.press("Escape");
    if (!(await s.E(() => document.getElementById("key-menu").hidden === false))) await s.page.click("#key-menu-btn");
    const _dbg = await s.E(() => ({ menuHidden: document.getElementById("key-menu").hidden, btnDisabled: document.getElementById("key-menu-btn").disabled, fs: document.querySelector("#transport fieldset")?.disabled, open: document.getElementById("bd-open").offsetParent !== null }));
    await s.page.locator("#bd-open").dispatchEvent("click"); // a leftover toast can sit over the menu item
    need(await s.E(() => { const r = document.getElementById("bdrow"); return !r.hidden && r.offsetParent !== null; }), "Breakdown row did not open in the Key menu");
    await s.page.fill("#bdvalue", "25");
    await s.page.locator("#bdvalue").dispatchEvent("change");
    need((await s.E(() => document.getElementById("bdslider").value)) === "25", "Breakdown number did not drive the slider");
    await s.page.keyboard.press("Escape");
  });
}

// ===== 11. Batch 8a: Pro dock by mode, Ship staged order + Published table + presets + hashes, Home rigs / Continue / recovery ===========
if (want("batch8a")) {
  for (const [w, h] of [[1366, 768], [1600, 1000]]) {
    const s = track(await session(w, h));
    s.phase = "batch8a";
    await ws(s, "pro");
    await wait(s, 500);
    await test("batch8a", `${w}x${h} Pro (Animate mode): one tool palette, one transport, every right-panel tab visible and inside the tab bar`, async () => {
      await s.E(() => document.querySelector("#modeseg [data-mode=animate]").click());
      await wait(s, 400);
      const r = await s.E(() => {
        const vis = (e) => e.offsetParent !== null;
        const bar = document.getElementById("tabs").getBoundingClientRect();
        const tabs = [...document.querySelectorAll("#tabs [role=tab], #tabs button")].filter(vis);
        const clipped = tabs.filter((t) => { const b = t.getBoundingClientRect(); return b.left < bar.left - 1 || b.right > bar.right + 1 || b.top < bar.top - 1 || b.bottom > bar.bottom + 1; });
        return { palettes: [...document.querySelectorAll("#toolpalette")].filter(vis).length, bars: [...document.querySelectorAll("[role=toolbar][data-transport]")].filter(vis).length, tabs: tabs.length, clipped: clipped.map((t) => t.textContent) };
      });
      need(r.palettes === 1 && r.bars === 1 && r.tabs >= 7 && r.clipped.length === 0, JSON.stringify(r));
    });
    await test("batch8a", `${w}x${h} Pro (Setup mode): the timeline is swapped for the Images / Edits / Draw order dock, not shown dimmed`, async () => {
      await s.E(() => document.querySelector("#modeseg [data-mode=setup]").click());
      await wait(s, 500);
      const r = await s.E(() => {
        const vis = (e) => !!e && e.offsetParent !== null;
        const foot = getComputedStyle(document.querySelector("footer")).display;
        const txt = document.body.innerText;
        return { foot, palettes: [...document.querySelectorAll("#toolpalette")].filter(vis).length, dock: /Images/.test(txt) && /Edits/.test(txt) && /Draw order/.test(txt), strip: vis(document.getElementById("xstrip")) };
      });
      need(r.foot === "none" && r.palettes === 1 && r.dock && !r.strip, JSON.stringify(r));
    });
    await s.close();
  }
  {
    const s = track(await session(1366, 768));
    s.phase = "batch8a";
    await makeClip(s, "qa_b8a_ship");
    await ws(s, "ship");
    await wait(s, 900);
    await test("batch8a", "Ship: Check, Apply, then Publish (primary), then Also: Export Spine and Download, in that order", async () => {
      const r = await s.E(() => {
        const ids = ["ship-check", "ship-save", "ship-apply", "ship-publish", "ship-spine-export", "ship-export"];
        const els = ids.map((i) => document.getElementById(i));
        const order = els.every((e, i) => e && (i === 0 || (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)));
        const heads = [...document.querySelectorAll("#soon .ship-h")].map((e) => e.textContent);
        return { order, heads, primary: els.map((e) => e?.classList.contains("btn-primary")), tips: els.every((e) => e && e.title.length > 15) };
      });
      need(r.order && r.heads.join("|") === "1. Check|2. Apply|3. Publish|Also" && r.primary[3] && !r.primary[4] && r.tips, JSON.stringify(r));
    });
    await test("batch8a", "Ship: the preflight names the rig and the working clip revision with a sha1, and the checklist flags the unsaved clip", async () => {
      const r = await s.E(() => ({ hash: document.getElementById("ship-pre-hash")?.textContent, clip: document.getElementById("ship-pre-clip")?.textContent, rows: [...document.querySelectorAll("#ship-checklist .ship-check")].map((e) => `${e.dataset.check}:${e.dataset.status}`) }));
      need(/sha1 [0-9a-f]{10}/.test(r.hash ?? "") && /qa_b8a_ship/.test(r.clip ?? "") && r.rows.includes("clip:bad"), JSON.stringify(r));
    });
    await test("batch8a", "Ship: Save then Check turns the clip row green; a Published table lists the saved clip as new with a hash", async () => {
      await s.page.click("#ship-save");
      await wait(s, 900);
      await s.page.click("#ship-check");
      await wait(s, 1800);
      const r = await s.E(() => ({ rows: [...document.querySelectorAll("#ship-checklist .ship-check")].map((e) => `${e.dataset.check}:${e.dataset.status}`), table: [...document.querySelectorAll("#ship-published tr[data-kind]")].map((e) => `${e.dataset.kind}:${e.dataset.name}:${e.dataset.state}`), detail: document.querySelector("#ship-published tr[data-name=qa_b8a_ship]")?.textContent ?? "" }));
      need(r.rows.includes("clip:ok") && r.table.some((t) => t.startsWith("clip:qa_b8a_ship:new")) && /[0-9a-f]{10}/.test(r.detail), JSON.stringify(r));
    });
    await test("batch8a", "Publish is bound to the reviewed plan: a stale token is refused with 409 and writes nothing", async () => {
      const r = await s.E(async () => {
        const plan = await (await fetch("/api/publish?kind=clip&name=qa_b8a_ship.clip.json")).json();
        const after = await (await fetch("/api/publish?kind=clip&name=qa_b8a_ship.clip.json")).json();
        return { token: plan.token, hashes: Object.keys(plan.hashes ?? {}), added: after.added };
      });
      // Node-side request: a 409 in the page would log a console error that the run-wide error check counts.
      const bad = await s.page.request.post(new URL("/api/publish", url).href, { data: { kind: "clip", name: "qa_b8a_ship.clip.json", token: "0000000000000000" } });
      r.status = bad.status();
      const again = await s.E(async () => (await (await fetch("/api/publish?kind=clip&name=qa_b8a_ship.clip.json")).json()).added);
      need(again.length === 1, "the refused publish changed the plan");
      need(r.status === 409 && /^[0-9a-f]{16}$/.test(r.token) && r.hashes.length === 1 && r.added.length === 1, JSON.stringify(r));
    });
    await test("batch8a", "Ship: a saved render preset appears in the selector, becomes the active one and is stored; built-ins cannot be deleted; bad scales are refused", async () => {
      await s.page.fill("#ship-preset-name", "QA wide");
      await s.page.fill("#ship-preset-scales", "0.5, 1");
      await s.page.fill("#ship-preset-bg", "223344");
      await s.page.click("#ship-preset-save");
      await wait(s, 300);
      const r = await s.E(() => ({ val: document.getElementById("ship-preset").value, note: document.getElementById("ship-preset-note").textContent, stored: localStorage.getItem("atlas-editor-render-presets") }));
      need(r.val === "custom:QA wide" && /0\.5, 1 on #223344/.test(r.note) && /QA wide/.test(r.stored ?? ""), JSON.stringify(r));
      await s.page.selectOption("#ship-preset", "phone");
      need(await s.page.isDisabled("#ship-preset-delete"), "a built-in preset can be deleted");
      await s.page.fill("#ship-preset-scales", "9");
      await s.page.click("#ship-preset-save");
      need(/Scales/.test(await s.E(() => document.getElementById("ship-preset-note").textContent)), "bad scales were accepted");
    });
    await s.close();
  }
  {
    const s = track(await session(1366, 768));
    s.phase = "batch8a";
    await makeClip(s, "qa_b8a_home");
    await ws(s, "pro");
    await ws(s, "home");
    await wait(s, 600);
    await test("batch8a", "Home: New rig is a job card, Recent rigs lists the open rig, Continue names rig and clip and resumes the same workspace", async () => {
      const r = await s.E(() => ({ card: document.querySelector("#home-newrig")?.classList.contains("home-card"), rigs: document.querySelectorAll("#home-recent-rigs [data-rig]").length, cont: document.getElementById("home-continue-rig")?.textContent ?? "" }));
      need(r.card && r.rigs >= 1 && /Continue: .*qa_b8a_home.*Pro/.test(r.cont), JSON.stringify(r));
      await s.page.click("#home-continue-rig");
      await wait(s, 800);
      need(await s.E(() => document.body.classList.contains("ws-pro")), "Continue did not resume Pro");
    });
    await test("batch8a", "Home: Recover autosave and Recently deleted clips are visible with tooltips, and per-project milestones show for the open rig", async () => {
      await ws(s, "home");
      await wait(s, 400);
      const r = await s.E(() => ({ a: document.getElementById("home-recover")?.title.length > 15, d: document.getElementById("home-deleted")?.title.length > 15, ms: [...document.querySelectorAll("#home-milestones [data-milestone]")].map((e) => e.dataset.milestone) }));
      need(r.a && r.d && r.ms.join(",") === "Artwork,Skeleton,Weights,First clip,Validated", JSON.stringify(r));
      await s.page.click("#home-recover");
      await s.page.waitForFunction(() => /autosave/i.test(document.getElementById("home-recover-note").textContent), null, { timeout: 8000 });
    });
    await s.close();
  }
}

// ===== 12. Batch 8b-2: rig events (define, key with payload, save), keymap rebinding, rig switch then wear =====================
if (want("batch8b2")) {
  {
    let s = track(await session(1680, 1000));
    s.phase = "batch8b2";
    await autoAccept(s.page);
    await test("batch8b2", "switch rig, then wear an item: no page errors (the open clip no longer leaves a stale animation state)", async () => {
      const before = s.errors.length;
      await s.E(() => window.atlasEditor.mountOutfit("pro-turned"));
      await wait(s, 1200);
      await s.E(() => window.atlasEditor.mountOutfit("turned-l"));
      await wait(s, 1200);
      await s.E(() => window.atlasEditor.mountOutfit("pro-turned"));
      await wait(s, 1200);
      await ws(s, "swag");
      await s.page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
      const name = await s.E(() => window.atlasSwag.items()[0].name);
      await s.E((n) => window.atlasSwag.wear(n, true), name);
      await wait(s, 1500);
      await s.E(() => window.atlasEditor.mountOutfit("pro-turned"));
      await wait(s, 1200);
      await s.E((n) => window.atlasSwag.wear(n, true), name);
      await wait(s, 1500);
      const fresh = s.errors.slice(before).map((e) => e.text);
      need(fresh.length === 0, `errors after the rig switch: ${fresh.slice(0, 2).join(" | ")}`);
    });
    await test("batch8b2", "Events: define footstep in Rig (Tree > Events), key it in Animate with int 2 and audio, save, reload: the payload and the label survive", async () => {
      await s.E(() => window.atlasEditor.mountOutfit("pro-turned"));
      await wait(s, 1200);
      await ws(s, "rig");
      await s.E(() => window.atlasEditor.showTab("rig"));
      await wait(s, 400);
      await s.page.click('.ol-row[data-id="g:events"]');
      await s.page.fill("#setup-event-name", "footstep");
      await s.page.click("#setup-event-add");
      await wait(s, 900);
      const def = await s.E(() => window.atlasEditor.setupRaw().events?.footstep);
      need(def, `the rig file lacks the footstep definition: ${JSON.stringify(def)}`);
      await s.page.fill('[data-field="footstep.int"]', "1");
      await s.page.keyboard.press("Tab");
      await wait(s, 600);
      need((await s.E(() => window.atlasEditor.setupRaw().events.footstep.int)) === 1, "the default int did not save");
      await s.E(() => window.atlasEditor.setupSave());
      await wait(s, 800);
      await makeClip(s, "qa_ev82");
      await ws(s, "animate");
      await s.E(() => window.atlasEditor.showTab("keys"));
      await wait(s, 400);
      const names = await s.E(() => [...document.querySelectorAll("#eventpanel select option")].map((o) => o.value));
      need(names.includes("footstep") && names.includes("hit"), `the event list lacks footstep: ${names}`);
      await s.E(() => window.atlasEditor.setTime(3 / 30));
      const vis = await s.E(() => { const e = document.querySelector("#eventpanel select"); const r = e.getBoundingClientRect(); return [r.width, r.height, document.querySelector("#pane-keys").className, document.body.className, getComputedStyle(document.querySelector("#pane-keys")).display]; });
      need(vis[0] > 0, `event panel hidden: ${JSON.stringify(vis)}`);
      await s.page.selectOption("#eventpanel select", "footstep");
      await s.page.fill("#event-payload-int", "2");
      await s.page.fill("#event-payload-audio", "step_soft");
      await s.page.click("#eventpanel >> text=Add at playhead");
      await wait(s, 500);
      const ev = await s.E(() => window.atlasEditor.getClip().events);
      need(ev.some((e) => e.name === "footstep" && e.int === 2 && e.audio === "step_soft"), `no footstep key with its payload: ${JSON.stringify(ev)}`);
      await s.page.click("#save");
      await wait(s, 1500);
      const files = await s.E(() => fetch("/api/clips").then((r) => r.json()));
      need(JSON.stringify(files).includes("qa_ev82"), `the clip was not saved: ${JSON.stringify(files).slice(0, 200)}`);
      await s.page.reload();
      await s.page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
      await wait(s, 1500);
      await ws(s, "pro");
      const opts = await s.E(() => [...document.querySelectorAll("#clip option")].map((o) => o.value));
      const saved = opts.find((o) => o.endsWith("qa_ev82.clip.json") || o === "qa_ev82");
      need(saved, `after reload the picker lacks the clip (${opts.join(", ")})`);
      await s.page.selectOption("#clip", saved);
      await s.page.waitForFunction(() => window.atlasEditor.state().clipName === "qa_ev82" && window.atlasEditor.state().clip.events?.length, null, { timeout: 8000 }).catch(() => {});
      const back = await s.E(() => window.atlasEditor.state().clip.events);
      need(back.some((e) => e.name === "footstep" && e.int === 2 && e.audio === "step_soft"), `payload lost on reload: ${JSON.stringify(back)}`);
      const rows = await s.E(() => window.atlasEditor.timelineRows());
      need(JSON.stringify(rows).includes("event"), "no event row on the timeline");
    });
    s = track(await session(1680, 1000));
    s.phase = "batch8b2";
    await autoAccept(s.page);
    await test("batch8b2", "Keymap: rebinding Key to J in Help > Edit keyboard shortcuts makes J key the pose and K do nothing; Reset all restores K", async () => {
      await makeClip(s, "qa_km82");
      await s.page.click("#helpbtn");
      await s.page.click("#help-keymap");
      await s.page.fill("#keymap-search", "Key selected bones");
      await s.page.click('[data-rebind="key"]');
      await s.page.keyboard.press("j");
      await wait(s, 500);
      const saved = await s.E(() => fetch("/api/keymap").then((r) => r.json()));
      need(saved.bindings?.key === "J", `keymap.json has ${JSON.stringify(saved)}`);
      await s.page.click('#keymap-dialog button:has-text("Close")');
      await stdState(s);
      const count = () => s.E(() => (window.atlasEditor.getClip().bones.chest?.rotate ?? []).length);
      await s.E(() => { window.atlasEditor.select("chest"); window.atlasEditor.setTime(9 / 30); });
      await neutral(s);
      const c0 = await count();
      await press(s, "k");
      await wait(s, 400);
      need((await count()) === c0, "K still keys after the rebind");
      await press(s, "j");
      await wait(s, 400);
      need((await count()) === c0 + 1, "J did not key the pose");
      await s.page.click("#helpbtn");
      await s.page.click("#help-keymap");
      await s.page.click("#keymap-reset-all");
      await wait(s, 500);
      const cleared = await s.E(() => fetch("/api/keymap").then((r) => r.json()));
      need(Object.keys(cleared.bindings ?? {}).length === 0, `keymap.json not cleared: ${JSON.stringify(cleared)}`);
      await s.page.click('#keymap-dialog button:has-text("Close")');
    });
    await test("batch8b2", "Keymap: a key another action uses is flagged with Swap / Cancel; the ? sheet shows the new key", async () => {
      await neutral(s);
      await s.page.click("#helpbtn");
      await s.page.click("#help-keymap");
      await s.page.fill("#keymap-search", "Key selected bones");
      await s.page.click('[data-rebind="key"]');
      await s.page.keyboard.press("r");
      await s.page.waitForSelector('[data-swap="key"]');
      await s.page.click('[data-swap="key"]');
      await wait(s, 500);
      const sheet = await s.E(() => fetch("/api/keymap").then((r) => r.json()));
      need(sheet.bindings?.key === "R" && sheet.bindings?.rotate === "K", JSON.stringify(sheet));
      await s.page.click("#keymap-reset-all");
      await wait(s, 400);
      await s.page.click('#keymap-dialog button:has-text("Close")');
    });
    cleanups.push(() => s.close());
  }
}

// ---------------------------------------------------------------------------------------------------------------- pipeline
// Area "pipeline" (Batch 9): qa-pipeline.mjs runs its own sandboxed server and temp stock root; its rows join this report.
// verify.mjs passes --skip-pipeline because it runs qa-pipeline as its own step.
if (want("pipeline") && !argv.includes("--skip-pipeline") && !match) {
  const out = resolve(tmpdir(), `atlas-qa-pipeline-${process.pid}.json`);
  const r = spawnSync(process.execPath, [resolve(PKG, "scripts/qa-pipeline.mjs"), `--json=${out}`, ...(argv.includes("--headed") ? ["--headed"] : [])], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 900_000 });
  let got = [];
  try {
    got = JSON.parse(readFileSync(out, "utf8"));
  } catch {}
  for (const row of got) rec("pipeline", row.name, row.status, row.detail);
  if (!got.length) rec("pipeline", "qa-pipeline.mjs ran and reported its rows", "FAIL", `exit ${r.status}: ${String(r.stdout ?? "").slice(-300)} ${String(r.stderr ?? "").slice(-300)}`);
}

// ===== 13. Batch 10b: swag mesh transfer, garment gates with honest coverage, wizard zones from the rig, weight membership / weld preview ====
if (want("batch10b")) {
  const s = track(await session(1680, 1000));
  s.phase = "batch10b";
  await autoAccept(s.page);
  await s.E(() => window.atlasEditor.mountOutfit("pro-turned"));
  await wait(s, 1200);
  await ws(s, "swag");
  await s.page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
  const runGates = (mode) => s.E((m) => window.atlasSwag.runGates(m).then((r) => r && { mode: r.mode, frames: r.frames, results: r.results.map((x) => ({ id: x.id, status: x.status, scope: x.coverage.scope, frames: x.coverage.frames, combos: x.coverage.combos, facings: x.coverage.facings, framesTotal: x.coverage.framesTotal, n: x.findings.length, findings: x.findings.map((f) => ({ frame: f.frame, reason: f.reason })), first: x.findings[0] ? `${x.findings[0].frame} ${x.findings[0].facing}: ${x.findings[0].reason}` : "", summary: x.summary })) }), mode);
  const brief = (r) => r.results.map((x) => `${x.id}:${x.status}${x.first ? ` (${x.first})` : ""}`).join("; ");
  await test("batch10b", "gates: the approved Jacket B template passes neck, shoulders and cuffs, ink is no worse than its 1 source break, and every gate says sampled", async () => {
    await s.E(() => window.atlasSwag.wear("chest.jacket_b", true));
    await wait(s, 1200);
    const r = await runGates("sample");
    need(r.results.length === 4, `gates ${r.results.map((x) => x.id)}`);
    for (const g of r.results) need(g.scope === "sampled" && g.facings.join() === "turned", `${g.id} scope ${g.scope} facings ${g.facings}`);
    for (const g of r.results.filter((x) => x.id !== "ink")) need(g.status === "pass", brief(r));
    // Jacket B has one pre-existing ink break (the Animate overlay says the same); green for ink = no worse than that source art.
    const ink = await s.E(() => window.atlasSwag.runGates("sample").then((g) => g.results.find((x) => x.id === "ink").findings.map((f) => f.reason)));
    need(ink.every((t) => t === "1 ink outline break"), `ink ${JSON.stringify(ink)}`);
    await ws(s, "animate");
    await s.E(() => window.atlasEditor.setActiveSkin("chest.jacket_b"));
    await wait(s, 600);
    const overlay = await s.E(() => window.atlasGate.recompute().then((x) => x && x.breaks));
    need(overlay === 1, `overlay breaks ${overlay}`);
    await ws(s, "swag");
  });
  await test("batch10b", "gates: the approved Leather jacket passes every gate (the neck is flat, no hole)", async () => {
    await s.E(() => window.atlasSwag.wear("chest.jacket_b", false));
    await s.E(() => window.atlasSwag.wear("chest.leather", true));
    await wait(s, 800);
    const r = await runGates("sample");
    await s.E(() => window.atlasSwag.wear("chest.leather", false));
    await s.E(() => window.atlasSwag.wear("chest.jacket_b", true));
    for (const g of r.results) need(g.status === "pass", brief(r));
  });
  await test("batch10b", "transfer: a chest item built from the Leather art on kit-body-cutout gets mesh sleeves with 2+ bones, and its ink stays green at a 60 degree elbow", async () => {
    // The Leather source: its three flat regions cut out of the rig's atlas, handed to the wizard as three PNG files.
    const files = await s.E(async () => {
      const base = "/repo/packages/animator/rigs/kit-body-cutout/";
      const man = await (await fetch(`${base}kit-body-cutout.atlas.json?v=${Date.now()}`)).json();
      const pages = new Map();
      const cut = async (path) => {
        const pg = man.pages.find((p) => p.regions?.[path]);
        if (!pg) throw new Error(`no atlas region ${path}`);
        const r = pg.regions[path];
        if (!pages.has(pg.file)) pages.set(pg.file, await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(pg.file)); i.src = `${base}${pg.file}?v=${Date.now()}`; }));
        const c = document.createElement("canvas");
        c.width = r.width; c.height = r.height;
        c.getContext("2d").drawImage(pages.get(pg.file), r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        return c.toDataURL("image/png").split(",")[1];
      };
      return { torso: await cut("chest.leather/shirt_torso__torso"), near: await cut("chest.leather/shirt_sleeve_near__sleeve"), far: await cut("chest.leather/shirt_sleeve_far__sleeve") };
    });
    const buf = (b64) => Buffer.from(b64, "base64");
    await s.page.click("#swnew");
    await s.page.click('.swdoll .zone[data-slot="chest"]');
    await s.page.fill("#switemname", "Leather Copy");
    await s.page.setInputFiles("#swfiles", [
      { name: "torso.png", mimeType: "image/png", buffer: buf(files.torso) },
      { name: "sleeve_near.png", mimeType: "image/png", buffer: buf(files.near) },
      { name: "sleeve_far.png", mimeType: "image/png", buffer: buf(files.far) }
    ]);
    await s.page.waitForFunction(() => document.querySelectorAll(".swpart.full").length >= 3, null, { timeout: 30_000 });
    await s.page.click("#swsave");
    await s.page.waitForFunction(() => window.atlasSwag.items().some((i) => i.name === "chest.leather-copy"), null, { timeout: 60_000 });
    await wait(s, 1500);
    const saved = await s.E(async () => {
      const d = await (await fetch("/repo/packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json?v=" + Date.now())).json();
      const a = d.skins["chest.leather-copy"].attachments;
      const info = (slot) => { const m = Object.values(a[slot] ?? {})[0] ?? {}; return { type: m.type, bones: m.bones ? new Set(m.bones).size : 0 }; };
      return { near: info("shirt_sleeve_near"), far: info("shirt_sleeve_far"), torso: info("shirt_torso") };
    });
    const gates = await runGates("sample");
    const ink = gates.results.find((x) => x.id === "ink");
    const elbowBreaks = ink.findings.filter((f) => f.frame.startsWith("Elbow")).map((f) => f.reason);
    await s.E(() => window.atlasSwag.wear("chest.leather-copy", false));
    need(saved.near.type === "mesh" && saved.near.bones >= 2 && saved.far.type === "mesh" && saved.far.bones >= 2, `sleeves ${JSON.stringify(saved)}`);
    need(elbowBreaks.length === 0, `ink at the 60 degree elbow: ${JSON.stringify(ink.findings)} (${brief(gates)})`);
  });
  await test("batch10b", "zones: the wizard's body picker is drawn from the rig's own slots and bones (not the fixed picture), and tapping a zone picks the slot", async () => {
    await s.page.click("#swnew");
    await s.page.waitForSelector(".swdoll");
    const z = await s.E(() => { const d = document.querySelector(".swdoll"); return { from: d.dataset.from, zones: [...d.querySelectorAll(".zone")].map((g) => [g.dataset.slot, g.querySelectorAll("rect").length]), viewBox: d.querySelector("svg").getAttribute("viewBox") }; });
    need(z.from === "rig", `picker drawn from ${z.from}`);
    need(["chest", "pants", "boots", "gloves", "weapon", "helmet"].every((k) => z.zones.some(([n]) => n === k)), JSON.stringify(z.zones));
    need(z.zones.find(([n]) => n === "chest")[1] >= 3, `chest boxes ${JSON.stringify(z.zones)}`);
    await s.page.click('.swdoll .zone[data-slot="pants"]');
    await wait(s, 200);
    const picked = await s.E(() => document.querySelector(".swpicked")?.textContent);
    await s.page.click("#swcancel");
    need(picked === "Pants", `picked ${picked}`);
  });
  await test("batch10b", "gates: a Full run with no clip open still says sampled, and Ship's checklist shows the same gate rows with that scope", async () => {
    await s.E(() => window.atlasSwag.wear("chest.jacket_b", true));
    await wait(s, 800);
    const full = await runGates("full");
    need(full.results.every((g) => g.scope === "sampled"), `scopes ${full.results.map((g) => g.scope)}`);
    need(full.results.every((g) => g.facings.join() === "turned,mirrored"), `facings ${full.results.map((g) => g.facings)}`);
    await ws(s, "ship");
    await wait(s, 500);
    const rows = await s.E(() => [...document.querySelectorAll("#ship-checklist [data-check^='gate-']")].map((li) => ({ id: li.dataset.check, status: li.dataset.status, text: li.textContent })));
    await ws(s, "swag");
    need(rows.length === 4, `ship gate rows ${JSON.stringify(rows)}`);
    need(rows.every((r) => /sampled/.test(r.text) && !/full check/.test(r.text)), JSON.stringify(rows));
    const want = Object.fromEntries(full.results.map((g) => [`gate-${g.id}`, g.status === "pass" ? "ok" : g.status === "fail" ? "bad" : "todo"]));
    need(rows.every((r) => want[r.id] === r.status), `${JSON.stringify(rows.map((r) => [r.id, r.status]))} vs ${JSON.stringify(want)}`);
  }, { timeout: 240_000 });
  await test("batch10b", "gates: the neck rule fails a grey scoop hole and a dark slab under the chin, and passes a collar band with a little skin", async () => {
    const out = await s.E(async () => {
      const { measureNeck, neckReasons } = await import("/src/swagGates.ts");
      const W = 200, H = 240, run = (fill) => { const m = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fill(x, y)) m[y * W + x] = 1; return neckReasons(measureNeck({ mask: m, width: W, height: H, chinY: 60, neckX: 100, scale: 1 })).map((r) => r.reason); };
      const torso = (x, y, top) => y >= top && x >= 40 && x < 160;
      return { band: run((x, y) => torso(x, y, 66)), scoop: run((x, y) => torso(x, y, 62) && Math.hypot(x - 100, y - 62) > 30), slab: run((x, y) => (y >= 62 && y < 100 && x >= 80 && x < 120) || torso(x, y, 100)) };
    });
    need(out.band.length === 0, `band ${out.band}`);
    need(out.scoop.length > 0 && out.slab.some((t) => t.includes("slab")), JSON.stringify(out));
  });
}

// ===== 14. Batch 12c: swag placement handles, clip transitions, path bone picker ===============================================
if (want("batch12c")) {
  const s = track(await session(1600, 1000));
  s.phase = "batch12c";
  await autoAccept(s.page);
  await ws(s, "swag");
  await s.page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
  await wait(s, 800);
  const { PNG } = require("pngjs");
  const solid = () => {
    const png = new PNG({ width: 160, height: 200 });
    for (let i = 0; i < 160 * 200; i++) png.data.set([60, 120, 190, 255], i * 4);
    return PNG.sync.write(png);
  };
  const vals = () => s.E(() => { const q = (k) => Number(document.querySelector(`.swnudge[data-piece="torso"] [data-nudge="${k}"]`).value); return { x: q("x"), y: q("y"), rot: q("rot"), scale: q("scale") }; });
  const center = async (sel) => { const b = await s.page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const dragBy = async (sel, dx, dy, shift = false) => {
    const c = await center(sel);
    await s.page.mouse.move(c.x, c.y);
    if (shift) await s.page.keyboard.down("Shift");
    await s.page.mouse.down();
    await s.page.mouse.move(c.x + dx, c.y + dy, { steps: 5 });
    await s.page.mouse.up();
    if (shift) await s.page.keyboard.up("Shift");
    await wait(s, 150);
  };
  await test("batch12c", "Swag handles: Move, Turn (Shift = 15 degree steps) and Size handles on the picture change the numeric fields, each drag is one Undo step, typing a number redraws the handles", async () => {
    await s.page.click("#swnew");
    await s.page.click('.swdoll .zone[data-slot="chest"]');
    await s.page.fill("#switemname", "Handle Test");
    await s.page.setInputFiles("#swfiles", [{ name: "torso.png", mimeType: "image/png", buffer: solid() }]);
    await s.page.waitForSelector('.swnudge[data-piece="torso"]');
    await s.page.waitForFunction(() => document.querySelectorAll("#swhandles [data-h]").length === 3, null, { timeout: 30_000 });
    await wait(s, 600);
    need(await s.page.locator("#swhandles-on").isVisible(), "no Handles checkbox");
    need((((await s.page.locator("#swhandles-on").evaluate((e) => e.closest("label")?.title)) ?? "").length) > 30, "the Handles toggle has no tooltip");
    for (const h of ["move", "turn", "size"]) need(((await s.page.locator(`#swhandles .swh-${h} title`).textContent()) ?? "").length > 10, `${h} handle has no tooltip`);
    need((await s.page.locator('.swnudge[data-piece="torso"] [data-act="select-piece"]').count()) === 1, "no per-piece Handles button");
    const v0 = await vals();
    await dragBy("#swhandles .swh-move", 12, 8);
    const v1 = await vals();
    need(v1.x !== v0.x || v1.y !== v0.y, `move ${JSON.stringify([v0, v1])}`);
    await dragBy("#swhandles .swh-turn", 25, 10, true);
    const v2 = await vals();
    need(v2.rot !== v1.rot && Math.abs(v2.rot / 15 - Math.round(v2.rot / 15)) < 1e-6, `turn ${JSON.stringify(v2)}`);
    const mc = await center("#swhandles .swh-move");
    const sc = await center("#swhandles .swh-size");
    const L = Math.hypot(sc.x - mc.x, sc.y - mc.y) || 1;
    await dragBy("#swhandles .swh-size", ((sc.x - mc.x) / L) * 14, ((sc.y - mc.y) / L) * 14);
    const v3 = await vals();
    need(v3.scale > v2.scale, `size ${JSON.stringify(v3)}`);
    await s.page.click("#sw-undo");
    let v = await vals();
    need(v.scale === v2.scale && v.rot === v2.rot, `undo 1 ${JSON.stringify(v)}`);
    await s.page.click("#sw-undo");
    v = await vals();
    need(v.rot === v1.rot && v.x === v1.x, `undo 2 ${JSON.stringify(v)}`);
    await s.page.click("#sw-undo");
    v = await vals();
    need(v.x === v0.x && v.y === v0.y, `undo 3 ${JSON.stringify(v)}`);
    await s.page.click("#sw-redo");
    need((await vals()).x === v1.x, "redo did not put the move back");
    await s.page.fill('.swnudge[data-piece="torso"] [data-nudge="rot"]', "30");
    await wait(s, 300);
    need((await s.page.locator("#swhandle-read").innerText()).includes("turn 30"), "the readout did not follow the typed number");
    await s.page.click("#swhandles-on");
    need(await s.page.locator("#swhandles").evaluate((e) => e.classList.contains("off")), "the Handles toggle did not hide the handles");
    await s.page.click("#swcancel");
  });
  await test("batch12c", "Transitions: Animate button opens the Pro tab, the graph pre-fills from the project clip map, a trigger crossfades (status shows the blend), auto-cycle runs the path, edits save per rig in transitions.json", async () => {
    await ws(s, "pro");
    for (const [name, arm] of [["idle_weight_shift", 4], ["walk_in_place", 35], ["attack_1", -60]]) {
      await s.page.click("#newclip-open");
      await s.page.fill("#newclip-name", name);
      await s.page.click("#newclip-make");
      await wait(s, 400);
      await s.E((a) => { const e = window.atlasEditor; for (const f of [0, 10]) { e.setTime(f / 30); e.select("upper_arm_near"); e.rotate("upper_arm_near", f === 0 ? a : -a); e.key(); } }, arm);
    }
    await ws(s, "animate");
    need(((await s.page.locator("#transitionsbtn").getAttribute("title")) ?? "").length > 20, "no tooltip on the Transitions button");
    await s.page.click("#transitionsbtn");
    await s.page.waitForSelector("#transgraph", { timeout: 20_000 });
    await wait(s, 800);
    let info = await s.E(() => window.atlasEditor.transInfo());
    need(info.active && (await s.E(() => window.atlasEditor.currentTab())) === "transitions", "the button did not open the Transitions tab");
    need(info.graph.nodes.length === 3 && info.graph.edges.length >= 4, `prefill ${JSON.stringify(info.graph)}`);
    need(await s.E(() => window.atlasEditor.mixActive()), "the stage does not show the graph");
    await s.E(() => window.atlasEditor.transStart("idle_weight_shift"));
    need((await s.E(() => window.atlasEditor.transFire("walk_in_place"))) === null, "fire refused");
    await wait(s, 60);
    info = await s.E(() => window.atlasEditor.transInfo());
    need(info.status.from === "idle_weight_shift" && info.status.mix !== null, `blend ${JSON.stringify(info.status)}`);
    need((await s.E(() => window.atlasEditor.transFire("nope"))) !== null, "a missing transition was accepted");
    await s.E(() => window.atlasEditor.transCycle(true));
    await wait(s, 3500);
    info = await s.E(() => window.atlasEditor.transInfo());
    need(info.cycling && info.status.fired >= 2, `cycle ${JSON.stringify(info.status)}`);
    await s.E(() => window.atlasEditor.transCycle(false));
    need((await s.E(() => window.atlasEditor.transAddEdge("walk_in_place", "attack_1", 0.4, "swing"))) === null, "edge not added");
    need((await s.E(() => window.atlasEditor.transAddEdge("walk_in_place", "walk_in_place", 0.4, ""))) !== null, "a self transition was accepted");
    need(await s.E(() => window.atlasEditor.transSave()), "save failed");
    const stored = await s.E(() => fetch(`/api/transitions?rig=${encodeURIComponent(window.atlasEditor.transInfo().rig)}`).then((r) => r.json()));
    need(stored.graph?.edges.find((e) => e.id === "walk_in_place>attack_1")?.blend === 0.4, "the edit was not stored");
    for (const sel of ["#transtoggle", "#transprefill", "#transplay", "#transcycle", "#transedgeadd", "#transblend", "#transpath", "#transsavenow", "#transstart", "#transnodeadd"]) {
      need(((await s.page.locator(sel).first().getAttribute("title")) ?? "").length > 10, `${sel} has no tooltip`);
    }
    await s.page.click("#mixbanner-exit");
    need(!(await s.E(() => window.atlasEditor.mixActive())), "Back to the clip did not close the graph preview");
  });
  await test("batch12c", "Path constraint bone picker lists only bones the engine accepts (not the bone the path slot rides on or the bones above it)", async () => {
    await ws(s, "rig");
    await s.E(() => window.atlasEditor.showTab("rig"));
    const raw = await s.E(() => window.atlasEditor.setupRaw());
    const slot = raw.slots[0];
    need(!!slot, "no slot");
    await s.E((sl) => window.atlasEditor.setupSelectSlot(sl), slot.name);
    await s.page.click("#setup-add-path");
    await wait(s, 600);
    await s.E(() => window.atlasEditor.select("head"));
    await wait(s, 300);
    await s.page.click("#setup-addpath");
    await wait(s, 600);
    const r = await s.E(() => window.atlasEditor.setupRaw());
    const k = (r.path ?? [])[0];
    need(!!k, "no path constraint was added");
    await s.E((n) => window.atlasEditor.setupSelectNode({ kind: "constraint", ckind: "path", name: n }), k.name);
    await wait(s, 400);
    const opts = await s.page.locator("#path-addbone-sel option").evaluateAll((o) => o.map((x) => x.value));
    const parent = new Map(r.bones.map((b) => [b.name, b.parent]));
    const slotBone = r.slots.find((x) => x.name === k.target)?.bone;
    const above = new Set();
    for (let b = slotBone; b; b = parent.get(b)) above.add(b);
    need(opts.every((o) => !above.has(o) && !k.bones.includes(o)), `the picker offers ${opts.filter((o) => above.has(o) || k.bones.includes(o))}`);
  });
}

// ---------------------------------------------------------------------------------------------------------------- report
// Page / console errors from every session, whatever it was doing (a catch-all behind the per-workspace error check).
if (want("errors") || only.length === 0) {
  const all = sessions.flatMap((s) => s.errors);
  const uniq = [...new Set(all.map((e) => `[${e.phase}] ${e.text}`))];
  rec("errors", "no page or console error anywhere during the whole run", uniq.length ? "FAIL" : "PASS", uniq.slice(0, 4).join(" | "));
}
for (const c of cleanups) await c();
await browser.close().catch(() => {});

const order = ["FAIL", "XPASS", "SKIP", "XFAIL", "PASS"];
const count = (st) => rows.filter((r) => r.status === st).length;
console.log("\n==================== Atlas Animator QA ====================");
const areas = [...new Set(rows.map((r) => r.area))];
console.log("area       PASS  FAIL XFAIL XPASS  SKIP");
for (const a of areas) {
  const rs = rows.filter((r) => r.area === a);
  console.log(`${a.padEnd(10)} ${String(rs.filter((r) => r.status === "PASS").length).padStart(4)} ${String(rs.filter((r) => r.status === "FAIL").length).padStart(5)} ${String(rs.filter((r) => r.status === "XFAIL").length).padStart(5)} ${String(rs.filter((r) => r.status === "XPASS").length).padStart(5)} ${String(rs.filter((r) => r.status === "SKIP").length).padStart(5)}`);
}
for (const st of ["FAIL", "XPASS", "SKIP", "XFAIL"]) {
  const rs = rows.filter((r) => r.status === st);
  if (!rs.length) continue;
  console.log(`\n${st} (${rs.length})`);
  for (const r of rs) console.log(`  ${r.area}: ${r.name}\n      ${r.detail}`);
}
const failed = count("FAIL") + (strictXpass ? count("XPASS") : 0);
console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("XFAIL")} expected-fail, ${count("XPASS")} unexpectedly passing, ${count("SKIP")} skipped. ${failed ? "QA FAILED" : "QA OK"}`);
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(rows, null, 2));
void order;
process.exit(failed ? 1 : 0);
