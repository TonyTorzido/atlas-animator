/*
 * Atlas Animator editor: a small, dependency-free .zip writer and reader for the user's backups (Node; src/userData.ts).
 * Plain PKZIP (stored or deflated entries, UTF-8 names, no zip64: under 65 535 files and 4 GB), so Windows Explorer opens the backups too.
 * The writer streams to `<file>.partial` and renames at the end, so a half-written backup never looks like a finished one.
 */
import { open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { crc32, deflateRaw, inflateRawSync } from "node:zlib";

const deflate = promisify(deflateRaw);
/** Already-compressed formats are stored, not deflated again. */
const STORED = /\.(png|gif|jpe?g|webp|zip|psd)$/i;

export interface ZipInput {
  /** The name inside the zip (forward slashes, no leading slash). */
  name: string;
  /** Read from this file, or use `data`. */
  path?: string;
  data?: Buffer;
  mtime?: Date;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  mtime: Date;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function fromDos(time: number, date: number): Date {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** Writes a zip of `inputs` to `file` (atomic rename at the end). Returns the entry count and the zip size. */
export async function writeZip(file: string, inputs: Iterable<ZipInput>): Promise<{ files: number; bytes: number }> {
  const partial = `${file}.partial`;
  const fh = await open(partial, "w");
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  try {
    for (const input of inputs) {
      const name = Buffer.from(input.name.split(String.fromCharCode(92)).join("/").replace(/^\/+/, ""), "utf8");
      const raw = input.data ?? (await readFile(input.path!));
      const crc = crc32(raw) >>> 0;
      let method = 0;
      let body = raw;
      if (!STORED.test(input.name) && raw.length > 64) {
        const packed = await deflate(raw);
        if (packed.length < raw.length) {
          method = 8;
          body = packed;
        }
      }
      if (offset + body.length > 0xfffffff0 || count >= 0xfffe) throw new Error("backup too large for a plain zip (4 GB / 65 535 files)");
      const { time, date } = dosTime(input.mtime ?? new Date());
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await fh.write(Buffer.concat([local, name]));
      await fh.write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(body.length, 20);
      c.writeUInt32LE(raw.length, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(c, name);
      offset += 30 + name.length + body.length;
      count++;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    await fh.write(Buffer.concat([cd, end]));
    await fh.sync();
    await fh.close();
    await rename(partial, file);
    return { files: count, bytes: offset + cd.length + 22 };
  } catch (error) {
    await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
}

/** Reads every entry of a zip written by writeZip (or any plain stored/deflated zip). Checks each CRC. */
export function readZip(file: string): ZipEntry[] {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: broken zip directory`);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`${file}: ${name} uses an unsupported zip method ${method}`);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`${file}: ${name} is damaged (CRC mismatch)`);
    if (!name.endsWith("/")) out.push({ name, data, mtime: fromDos(time, date) });
  }
  return out;
}
