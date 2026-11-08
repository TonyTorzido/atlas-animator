/*
 * Atlas Animator editor: original implementation.
 *
 * Heat-map overlay for the Weights tool (MESH-WEIGHTS-PLAN section 2, "Heat map"). Pure colour code plus a small Pixi drawable:
 *
 *  - `heatRamp(t)`: cold to hot (blue, cyan, green, yellow, red) for the active bone's weight.
 *  - `fillColors(...)`: one RGBA colour per vertex, either the active bone's ramp colour or every bone's `boneColor()` blended by weight.
 *  - `HeatMesh`: a Pixi Mesh with a vertex-colour shader that shares a position array with the skin preview, so a brush dab repaints it
 *    by writing colours and flagging the buffers. When the shader cannot be built it falls back to one Graphics fill per triangle.
 */
import { Buffer, BufferUsage, Container, Geometry, Graphics, Mesh, Shader } from "pixi.js";
import { boneColor } from "./boneDraw.js";
import type { WeightTable } from "./weightModel.js";

export type HeatMode = "active" | "all";

const HEAT_STOPS: readonly (readonly [number, number, number])[] = [
  [0.1, 0.18, 0.65],
  [0.0, 0.78, 0.95],
  [0.15, 0.85, 0.3],
  [0.98, 0.9, 0.1],
  [0.95, 0.15, 0.1]
];

/** Ramp colour (r, g, b in 0..1) at `t` (0 = cold, 1 = hot). */
export function heatRamp(t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT_STOPS[i] as readonly [number, number, number];
  const b = HEAT_STOPS[i + 1] as readonly [number, number, number];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/** The bone's colour as 0..1 channels. */
export function boneRgb(name: string): [number, number, number] {
  const c = boneColor(name);
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/**
 * Writes RGBA (4 floats per vertex) for every vertex: "active" colours by the weight of column `active`, "all" blends the bones' own
 * colours by weight. `alpha` is the overlay opacity. Only the listed `vertices` are rewritten when given (a brush dab).
 */
export function fillColors(table: WeightTable, mode: HeatMode, active: number, out: Float32Array, alpha = 0.7, vertices?: Iterable<number>): Float32Array {
  const B = table.bones.length;
  const rgb = mode === "all" ? table.bones.map(boneRgb) : [];
  const tmp: [number, number, number] = [0, 0, 0];
  const one = (v: number): void => {
    const o = v * 4;
    if (mode === "active") {
      heatRamp(active >= 0 ? (table.data[v * B + active] as number) : 0, tmp);
      out[o] = tmp[0];
      out[o + 1] = tmp[1];
      out[o + 2] = tmp[2];
    } else {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < B; k++) {
        const w = table.data[v * B + k] as number;
        if (w <= 0) continue;
        const c = rgb[k] as [number, number, number];
        r += w * c[0];
        g += w * c[1];
        b += w * c[2];
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
    out[o + 3] = alpha;
  };
  if (vertices) for (const v of vertices) one(v);
  else for (let v = 0; v < table.vertexCount; v++) one(v);
  return out;
}

const VERTEX = `
in vec2 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec4 vColor;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor = aColor;
}`;
const FRAGMENT = `
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;

/** The heat drawable: `node` goes into the scene; `positions` is the (shared) world position array, 2 floats per vertex. */
export class HeatMesh {
  readonly node: Container = new Container({ label: "weights-heat" });
  readonly colors: Float32Array;
  /** "mesh" (vertex-colour shader) or "graphics" (one fill per triangle). */
  readonly kind: "mesh" | "graphics";
  private mesh: Mesh<Geometry, Shader> | null = null;
  private posBuffer: Buffer | null = null;
  private colBuffer: Buffer | null = null;
  private g: Graphics | null = null;

  constructor(readonly positions: Float32Array, readonly triangles: ArrayLike<number>, forceGraphics = false) {
    this.colors = new Float32Array((positions.length / 2) * 4);
    let kind: "mesh" | "graphics" = "graphics";
    if (!forceGraphics) {
      try {
        this.posBuffer = new Buffer({ data: positions, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        this.colBuffer = new Buffer({ data: this.colors, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        const geometry = new Geometry({
          attributes: {
            aPosition: { buffer: this.posBuffer, format: "float32x2", stride: 8, offset: 0 },
            aColor: { buffer: this.colBuffer, format: "float32x4", stride: 16, offset: 0 }
          },
          indexBuffer: Uint32Array.from(triangles as ArrayLike<number>)
        });
        const shader = Shader.from({ gl: { vertex: VERTEX, fragment: FRAGMENT }, resources: {} });
        const mesh = new Mesh<Geometry, Shader>({ geometry, shader } as never);
        this.mesh = mesh;
        this.node.addChild(mesh as unknown as Container);
        kind = "mesh";
      } catch {
        this.mesh = null;
      }
    }
    this.kind = kind;
    if (kind === "graphics") {
      this.g = new Graphics();
      this.node.addChild(this.g);
    }
  }

  /** Flags the position and colour buffers (or redraws the triangles) after the arrays changed. */
  update(): void {
    if (this.mesh) {
      this.posBuffer?.update();
      this.colBuffer?.update();
      return;
    }
    const g = this.g;
    if (!g) return;
    g.clear();
    const p = this.positions;
    const c = this.colors;
    const t = this.triangles;
    for (let i = 0; i + 2 < t.length; i += 3) {
      const a = t[i] as number;
      const b = t[i + 1] as number;
      const d = t[i + 2] as number;
      const r = ((c[a * 4] as number) + (c[b * 4] as number) + (c[d * 4] as number)) / 3;
      const gr = ((c[a * 4 + 1] as number) + (c[b * 4 + 1] as number) + (c[d * 4 + 1] as number)) / 3;
      const bl = ((c[a * 4 + 2] as number) + (c[b * 4 + 2] as number) + (c[d * 4 + 2] as number)) / 3;
      const alpha = (c[a * 4 + 3] as number) || 0.7;
      g.poly([p[a * 2] as number, p[a * 2 + 1] as number, p[b * 2] as number, p[b * 2 + 1] as number, p[d * 2] as number, p[d * 2 + 1] as number]).fill({
        color: ((Math.round(r * 255) << 16) | (Math.round(gr * 255) << 8) | Math.round(bl * 255)) >>> 0,
        alpha
      });
    }
  }

  destroy(): void {
    this.node.removeFromParent();
    this.node.destroy({ children: true });
    this.mesh = null;
    this.g = null;
  }
}
