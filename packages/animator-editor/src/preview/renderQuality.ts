const LEGACY_RENDER_QUALITY_KEY = "atlas-animator:legacy-render-quality";

/**
 * Developer A/B switch: when on, the overlay renders every frame (no idle-frame skipping). Default off. Pixel density is the separate Graphics quality setting below.
 * Read once at startup by renderer code, so changing it needs an app restart to fully apply.
 */
export function isLegacyRenderQualityEnabled(): boolean {
  try {
    return window.localStorage.getItem(LEGACY_RENDER_QUALITY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLegacyRenderQualityEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(LEGACY_RENDER_QUALITY_KEY, "1");
    else window.localStorage.removeItem(LEGACY_RENDER_QUALITY_KEY);
  } catch {
    // Storage unavailable; the flag stays off.
  }
}

const REDUCED_RENDER_QUALITY_KEY = "atlas-animator:render-quality";

/**
 * Graphics quality: high (default) renders every canvas at the full device pixel ratio. "low" caps the backbuffers at 2x
 * and drops overlay MSAA on phone-class devices. Read once when a renderer is created, so a change needs an app restart.
 * Set from Developer Tools, or by the low-FPS governor on devices that cannot hold the frame rate (never on Apple devices).
 */
export function isReducedRenderQualityEnabled(): boolean {
  try {
    return window.localStorage.getItem(REDUCED_RENDER_QUALITY_KEY) === "low";
  } catch {
    return false;
  }
}

export function setReducedRenderQualityEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(REDUCED_RENDER_QUALITY_KEY, "low");
    else window.localStorage.removeItem(REDUCED_RENDER_QUALITY_KEY);
  } catch {
    // Storage unavailable; quality stays high.
  }
}


// Render-quality knobs. Graphics quality is High by default: every canvas renders at the full device pixel ratio, so a
// 3x iPhone gets a 3x backbuffer for the map and the overlay. "Low" (Developer Tools, or the low-FPS governor on devices
// that cannot hold the frame rate) caps the backbuffers at 2x and drops overlay MSAA on phone-class devices.
// The setting is read when a renderer is created, so changing it needs an app restart.

const dpr = (): number => globalThis.devicePixelRatio || 1;

/** Raster density for Pixi Text and Graphics-to-texture work: never below 2x, up to 3x. */
export function overlayTextResolution(): number {
  return Math.min(3, Math.max(2, dpr()));
}

/** Backbuffer density of the Pixi overlay renderer. */
export function overlayRendererResolution(): number {
  return isReducedRenderQualityEnabled() ? Math.min(2, dpr()) : Math.min(3, Math.max(2, dpr()));
}

/** Density for the small standalone Pixi canvases (indoor/salon player layers, map player marker). */
export function playerLayerResolution(): number {
  return isReducedRenderQualityEnabled() ? Math.min(2, dpr()) : Math.max(2, dpr());
}

/** Phone/tablet class devices: the primary pointer is coarse (touch). Desktop browsers keep full quality. */
export function isPhoneRenderProfile(): boolean {
  try {
    if (typeof window.matchMedia === "function") return window.matchMedia("(pointer: coarse)").matches;
    return (navigator.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Overlay MSAA stays on unless Low quality is chosen on a phone-class device. */
export function overlayAntialias(): boolean {
  return !isReducedRenderQualityEnabled() || !isPhoneRenderProfile();
}
