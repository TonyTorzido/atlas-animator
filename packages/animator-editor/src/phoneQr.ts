/*
 * Atlas Animator editor: a small dependency-free QR code encoder for the Phone preview popover (byte mode, error
 * correction level M, versions 1-10: up to 213 bytes, plenty for a LAN URL). The algorithm is the standard one
 * (ISO/IEC 18004): data codewords, Reed-Solomon over GF(256) with 0x11D, block interleaving, the function patterns,
 * zigzag placement and the lowest-penalty mask of eight. Written from the spec; phoneQr.test.ts checks the capacity
 * table and Reed-Solomon, and scripts/demo-phonelive.mjs decodes the drawn picture with OpenCV when it is installed.
 */

export interface QrCode {
  version: number;
  size: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
  mask: number;
}

/** Error-correction codewords per block and number of blocks, level M, versions 1..10 (index 0 unused). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_VERSION = 10;
const FORMAT_BITS_M = 0;

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** Data modules + error-correction modules, function patterns excluded. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords that fit in `version` at level M. */
export function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * NUM_BLOCKS[version]!;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor);
    });
  }
  return result;
}

/** The final codeword sequence (data + ECC, interleaved) for the padded data codewords `data` in `version`. */
export function interleave(data: readonly number[], version: number): number[] {
  const numBlocks = NUM_BLOCKS[version]!;
  const eccLen = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = [];
  const divisor = rsDivisor(eccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]!);
    });
  }
  return out;
}

/** Bytes -> padded data codewords for `version`. */
export function dataWords(bytes: readonly number[], version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 8 + 8) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }
  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fn[y]![x] = true;
  }
  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  private drawFunctionPatterns(): void {
    const { size, version } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(size - 4, 3);
    this.finder(3, size - 4);
    const pos = alignmentPositions(version);
    pos.forEach((x, i) =>
      pos.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
        this.alignment(x, y);
      })
    );
    this.drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }
  drawFormat(mask: number): void {
    const { size } = this;
    const data = (FORMAT_BITS_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true);
  }
  place(codewords: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.fn[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!this.fn[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }
  /** The standard four penalty rules (runs, 2x2 blocks, finder-like patterns, dark/light balance). */
  penalty(): number {
    const { size, modules } = this;
    let total = 0;
    const FINDER = [true, false, true, true, true, false, true];
    const scan = (get: (a: number, b: number) => boolean): void => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) total += 3 + (run - 5);
            run = 1;
          }
        }
        for (let b = 0; b + 7 <= size; b++) {
          if (!FINDER.every((v, k) => get(a, b + k) === v)) continue;
          const light = (from: number): boolean => Array.from({ length: 4 }, (_, k) => from + k).every((p) => p < 0 || p >= size || !get(a, p));
          if (light(b - 4) || light(b + 7)) total += 40;
        }
      }
    };
    scan((y, x) => modules[y]![x]!);
    scan((x, y) => modules[y]![x]!);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) total += 3;
      }
    }
    const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
    total += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return total;
  }
}

/** Encodes `text` (UTF-8) as a QR code at the smallest version that fits, error correction level M. */
export function encodeQr(text: string): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= MAX_VERSION) {
    const lengthBits = version < 10 ? 8 : 16;
    if (4 + lengthBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
    version++;
  }
  if (version > MAX_VERSION) throw new Error(`QR text too long (${bytes.length} bytes, the most is 213)`);
  const codewords = interleave(dataWords(bytes, version), version);
  let best: QrCode | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const b = new Builder(version);
    b.place(codewords);
    b.applyMask(mask);
    b.drawFormat(mask);
    const score = b.penalty();
    if (score < bestScore) {
      bestScore = score;
      best = { version, size: b.size, modules: b.modules, mask };
    }
  }
  return best!;
}

/** A standalone SVG of the code with a 4-module quiet zone (the dark modules as one path). */
export function qrSvg(qr: QrCode, dark = "#000", light = "#fff"): string {
  const q = 4;
  const n = qr.size + q * 2;
  let d = "";
  qr.modules.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x + q},${y + q}h1v1h-1z`;
    })
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
