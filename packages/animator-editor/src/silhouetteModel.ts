/*
 * Atlas Animator editor: original implementation.
 *
 * Silhouette check (pure): in the silhouette view the character is flat black over a ground colour, so every pixel of the
 * stage lies on the line from black to the ground colour (antialiased edges are blends of the two). This counts the pixels
 * that do not, which is zero when the silhouette really is flat.
 */
export interface SilhouetteStats {
  blackPx: number;
  groundPx: number;
  /** Pixels that are neither black, ground nor a blend of the two. */
  otherPx: number;
  otherShare: number;
}

export const SILHOUETTE_TOLERANCE = 0.08;

export function silhouetteStats(pixels: ArrayLike<number>, ground: number): SilhouetteStats {
  const g = [(ground >> 16) & 255, (ground >> 8) & 255, ground & 255];
  let black = 0;
  let bg = 0;
  let other = 0;
  const n = Math.floor(pixels.length / 4);
  for (let i = 0; i < n * 4; i += 4) {
    const r = pixels[i]! / Math.max(1, g[0]!);
    const gr = pixels[i + 1]! / Math.max(1, g[1]!);
    const b = pixels[i + 2]! / Math.max(1, g[2]!);
    if (Math.max(r, gr, b) - Math.min(r, gr, b) > SILHOUETTE_TOLERANCE) other++;
    else if (r < 0.05) black++;
    else if (r > 0.95) bg++;
  }
  return { blackPx: black, groundPx: bg, otherPx: other, otherShare: other / Math.max(1, n) };
}
