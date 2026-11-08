/*
 * Atlas Animator: original implementation.
 *
 * File-backed documents and the append-only command log (plan 4.3). Every write to a document
 * goes through `applyToFile` (or undo/redo), which appends one log entry per batch to
 * `<name>.anim.log.ndjson` beside the document BEFORE writing the document, so a crash between
 * the two is repaired on the next open by re-applying the logged patch.
 *
 * Log entry kinds: `create` (new document), `apply` (a command batch), `undo` / `redo` (the
 * inverse / forward patch of an earlier apply), `external` (the file changed outside the bus:
 * recorded so the history stays honest; undo stops there). Each entry carries the hashes of the
 * document text before and after it, so the log can prove it matches the file.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { applyCommands, type ApplyOptions, type Command, type CommandNote } from "./commands.js";
import { applyPatch, type JsonObject, type JsonValue, type PatchOperation } from "./jsonPatch.js";

export type LogKind = "create" | "apply" | "undo" | "redo" | "external";

export interface LogEntry {
  seq: number;
  time: string;
  kind: LogKind;
  /** Who wrote it: "cli", "bridge", "editor", ... */
  source: string;
  /** apply / create: the commands of the batch. */
  commands?: Command[];
  /** undo / redo: the seq of the apply entry undone or redone. */
  target?: number;
  patch: PatchOperation[];
  inverse: PatchOperation[];
  /** Hash of the document text before and after this entry ("" = no file). */
  before: string;
  after: string;
}

export interface StoredDocument {
  path: string;
  doc: JsonObject;
  text: string;
  hash: string;
  /** Indentation detected in the file and reused on save. */
  indent: number;
}

export const logPathFor = (documentPath: string) => `${documentPath.replace(/\.json$/i, "")}.log.ndjson`;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function serializeDocument(doc: JsonValue, indent = 1): string {
  return `${JSON.stringify(doc, null, indent)}\n`;
}

function detectIndent(text: string): number {
  const match = /\n( +)\S/.exec(text);
  return match ? Math.min((match[1] as string).length, 8) : 1;
}

export function readDocument(path: string): StoredDocument {
  const text = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`${path}: a document must be a JSON object`);
  return { path, doc: doc as JsonObject, text, hash: hashText(text), indent: detectIndent(text) };
}

export function readLog(documentPath: string): LogEntry[] {
  const logPath = logPathFor(documentPath);
  if (!existsSync(logPath)) return [];
  const entries: LogEntry[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // A torn last line (crash mid-append) is ignored; every complete line is kept.
    }
  }
  return entries;
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

function append(documentPath: string, entry: Omit<LogEntry, "seq" | "time">, log: LogEntry[]): LogEntry {
  const full: LogEntry = { seq: (log[log.length - 1]?.seq ?? 0) + 1, time: new Date().toISOString(), ...entry };
  const logPath = logPathFor(documentPath);
  // A torn last line (crash mid-append) must not swallow this entry: start on a fresh line.
  let torn = false;
  if (existsSync(logPath) && statSync(logPath).size > 0) {
    const fd = openSync(logPath, "r");
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, statSync(logPath).size - 1);
    closeSync(fd);
    torn = last[0] !== 0x0a;
  }
  appendFileSync(logPath, `${torn ? "\n" : ""}${JSON.stringify(full)}\n`);
  log.push(full);
  return full;
}

export interface OpenResult {
  stored: StoredDocument;
  log: LogEntry[];
  /** What open had to do to make log and file agree: nothing, a crash repair, or an external-edit entry. */
  repaired: "none" | "recovered" | "external";
}

/**
 * Opens a document with its log and reconciles them: if the file is the state before the last
 * entry (the crash window between log append and file write), the entry's patch is re-applied;
 * if it is anything else, an `external` entry records the change.
 */
export function openDocument(path: string, source = "cli"): OpenResult {
  const stored = readDocument(path);
  const log = readLog(path);
  const last = log[log.length - 1];
  if (!last || last.after === stored.hash) return { stored, log, repaired: "none" };
  if (last.before === stored.hash) {
    const doc = applyPatch(stored.doc, last.patch).doc as JsonObject;
    const text = serializeDocument(doc, stored.indent);
    if (hashText(text) === last.after) {
      writeAtomic(path, text);
      return { stored: { ...stored, doc, text, hash: last.after }, log, repaired: "recovered" };
    }
  }
  append(path, { kind: "external", source, patch: [], inverse: [], before: last.after, after: stored.hash }, log);
  return { stored, log, repaired: "external" };
}

export interface WriteResult {
  entry: LogEntry;
  doc: JsonObject;
  text: string;
  repaired: OpenResult["repaired"];
  /** Pose-limit warnings of the batch (options.limits "warn"). */
  limitWarnings?: string[];
  /** Command notes of the batch (`weights.auto` domains and ambiguity). */
  notes?: CommandNote[];
}

function commit(open: OpenResult, entry: Omit<LogEntry, "seq" | "time" | "before" | "after">, doc: JsonObject): WriteResult {
  const text = serializeDocument(doc, open.stored.indent);
  const written = append(open.stored.path, { ...entry, before: open.stored.hash, after: hashText(text) }, open.log);
  writeAtomic(open.stored.path, text);
  return { entry: written, doc, text, repaired: open.repaired };
}

/** Applies a command batch to a document file through the log (atomic: nothing is written on error). */
export function applyToFile(path: string, commands: readonly Command[], options: ApplyOptions & { source?: string } = {}): WriteResult {
  const open = openDocument(path, options.source);
  const result = applyCommands(open.stored.doc, commands, options);
  const written = commit(open, { kind: "apply", source: options.source ?? "cli", commands: [...commands], patch: result.patch, inverse: result.inverse }, result.doc);
  return { ...written, limitWarnings: result.limitWarnings, notes: result.notes };
}

/** Creates a new document file (refuses to overwrite) with a `create` entry starting its log. */
export function createDocumentFile(path: string, commands: readonly Command[], source = "cli"): WriteResult {
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const result = applyCommands({}, commands, { check: "end" });
  const text = serializeDocument(result.doc);
  const log = readLog(path);
  const entry = append(path, { kind: "create", source, commands: [...commands], patch: result.patch, inverse: [], before: "", after: hashText(text) }, log);
  writeAtomic(path, text);
  return { entry, doc: result.doc, text, repaired: "none" };
}

/** Undo and redo stacks implied by a log (seqs of apply entries). Create and external entries are barriers. */
export function historyOf(log: readonly LogEntry[]): { undo: number[]; redo: number[] } {
  const undo: number[] = [];
  let redo: number[] = [];
  for (const entry of log) {
    if (entry.kind === "apply") {
      undo.push(entry.seq);
      redo = [];
    } else if (entry.kind === "undo") {
      const seq = undo.pop();
      if (seq !== undefined) redo.push(seq);
    } else if (entry.kind === "redo") {
      const seq = redo.pop();
      if (seq !== undefined) undo.push(seq);
    } else {
      undo.length = 0;
      redo = [];
    }
  }
  return { undo, redo };
}

/** Undoes (or redoes) up to `steps` batches; returns one write per step, latest first. */
export function stepHistory(path: string, direction: "undo" | "redo", steps = 1, source = "cli"): WriteResult[] {
  const results: WriteResult[] = [];
  for (let i = 0; i < steps; i++) {
    const open = openDocument(path, source);
    const history = historyOf(open.log);
    const seq = (direction === "undo" ? history.undo : history.redo).at(-1);
    if (seq === undefined) break;
    const target = open.log.find((entry) => entry.seq === seq) as LogEntry;
    const patch = direction === "undo" ? target.inverse : target.patch;
    const inverse = direction === "undo" ? target.patch : target.inverse;
    const doc = applyPatch(open.stored.doc, patch).doc as JsonObject;
    results.push(commit(open, { kind: direction, source, target: seq, patch, inverse }, doc));
  }
  return results;
}
