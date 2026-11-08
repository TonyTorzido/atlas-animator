/*
 * Atlas Animator: original implementation.
 *
 * The CLI's headless render page (plan 4.1: the CLI renders through the same Pixi adapter as the
 * game). `animator render` loads this page in headless Chromium with SwiftShader, calls
 * `prepare` once with the document and atlas URLs, then `next` once per frame. Every frame is a
 * fixed 1/fps step (state, physics clock, apply, world transform), so renders are deterministic.
 */
import { Application, type WebGLRenderer } from "pixi.js";
import { AnimationState, AnimationStateData } from "../src/core/animationState.js";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { AnimatorCharacter } from "../src/pixi/animatorCharacter.js";
import { loadPackedAtlas } from "../src/pixi/browserImages.js";
import { DynamicAtlas } from "../src/pixi/dynamicAtlas.js";
import type { RenderPage, RenderPageFrame, RenderPageInfo, RenderPageOptions } from "./protocol.js";

declare global {
  interface Window {
    animatorRender?: RenderPage;
  }
}

let app: Application | null = null;
let session: { skeleton: Skeleton; state: AnimationState | null; character: AnimatorCharacter; atlas: DynamicAtlas; dt: number; frame: number } | null = null;

function dispose(): void {
  if (session) {
    session.character.destroy({ children: true });
    session.atlas.destroy();
    session = null;
  }
  if (app) {
    app.destroy(true);
    app = null;
  }
}

async function prepare(options: RenderPageOptions): Promise<RenderPageInfo> {
  dispose();
  const created = new Application();
  await created.init({
    width: options.width,
    height: options.height,
    preference: "webgl",
    antialias: false,
    background: options.background ?? 0x000000,
    backgroundAlpha: options.background === null ? 0 : 1,
    resolution: 1,
    autoDensity: false,
    autoStart: false,
    preserveDrawingBuffer: true
  });
  app = created;
  document.body.appendChild(created.canvas);
  const gl = (created.renderer as WebGLRenderer).gl;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const vendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));

  const doc = loadAnimDocument(await (await fetch(options.documentUrl)).json());
  const images = await loadPackedAtlas(options.atlasUrl);
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(options.skins);
  const character = new AnimatorCharacter({ skeleton, atlas, images });
  character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
  character.position.set(options.x, options.y);
  character.scale.set(options.scale);
  created.stage.addChild(character);
  let state: AnimationState | null = null;
  if (options.clip !== null) {
    if (!doc.animations[options.clip]) throw new Error(`no clip '${options.clip}'; clips: ${Object.keys(doc.animations).join(", ") || "none"}`);
    state = new AnimationState(new AnimationStateData(doc));
    state.setAnimation(0, options.clip);
    for (const next of options.queue ?? []) {
      if (!doc.animations[next]) throw new Error(`no clip '${next}' to queue`);
      state.addAnimation(0, next);
    }
    state.apply(skeleton);
  }
  skeleton.updateWorldTransform();
  if (options.warmup > 0) skeleton.warmUpPhysics(options.warmup);
  session = { skeleton, state, character, atlas, dt: 1 / options.fps, frame: 0 };
  return { renderer, vendor, missingTextures: [...character.missingTextures] };
}

function next(): RenderPageFrame {
  if (!session || !app) throw new Error("call prepare first");
  const { skeleton, state, character, dt } = session;
  if (session.frame > 0) {
    state?.update(dt);
    skeleton.update(dt);
  }
  state?.apply(skeleton);
  character.update();
  app.renderer.render(app.stage);
  const time = session.frame * dt;
  session.frame++;
  return { png: app.canvas.toDataURL("image/png"), time, missingTextures: [...character.missingTextures] };
}

/** Plan: mean wall time per frame (update + skinning + render, GPU synced by a 1-texel read). */
function bench(frames: number): { msPerFrame: number; frames: number } {
  if (!session || !app) throw new Error("call prepare first");
  const current = session;
  const created = app;
  const gl = (created.renderer as WebGLRenderer).gl;
  const texel = new Uint8Array(4);
  const step = () => {
    current.state?.update(current.dt);
    current.skeleton.update(current.dt);
    current.state?.apply(current.skeleton);
    current.character.update();
    created.renderer.render(created.stage);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, texel);
  };
  for (let i = 0; i < 30; i++) step();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) step();
  return { msPerFrame: (performance.now() - t0) / frames, frames };
}

window.animatorRender = { prepare, next, dispose, bench };
