/*
 * Atlas Animator editor: the one icon sprite. Every icon in the editor is a <symbol> here and is drawn with
 * `<use>`, so stroke width, caps and colour (currentColor) are identical everywhere. Sizes are CSS classes in ui.css:
 * `.ico` 16 px (controls), `.ico-md` 20 px (chips, list rows), `.ico-lg` 32 px (Home cards).
 * Strokes are `non-scaling-stroke`, so the 16-grid and 24-grid symbols both render with the same 1.7 px line.
 */

interface Sym {
  /** viewBox edge: 16 or 24 */
  vb: 16 | 24;
  /** inner SVG; paths are stroked with currentColor by default (see `.ico` in ui.css) */
  body: string;
}

const SYMBOLS = {
  // chevrons: the one pair of glyphs for every collapse / expand / disclosure
  chevL: { vb: 16, body: '<path d="M10 3 5 8l5 5"/>' },
  chevR: { vb: 16, body: '<path d="m6 3 5 5-5 5"/>' },
  chevD: { vb: 16, body: '<path d="m3 6 5 5 5-5"/>' },
  chevU: { vb: 16, body: '<path d="m3 10 5-5 5 5"/>' },
  expand: { vb: 16, body: '<path d="m3.5 3.5 4.5 4 4.5-4M3.5 8.5l4.5 4 4.5-4"/>' },
  collapse: { vb: 16, body: '<path d="m3.5 7.5 4.5-4 4.5 4M3.5 12.5l4.5-4 4.5 4"/>' },
  // outliner kinds
  bone: { vb: 16, body: '<path d="M2.5 13.5 5.5 5.5 13.5 2.5 10.5 10.5Z" fill="currentColor" stroke="#0d0f14" stroke-linejoin="round"/>' },
  slot: { vb: 16, body: '<rect x="2.5" y="4" width="11" height="8" rx="2"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>' },
  attachment: { vb: 16, body: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M3.5 11.5 7 7.5l2.2 2.3 1.3-1.4 2 3.1Z" fill="currentColor" stroke="none"/>' },
  clipMask: { vb: 16, body: '<path d="M2.5 4.5h7v4h4v7h-11Z" stroke-dasharray="2 1.6"/><path d="M6 2.5h7.5v7.5"/>' },
  hitBox: { vb: 16, body: '<path d="M2.5 2.5h3M10.5 2.5h3M2.5 13.5h3M10.5 13.5h3M2.5 2.5v3M2.5 10.5v3M13.5 2.5v3M13.5 10.5v3"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>' },
  pathCurve: { vb: 16, body: '<path d="M2 12.5C5 12.5 4.5 3.5 8 3.5s3 9 6 9"/><circle cx="2" cy="12.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="3.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="14" cy="12.5" r="1.3" fill="currentColor" stroke="none"/>' },
  constraint: { vb: 16, body: '<circle cx="4.5" cy="8" r="2.4"/><circle cx="11.5" cy="8" r="2.4"/><path d="M6.9 8h2.2"/>' },
  skin: { vb: 16, body: '<path d="M5.5 2.5 2 5l1.8 2.6 1.7-.8v6.7h5V6.8l1.7.8L14 5l-3.5-2.5C10 3.6 9.1 4 8 4s-2-.4-2.5-1.5Z" stroke-linejoin="round"/>' },
  draw: { vb: 16, body: '<rect x="4.5" y="2.5" width="9" height="7" rx="1.5"/><path d="M2.5 5v6.5a1.5 1.5 0 0 0 1.5 1.5h7"/>' },
  trash: { vb: 16, body: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"/>' },
  reparent: { vb: 16, body: '<circle cx="8" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M8 5.1v3M8 8.1H4.5v2.8M8 8.1h3.5v2.8"/>' },
  split: { vb: 16, body: '<path d="M8 2.5v11M3 8h3M10 8h3"/>' },
  sliders: { vb: 16, body: '<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>' },
  file: { vb: 16, body: '<path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3"/>' },
  eye: { vb: 16, body: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>' },
  eyeOff: { vb: 16, body: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" opacity=".45"/><path d="M3 13 13 3"/>' },
  lock: { vb: 16, body: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>' },
  unlock: { vb: 16, body: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" opacity=".6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1" opacity=".6"/>' },
  pencil: { vb: 16, body: '<path d="M3 13l.7-3L10.5 3.2a1.4 1.4 0 0 1 2 2L5.7 12.3zM9.5 4.2l2 2"/>' },
  images: { vb: 16, body: '<rect x="2" y="3" width="9" height="8" rx="1.5"/><path d="M5 13.5h7.5A1.5 1.5 0 0 0 14 12V6.5M3.5 9.5 6 7l2.5 2.5"/>' },
  history: { vb: 16, body: '<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 3v3h3M8 5v3.2l2 1.3"/>' },
  search: { vb: 16, body: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>' },
  // canvas edge column
  ruler: { vb: 24, body: '<path d="M3 17L17 3l4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2"/>' },
  plus: { vb: 24, body: '<path d="M12 5v14M5 12h14"/>' },
  minus: { vb: 24, body: '<path d="M5 12h14"/>' },
  fit: { vb: 24, body: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' },
  magnifier: { vb: 24, body: '<path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L21 21"/>' },
  bones: { vb: 24, body: '<path d="M6 18a2 2 0 1 0 0-.01zM18 6a2 2 0 1 0 0-.01zM7.4 16.6l9.2-9.2"/>' },
  helpers: { vb: 24, body: '<path d="M12 4v16M4 12h16M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>' },
  more: { vb: 24, body: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>' },
  // header and docks
  home: { vb: 16, body: '<path d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h9V6.5"/>' },
  phone: { vb: 16, body: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.5h2"/>' },
  mirror: { vb: 24, body: '<path d="M12 3v18M9 7L3 12l6 5zM15 7l6 5-6 5z"/>' },
  // view HUD (viewHud.ts)
  game: { vb: 24, body: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>' },
  facing: { vb: 24, body: '<path d="M4 12h14M13 6l6 6-6 6"/>' },
  onion: { vb: 24, body: '<circle cx="9" cy="12" r="6" opacity=".5"/><circle cx="13" cy="12" r="6" opacity=".75"/><circle cx="17" cy="12" r="4"/>' },
  compare: { vb: 24, body: '<path d="M4 18 8 6l4 12M5.3 14h5.4M15 6h3.2a2.4 2.4 0 0 1 0 5H15zM15 11h3.8a2.5 2.5 0 0 1 0 5H15z"/>' },
  hand: { vb: 24, body: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-2.5-3.5a1.5 1.5 0 0 1 2.4-1.8L8 14"/>' },
  frame: { vb: 24, body: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="3"/>' },
  snapAngle: { vb: 24, body: '<path d="M5 19h14M5 19 15 9M9 19a4 4 0 0 0-1-3"/>' },
  snapKey: { vb: 24, body: '<path d="M12 3l7 9-7 9-7-9zM12 8v8M8.5 12h7"/>' },
  selAll: { vb: 24, body: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>' },
  branch: { vb: 24, body: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v12M6 12h10M6 19h10"/>' },
  goFirst: { vb: 24, body: '<path d="M6 5v14M18 5l-8 7 8 7z"/>' },
  goLast: { vb: 24, body: '<path d="M18 5v14M6 5l8 7-8 7z"/>' },
  keyAll: { vb: 24, body: '<path d="M12 3l7 9-7 9-7-9zM9 12h6"/><path d="M12 9v6"/>' },
  events: { vb: 24, body: '<path d="M6 21V4M6 5h12l-3 4 3 4H6"/>' },
  // tool palette (toolPalette.ts)
  toolSelect: { vb: 24, body: '<path d="M6 3l12 9-5.5 1.2L15 19l-2.6 1.2-2.6-5.7L6 18z"/>' },
  toolCreate: { vb: 24, body: '<path d="M4 20 8 9l11-5-5 11z"/><path d="M17 17v5M14.5 19.5h5"/>' },
  toolImage: { vb: 24, body: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M5 17l4.5-5 3 3.2 2.3-2.4 4.2 4.2"/><circle cx="9" cy="9" r="1.4"/>' },
  toolMesh: { vb: 24, body: '<path d="M12 3 21 9v8l-9 4-9-4V9zM12 3v18M3 9l9 4 9-4"/>' },
  toolWeights: { vb: 24, body: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/><path d="M9 15a3 3 0 0 0 3 3"/>' },
  toolRotate: { vb: 24, body: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>' },
  toolMove: { vb: 24, body: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>' },
  toolScale: { vb: 24, body: '<rect x="4" y="10" width="10" height="10" rx="1.5"/><path d="M14 10 20 4M15 4h5v5"/>' },
  toolShear: { vb: 24, body: '<path d="M8 5h12l-4 14H4z"/>' },
  toolLength: { vb: 24, body: '<path d="M4 12h16M4 8v8M20 8v8M8 12l2-2M8 12l2 2M16 12l-2-2M16 12l-2 2"/>' },
  toolIk: { vb: 24, body: '<circle cx="5.5" cy="18.5" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="18.5" cy="4.5" r="2"/><path d="M7 17l3.7-6.3M13.5 7.7l3.6-2"/>' }
} satisfies Record<string, Sym>;

export type IconName = keyof typeof SYMBOLS;
export const ICON_NAMES = Object.keys(SYMBOLS) as IconName[];

const NS = "http://www.w3.org/2000/svg";
const SPRITE_ID = "ico-sprite";

function symbolMarkup(name: IconName): string {
  const s: Sym = SYMBOLS[name];
  const body = s.body.replace(/<(path|circle|rect)\b/g, '<$1 vector-effect="non-scaling-stroke"');
  return `<symbol id="ico-${name}" viewBox="0 0 ${s.vb} ${s.vb}">${body}</symbol>`;
}

/** Put the sprite in the page once (idempotent). */
export function ensureSprite(): void {
  if (typeof document === "undefined" || document.getElementById(SPRITE_ID)) return;
  const holder = document.createElementNS(NS, "svg");
  holder.setAttribute("id", SPRITE_ID);
  holder.setAttribute("width", "0");
  holder.setAttribute("height", "0");
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "absolute";
  holder.innerHTML = ICON_NAMES.map(symbolMarkup).join("");
  document.body.prepend(holder);
}

/** Icon as markup for innerHTML. `cls` adds a size class: "" (16 px), "ico-md" (20 px) or "ico-lg" (32 px). */
export function iconHtml(name: IconName, cls = ""): string {
  ensureSprite();
  return `<svg class="ico${cls ? ` ${cls}` : ""}" aria-hidden="true"><use href="#ico-${name}"/></svg>`;
}

/** Icon as an element. */
export function iconEl(name: IconName, cls = ""): SVGElement {
  ensureSprite();
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", `ico${cls ? ` ${cls}` : ""}`);
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(NS, "use");
  u.setAttribute("href", `#ico-${name}`);
  s.append(u);
  return s;
}
