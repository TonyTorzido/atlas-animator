/*
 * Atlas Animator editor: right-panel housekeeping. The panels are built by many modules, so the shared
 * look is applied here once instead of in each of them:
 *  - every section heading gets the `.sec` class,
 *  - a "label" that is really a sentence becomes `.help` (sentence case, readable colour),
 *  - every scroll container in the panel shows the bottom fade while there is more below,
 *  - the underlay's native file input is replaced by a button plus the chosen file's name.
 */

const FADE_SELECTOR = "#panes > .pane, #right .pgrid";
/** Scroll containers elsewhere in the editor: the bone list and tree, the project view, the keys sheet, the Swag workshop, the Clip board lists. */
const GLOBAL_FADE_SELECTOR = "#bones, #outliner .ol-tree, #gameview, #helpcard, .swscroll, .swsbody, .cb-lists";
/** A label longer than this is a sentence, not a field name. */
const SENTENCE_LENGTH = 30;

export function tidyRightPanel(root: HTMLElement | null = document.getElementById("right")): void {
  if (!root) return;

  const fades = new Set<HTMLElement>();
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => entries.forEach((e) => updateFade(e.target as HTMLElement)));
  function updateFade(el: HTMLElement): void {
    el.classList.add("scroll-fade");
    el.classList.toggle("more", el.scrollHeight > el.clientHeight + 1 && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }
  function watchFade(el: HTMLElement): void {
    if (fades.has(el)) return;
    fades.add(el);
    el.addEventListener("scroll", () => updateFade(el), { passive: true });
    ro?.observe(el);
    updateFade(el);
  }

  function sweep(): void {
    for (const h of root!.querySelectorAll<HTMLElement>("section h2:not(.sec)")) h.classList.add("sec");
    // Headers built late by other panels (the Swag workshop lives in the left column, not the right panel).
    for (const h of document.querySelectorAll<HTMLElement>("#left section h2:not(.sec), #swagws h2:not(.sec)")) h.classList.add("sec");
    for (const l of root!.querySelectorAll<HTMLElement>(".label:not(.help)")) {
      if (l.tagName === "LABEL" || l.querySelector("input, select, button")) continue;
      if ((l.textContent ?? "").trim().length > SENTENCE_LENGTH) l.classList.add("help");
    }
    for (const el of root!.querySelectorAll<HTMLElement>(FADE_SELECTOR)) watchFade(el);
    for (const el of document.querySelectorAll<HTMLElement>(GLOBAL_FADE_SELECTOR)) watchFade(el);
    for (const el of fades) {
      if (!el.isConnected) fades.delete(el);
      else updateFade(el);
    }
  }

  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sweep();
    });
  };
  const watch = new MutationObserver(later);
  watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
  // Panels built late anywhere in the page (the Swag workshop, game view, keys sheet, Clip board) get their headers and fades too.
  watch.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", later);
  sweep();

  // Underlay image: a button and the file's name instead of the browser's "Choose File / No file chosen".
  const input = document.getElementById("underinput") as HTMLInputElement | null;
  const pick = document.getElementById("underpick");
  const name = document.getElementById("underfile");
  if (input && pick && name) {
    pick.addEventListener("click", () => input.click());
    const show = () => {
      name.textContent = input.files?.[0]?.name ?? "No image";
      name.title = name.textContent;
    };
    input.addEventListener("change", show);
    document.getElementById("underclear")?.addEventListener("click", () => queueMicrotask(show));
  }
}
