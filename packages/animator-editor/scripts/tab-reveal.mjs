// The editor's right panel is tabbed (Pose, Keys, Rig, Skins, Preview, Library, Export), so a control can sit in a tab that is
// not showing. revealTabs(page) makes the page's selector-based actions open the tab that holds the control first, so a demo
// written against the old long scroll keeps finding its controls. Controls outside the tabs are untouched.
const WITH_SELECTOR = ["click", "dblclick", "fill", "check", "uncheck", "selectOption", "setInputFiles", "press", "dispatchEvent", "hover", "focus", "waitForSelector", "type", "tap"];
const LOCATOR_ACTIONS = ["click", "dblclick", "fill", "check", "uncheck", "selectOption", "setInputFiles", "press", "hover", "focus", "boundingBox", "scrollIntoViewIfNeeded", "waitFor", "isVisible", "type"];

/**
 * Pass { keepRestoreBar: true } to a demo that tests the autosave Restore bar. Every other demo leaves unsaved work behind that the
 * next run is offered back, and that bar floats over the canvas and swallows clicks, so it is hidden for them.
 */
export function revealTabs(page, { keepRestoreBar = false, workspace = "pro" } = {}) {
  // The editor opens on the Home screen; a demo written against the full layout starts in the Pro workspace (every tab, every control).
  let initDone = !workspace;
  const init = async () => {
    if (initDone) return;
    initDone = true;
    await page.addInitScript((w) => { window.__atlasWorkspace = w; }, workspace);
  };
  for (const name of ["goto", "reload"]) {
    const orig = page[name].bind(page);
    page[name] = async (...args) => {
      await init();
      const res = await orig(...args);
      if (!keepRestoreBar) await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
      return res;
    };
  }
  // Open the tab, and also any collapsed section or closed <details> that holds the control (the Keys and Pose panels collapse their later sections).
  const reveal = async (sel) => {
    const shown = await page.evaluate((s) => window.atlasEditor?.reveal?.(s) ?? false, sel).catch(() => false);
    await page
      .evaluate((s) => {
        let el = null;
        try {
          el = document.querySelector(s) ?? document.querySelector(s.split(/[ >]/)[0]);
        } catch {
          return;
        }
        for (let n = el; n; n = n.parentElement) {
          if (n.tagName === "DETAILS") n.open = true;
          if (n.classList?.contains("collapsed") && !/h2/.test(s)) n.classList.remove("collapsed");
        }
      }, sel)
      .catch(() => {});
    return shown;
  };
  for (const name of WITH_SELECTOR) {
    const orig = page[name].bind(page);
    page[name] = async (selector, ...rest) => {
      if (typeof selector === "string") await reveal(selector);
      return orig(selector, ...rest);
    };
  }
  const origLocator = page.locator.bind(page);
  page.locator = (selector, options) => {
    const loc = origLocator(selector, options);
    if (typeof selector !== "string") return loc;
    for (const name of LOCATOR_ACTIONS) {
      const orig = loc[name]?.bind(loc);
      if (orig) loc[name] = async (...args) => (await reveal(selector), orig(...args));
    }
    return loc;
  };
  return page;
}

/** Opens a tab by id ("pose", "keys", "rig", "skins", "preview", "library", "export"). */
export const showTab = (page, id) => page.evaluate((t) => window.atlasEditor.showTab(t), id);
