// Demo of the Clip board's clip management: New clip, My clips, the per-clip "..." menu (open, rename,
// duplicate, delete, length / fps, file path), custom slots, the "+ Create" hover, and the autosave banner not covering the header.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-clipboard-manage.mjs [outDir]
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
const { url, dataDir } = await demoServer(undefined);
if (!dataDir) throw new Error("this demo needs its own sandbox");
const clipsDir = resolve(dataDir, "clips");
const file = (n) => resolve(clipsDir, `${n}.clip.json`);
const json = (n) => JSON.parse(readFileSync(file(n), "utf8"));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 900 } }), { workspace: null, keepRestoreBar: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
};
const boot = async () => {
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
};
const openBoard = async () => {
  if (await E(() => document.getElementById("clipboard")?.hidden === false)) return;
  if (await E(() => window.atlasEditor.workspace()) === "home") await page.click('#home .home-card[data-go="animate"]');
  else await page.click("#clips-open");
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot");
  await page.waitForTimeout(500);
};
const rowOf = (id) => `#clipboard .cb-row:has([data-clip="${id}"])`;
const menuFor = async (id) => {
  await page.hover(rowOf(id));
  await page.click(`#clipboard [data-more="${id}"]`);
  await page.waitForSelector("#clipboard .cb-menu");
};
const say = (re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("cb-notice")?.textContent ?? ""), re.source, { timeout: 30_000 });
const has = (id) => E((c) => !!document.querySelector(`#clipboard [data-clip="${c}"]`), id);

await page.goto(url);
await boot();
await openBoard();

// ---- Header: the New clip button is prominent and nothing overlaps ----
const newBtn = await E(() => {
  const b = document.getElementById("cb-new-clip");
  const r = b.getBoundingClientRect();
  return { w: r.width, h: r.height, title: b.title, shown: r.width > 0 && getComputedStyle(b).visibility !== "hidden", primary: b.classList.contains("btn-primary") };
});
check("+ New clip button visible, primary, with a tooltip", newBtn.shown && newBtn.primary && newBtn.title.length > 10, newBtn);
const overlaps = (sel) =>
  E((s) => {
    const els = [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().width > 0);
    const bad = [];
    for (let i = 0; i < els.length; i++)
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push([els[i].id || els[i].className, els[j].id || els[j].className]);
      }
    return bad;
  }, sel);
check("header controls do not overlap each other", (await overlaps(".cb-top > *:not(.cb-right), .cb-actions > *, .cb-filters > button")).length === 0, await overlaps(".cb-top > *:not(.cb-right), .cb-actions > *, .cb-filters > button"));
await shot("01-board-header");

// ---- Empty cell and missing row hover: + Create ----
await page.hover('#clipboard .cb-dot[data-clip="atk_sword_ronin_1"]');
check("missing combo dot shows a + on hover", await E(() => getComputedStyle(document.querySelector('#clipboard .cb-dot[data-clip="atk_sword_ronin_1"] .cb-plus')).display !== "none"));
await shot("02-empty-dot-hover");
await page.hover(rowOf("walk_side"));
check("missing row shows + Create on hover", await E(() => getComputedStyle(document.querySelector('#clipboard [data-clip="walk_side"] .cb-create')).display !== "none"));
await shot("03-missing-row-hover");

// ---- New clip ----
await page.click("#cb-new-clip");
await page.waitForSelector("#cb-new-dialog");
check("Create is disabled until the name is valid", await E(() => document.querySelector("#cb-new-dialog .cb-go").disabled));
await page.fill("#cb-new-name", "bad name");
check("bad name is explained", /letters/.test(await E(() => document.querySelector("#cb-new-dialog .cb-err").textContent)));
await page.fill("#cb-new-name", "atk_sword_1");
check("project clip names are refused", /project clip/.test(await E(() => document.querySelector("#cb-new-dialog .cb-err").textContent)));
await page.fill("#cb-new-name", "my_wave");
await page.fill("#cb-new-length", "2");
await page.fill("#cb-new-fps", "24");
await page.check("#cb-new-loop");
await shot("04-new-clip-dialog");
await page.click("#cb-new-dialog .cb-go");
await page.waitForFunction(() => window.atlasEditor.state().clipName === "my_wave", null, { timeout: 30_000 });
let st = await E(() => window.atlasEditor.state());
check("new clip opened with its length, fps and loop", st.clip.duration === 2 && st.clip.fps === 24 && st.clip.loop === true, { d: st.clip.duration, f: st.clip.fps, l: st.clip.loop });
check("new clip is on disk", existsSync(file("my_wave")));
check("lands in Animate", (await E(() => window.atlasEditor.workspace())) === "animate");

// ---- My clips + the menu ----
await openBoard();
check("clip shows under My clips", await has("my_wave"));
await shot("05-my-clips");
await menuFor("my_wave");
const items = await E(() => [...document.querySelectorAll("#clipboard .cb-menu-item")].map((b) => b.dataset.act + (b.disabled ? ":off" : "")));
check("menu has open, rename, duplicate, delete, length, reveal", ["open", "rename", "duplicate-copy", "delete", "length", "reveal"].every((a) => items.includes(a)), items);
await shot("06-clip-menu");

// Rename
await page.click('#clipboard .cb-menu-item[data-act="rename"]');
await page.fill("#cb-rename-name", "my_wave2");
await page.click("#cb-rename-dialog .cb-go");
await say(/Renamed my_wave to my_wave2/);
check("rename moved the file", existsSync(file("my_wave2")) && !existsSync(file("my_wave")));
check("rename kept the clip data", json("my_wave2").duration === 2);
check("board lists the new name only", (await has("my_wave2")) && !(await has("my_wave")));

// Duplicate
await menuFor("my_wave2");
await page.click('#clipboard .cb-menu-item[data-act="duplicate-copy"]');
check("duplicate suggests a free name", (await page.inputValue("#cb-dup-name")) === "my_wave2_copy");
await page.click("#cb-dup-dialog .cb-go");
await say(/Duplicated/);
check("duplicate is on disk and listed", existsSync(file("my_wave2_copy")) && (await has("my_wave2_copy")));

// Set length / fps
await menuFor("my_wave2_copy");
await page.click('#clipboard .cb-menu-item[data-act="length"]');
await page.waitForSelector("#cb-length-dialog");
await page.fill("#cb-len-length", "3");
await page.fill("#cb-len-fps", "30");
await shot("07-length-dialog");
await page.click("#cb-length-dialog .cb-go");
await say(/3 s at 30 fps/);
check("length and fps written to disk", json("my_wave2_copy").duration === 3 && json("my_wave2_copy").fps === 30, { d: json("my_wave2_copy").duration, f: json("my_wave2_copy").fps });

// Reveal file path
await menuFor("my_wave2_copy");
await page.click('#clipboard .cb-menu-item[data-act="reveal"]');
await page.waitForSelector("#cb-path-dialog");
const shown = await page.inputValue("#cb-path");
check("path dialog shows the file", shown.replace(/\\/g, "/").endsWith("/clips/my_wave2_copy.clip.json"), shown);
await shot("08-reveal-path");
await page.click("#cb-path-dialog .cb-confirm-row .cb-cancel");

// Delete (confirm, never silent)
await menuFor("my_wave2_copy");
await page.click('#clipboard .cb-menu-item[data-act="delete"]');
await page.waitForSelector("#cb-delete-dialog");
check("delete asks first and names the file", /my_wave2_copy\.clip\.json/.test(await E(() => document.querySelector("#cb-delete-dialog p").textContent)));
await shot("09-delete-confirm");
await page.click("#cb-delete-dialog .cb-cancel");
check("cancel keeps the file", existsSync(file("my_wave2_copy")));
await menuFor("my_wave2_copy");
await page.click('#clipboard .cb-menu-item[data-act="delete"]');
await page.click("#cb-delete-dialog .cb-go");
await say(/Deleted my_wave2_copy/);
check("delete removed the file and the row", !existsSync(file("my_wave2_copy")) && !(await has("my_wave2_copy")));

// ---- Custom slots ----
await page.click("#cb-add-slot");
await page.waitForSelector("#cb-slot-dialog");
await page.selectOption("#cb-slot-category", "other");
await page.fill("#cb-slot-label", "Emote: dance");
check("slot clip name follows the label", (await page.inputValue("#cb-slot-id")) === "emote_dance");
await shot("10-add-slot-dialog");
await page.click("#cb-slot-dialog .cb-go");
await say(/Added slot Emote/);
check("slot shows as missing with the custom badge", (await E(() => document.querySelector('#clipboard [data-clip="emote_dance"]')?.dataset.status)) === "missing" && (await E(() => !!document.querySelector('#clipboard [data-clip="emote_dance"] .cb-badge-custom'))));
check("slot saved to board-config.json", existsSync(resolve(clipsDir, "board-config.json")) && JSON.parse(readFileSync(resolve(clipsDir, "board-config.json"), "utf8")).slots.some((s) => s.id === "emote_dance"));

// An extra combo step
await page.click("#cb-add-slot");
await page.waitForSelector("#cb-slot-dialog");
await page.selectOption("#cb-slot-category", "attack");
await page.selectOption("#cb-slot-row", "ronin");
check("combo step dialog names the new step", /attack 4/.test(await E(() => document.querySelector("#cb-slot-dialog .cb-field-hint:not([hidden])")?.textContent ?? "")));
await page.click("#cb-slot-dialog .cb-go");
await say(/Added slot .*attack 4/);
check("step 4 dot is in the Ronin sword cell", await E(() => !!document.querySelector('#clipboard [data-cell="ronin:sword"] [data-clip="atk_sword_ronin_4"]')));
await shot("11-custom-slots");

// Clicking the missing slot creates the clip file
await page.click('#clipboard [data-clip="emote_dance"]');
await page.waitForFunction(() => window.atlasEditor.state().clipName === "emote_dance", null, { timeout: 30_000 });
check("slot click created its file", existsSync(file("emote_dance")));

// ---- Reload: everything persists ----
await page.reload();
await boot();
await openBoard();
await page.waitForSelector('#clipboard [data-clip="atk_sword_ronin_4"]');
check("after reload: custom clip, slot, step and slot status persist", (await has("my_wave2")) && (await has("emote_dance")) && (await has("atk_sword_ronin_4")) && (await E(() => document.querySelector('#clipboard [data-clip="emote_dance"]').dataset.status)) === "draft");
check("after reload: deleted clip is still gone", !(await has("my_wave2_copy")));
await shot("12-after-reload");

// ---- Remove slots (the clip file stays) ----
await menuFor("atk_sword_ronin_4").catch(async () => {
  await page.hover('#clipboard [data-clip="atk_sword_ronin_4"]');
  await page.click('#clipboard [data-more="atk_sword_ronin_4"]');
});
await page.click('#clipboard .cb-menu-item[data-act="removeslot"]');
await page.click("#cb-removeslot-dialog .cb-go");
await say(/Removed slot .*attack 4/);
check("step slot removed", !(await has("atk_sword_ronin_4")));
await menuFor("emote_dance");
await page.click('#clipboard .cb-menu-item[data-act="removeslot"]');
await page.click("#cb-removeslot-dialog .cb-go");
await say(/Removed slot Emote: dance/);
check("slot removed; its clip is now under My clips", (await has("emote_dance")) && (await E(() => !!document.querySelector('#clipboard .cb-mine [data-clip="emote_dance"]'))));
check("board-config.json is empty again", JSON.parse(readFileSync(resolve(clipsDir, "board-config.json"), "utf8")).slots.length === 0);

// ---- Autosave banner does not cover the header ----
await E(() => {
  const bar = document.getElementById("restorebar");
  bar.hidden = false;
  bar.replaceChildren();
  for (const [id, t] of [["restoretext", "Unsaved work found: an autosave is newer than the saved file for my_wave2 (just now). "], ["restorebtn", "Restore"], ["restorehistory", "History"], ["restoredismiss", "Dismiss"]]) {
    const el = document.createElement(id === "restoretext" ? "span" : "button");
    el.id = id;
    el.textContent = t;
    bar.append(el);
  }
});
await page.waitForTimeout(400);
const geo = await E(() => {
  const bar = document.getElementById("restorebar").getBoundingClientRect();
  const board = document.getElementById("clipboard").getBoundingClientRect();
  const top = [...document.querySelectorAll("#clipboard .cb-top *")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect());
  const hit = top.some((r) => r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top);
  return { barBottom: bar.bottom, boardTop: board.top, hit };
});
check("banner sits above the board header, no overlap", geo.boardTop >= geo.barBottom - 1 && !geo.hit, geo);
await shot("13-autosave-banner");
await E(() => (document.getElementById("restorebar").hidden = true));
await page.waitForTimeout(300);
check("board returns to the top when the banner goes", await E(() => document.getElementById("clipboard").getBoundingClientRect().top < 60));

// ---- Narrow window ----
await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(400);
check("1280x720: header controls do not overlap", (await overlaps(".cb-top > *:not(.cb-right), .cb-actions > *")).length === 0, await overlaps(".cb-top > *:not(.cb-right), .cb-actions > *"));
check("1280x720: no horizontal page scroll", await E(() => document.documentElement.scrollWidth <= innerWidth));
await shot("14-narrow");

check("zero page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
