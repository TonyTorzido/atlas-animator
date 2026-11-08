/*
 * Atlas Animator: original implementation.
 *
 * Loading `atlas-anim` documents: version detection, the migration table, structural validation
 * (zod), cross-reference validation, and errors that name the exact document path at fault.
 */
import type { ZodIssue } from "zod";
import { animDocumentSchema, FORMAT_NAME, FORMAT_VERSION, type AnimDocument } from "./format.js";
import { findReferenceIssues, type FormatIssue, type IssuePath } from "./formatReferences.js";

export type { FormatIssue, IssuePath, IssueSeverity } from "./formatReferences.js";

/** A raw JSON object as read from disk. */
export type RawDocument = Record<string, unknown>;

/**
 * Upgrades a document of version n to version n + 1. Receives a private deep copy, so it may
 * mutate and return its argument. The loader rewrites `format` after each step.
 */
export type Migration = (doc: RawDocument) => RawDocument;

/**
 * MIGRATIONS[n] upgrades version n to n + 1. Empty while version 1 is the only version (the Phase
 * additions, mesh groups, skin contours and coverage, drivenGrids, are optional fields, so
 * version 1 documents load unchanged and need no migration); every
 * future format change adds an entry here together with a fixture of the old version.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

export interface LoadOptions {
  /** Defaults to MIGRATIONS (tests inject their own). */
  migrations?: Readonly<Record<number, Migration>>;
}

/**
 * ok: no errors (there may be warnings). Not ok: at least one error; `issues` holds the errors and
 * any warnings found alongside them.
 */
export type LoadResult =
  | {
      ok: true;
      document: AnimDocument;
      /** Version the input was written in. */
      sourceVersion: number;
      warnings: FormatIssue[];
    }
  | { ok: false; issues: FormatIssue[] };

const FORMAT_PATTERN = new RegExp(`^${FORMAT_NAME}@(\\d+)$`);

/** Parses, upgrades and validates a document that has already been JSON-decoded. */
export function parseAnimDocument(raw: unknown, options: LoadOptions = {}): LoadResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const currentVersion = FORMAT_VERSION;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure([], `expected a JSON object, got ${describe(raw)}`);
  }
  const version = readVersion((raw as RawDocument)["format"]);
  if (typeof version === "string") return failure(["format"], version);
  if (version > currentVersion) {
    return failure(
      ["format"],
      `document is ${FORMAT_NAME}@${version}, newer than this build understands (${FORMAT_NAME}@${currentVersion}); update Atlas Animator`
    );
  }

  let doc = structuredClone(raw) as RawDocument;
  for (let from = version; from < currentVersion; from++) {
    const migrate = migrations[from];
    if (!migrate) return failure(["format"], `no migration from ${FORMAT_NAME}@${from} to ${FORMAT_NAME}@${from + 1}`);
    doc = migrate(doc);
    doc["format"] = `${FORMAT_NAME}@${from + 1}`;
  }

  const parsed = animDocumentSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(fromZodIssue) };
  const references = findReferenceIssues(parsed.data);
  if (references.some((issue) => issue.severity === "error")) {
    // Errors first, then warnings, each in document order.
    const errors = references.filter((issue) => issue.severity === "error");
    return { ok: false, issues: [...errors, ...references.filter((issue) => issue.severity === "warning")] };
  }
  return { ok: true, document: parsed.data, sourceVersion: version, warnings: references };
}

/** Parses JSON text, then behaves like parseAnimDocument. */
export function parseAnimDocumentJson(text: string, options: LoadOptions = {}): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return failure([], `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseAnimDocument(raw, options);
}

/** Thrown by loadAnimDocument (errors only); `issues` holds every issue, `message` lists them one per line. */
export class AnimFormatError extends Error {
  readonly issues: readonly FormatIssue[];

  constructor(issues: readonly FormatIssue[], source?: string) {
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const header = `${source ? `${source}: ` : ""}invalid ${FORMAT_NAME} document (${errors} error${errors === 1 ? "" : "s"})`;
    super([header, ...issues.map((issue) => `  ${formatIssue(issue)}`)].join("\n"));
    this.name = "AnimFormatError";
    this.issues = issues;
  }
}

/**
 * Like parseAnimDocument but returns the document or throws AnimFormatError. Throws only on
 * errors; warnings are ignored here (use parseAnimDocument to see them).
 */
export function loadAnimDocument(raw: unknown, options: LoadOptions & { source?: string } = {}): AnimDocument {
  const result = typeof raw === "string" ? parseAnimDocumentJson(raw, options) : parseAnimDocument(raw, options);
  if (!result.ok) throw new AnimFormatError(result.issues, options.source);
  return result.document;
}

/** `bones[3].parent`, `animations.idle.bones["odd name"].rotate[0].time`, or `(document)`. */
export function formatIssuePath(path: IssuePath): string {
  if (path.length === 0) return "(document)";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

export function formatIssue(issue: FormatIssue): string {
  return `${issue.severity === "warning" ? "warning: " : ""}${formatIssuePath(issue.path)}: ${issue.message}`;
}

function readVersion(format: unknown): number | string {
  if (typeof format !== "string") return `missing or non-string 'format'; expected "${FORMAT_NAME}@<version>"`;
  const match = FORMAT_PATTERN.exec(format);
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    return `unknown format "${format}"; expected "${FORMAT_NAME}@<version>"`;
  }
  return version;
}

function fromZodIssue(issue: ZodIssue): FormatIssue {
  const error = (message: string): FormatIssue => ({ path: issue.path, message, severity: "error" });
  if (issue.code === "unrecognized_keys") {
    return error(`unknown field${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((key) => `'${key}'`).join(", ")}`);
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") return error(`required ${issue.expected} is missing`);
  return error(issue.message);
}

function failure(path: IssuePath, message: string): LoadResult {
  return { ok: false, issues: [{ path, message, severity: "error" }] };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
