/*
 * Atlas Animator: original implementation.
 *
 * The contract between `animator render` (Node) and the headless render page (browser). Plain
 * types only, so both sides compile it.
 */
export interface RenderPageOptions {
  documentUrl: string;
  atlasUrl: string;
  /** Clip to play on track 0, or null for the setup pose. */
  clip: string | null;
  /** Clips queued after `clip` on track 0, each starting when the previous one ends (its loop cycle for a looping clip). */
  queue?: string[];
  skins: string[];
  fps: number;
  /** Seconds of physics warm-up on the first pose (0 = none). */
  warmup: number;
  width: number;
  height: number;
  /** Where the skeleton origin sits on the output, and the character scale. */
  x: number;
  y: number;
  scale: number;
  /** 0xRRGGBB, or null for a transparent background. */
  background: number | null;
}

export interface RenderPageInfo {
  renderer: string;
  vendor: string;
  missingTextures: string[];
}

export interface RenderPageFrame {
  /** PNG data URL. */
  png: string;
  time: number;
  missingTextures: string[];
}

export interface RenderPage {
  prepare(options: RenderPageOptions): Promise<RenderPageInfo>;
  /** Renders the next frame (the first call renders time 0). */
  next(): RenderPageFrame;
  bench(frames: number): { msPerFrame: number; frames: number };
  dispose(): void;
}

/** What the page installs on its window. */
export interface RenderPageGlobal {
  animatorRender?: RenderPage;
}
