/*
 * Atlas Animator editor: "Phone size" (P). The one-key way to judge a garment the way a player sees it: the canvas zoom goes to the zoom a phone
 * shows the character at, and back to a fitted view when switched off. The state is read from the live zoom, so wheel zooming away from it
 * switches the toggle off by itself and the button never lies.
 */
import type { EditorHost } from "./host.js";

/** Canvas zoom that matches the character's size on a phone. */
export const PHONE_ZOOM = 0.42;
const TOLERANCE = 0.02;

export const isPhoneZoom = (zoom: number): boolean => Math.abs(zoom - PHONE_ZOOM) <= TOLERANCE;

export interface PhoneSizeApi {
  on(): boolean;
  set(on: boolean): void;
  toggle(): boolean;
}

declare global {
  interface Window {
    atlasPhone?: PhoneSizeApi;
  }
}

export function installPhoneSize(host: EditorHost): void {
  const api: PhoneSizeApi = {
    on: () => isPhoneZoom(host.view.state().zoom),
    set(on) {
      // Fit first so the figure is centred, then step to the phone zoom about the centre of the view.
      host.view.fit();
      if (on) host.view.zoomTo(PHONE_ZOOM);
      host.status(on ? `Phone size: zoom ${PHONE_ZOOM}, as a phone shows the character` : "Phone size off: view fitted");
    },
    toggle() {
      const next = !api.on();
      api.set(next);
      return next;
    }
  };
  window.atlasPhone = api;
}
