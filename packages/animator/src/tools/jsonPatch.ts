/*
 * Atlas Animator: original implementation.
 *
 * RFC 6902 JSON Patch over plain JSON values, with an inverse recorded at apply time (plan 4.3:
 * every edit is a forward patch plus the patch that undoes it). Pure module (no Node, no DOM) so
 * the editor can use it in the browser.
 *
 * Inverses restore the document exactly, including object key order (which decides how the file
 * serialises): removing an object member that is not the last key is undone by replacing the
 * parent object, because an RFC 6902 `add` always appends the key.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PatchOperation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: JsonValue }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: JsonValue };

export class PatchError extends Error {
  constructor(
    message: string,
    readonly operationIndex: number | null = null
  ) {
    super(message);
    this.name = "PatchError";
  }
}

// ---------------------------------------------------------------------------------------------
// JSON pointers (RFC 6901)
// ---------------------------------------------------------------------------------------------

export function escapePointerToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Builds a JSON pointer from raw tokens: pointer("skins", "body") === "/skins/body". */
export function pointer(...tokens: (string | number)[]): string {
  return tokens.map((token) => `/${escapePointerToken(token)}`).join("");
}

export function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new PatchError(`JSON pointer '${path}' must be empty or start with '/'`);
  return path
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~[^01]|~$/.test(token)) throw new PatchError(`JSON pointer '${path}' has an invalid '~' escape`);
      return token.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(token: string, length: number, allowEnd: boolean, path: string): number {
  if (allowEnd && token === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new PatchError(`'${token}' in '${path}' is not an array index`);
  const index = Number(token);
  if (index > length || (!allowEnd && index === length)) throw new PatchError(`index ${index} in '${path}' is out of range (length ${length})`);
  return index;
}

/** Value at a JSON pointer, or undefined when the path does not exist. */
export function getAt(doc: JsonValue, path: string): JsonValue | undefined {
  let node: JsonValue | undefined = doc;
  for (const token of parsePointer(path)) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      node = node[Number(token)];
    } else if (isObject(node)) {
      node = Object.prototype.hasOwnProperty.call(node, token) ? node[token] : undefined;
    } else {
      return undefined;
    }
  }
  return node;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => jsonEqual(value, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Apply with inverse
// ---------------------------------------------------------------------------------------------

interface Holder {
  /** A box whose `value` is the document root, so the root can be replaced like any member. */
  root: { value: JsonValue };
}

function parentOf(holder: Holder, tokens: string[], path: string): { parent: JsonValue[] | JsonObject; key: string } {
  if (tokens.length === 0) return { parent: holder.root as unknown as JsonObject, key: "value" };
  let node: JsonValue = holder.root.value;
  for (const token of tokens.slice(0, -1)) {
    let next: JsonValue | undefined;
    if (Array.isArray(node)) next = node[arrayIndex(token, node.length, false, path)];
    else if (isObject(node)) next = Object.prototype.hasOwnProperty.call(node, token) ? node[token] : undefined;
    if (next === undefined) throw new PatchError(`path '${path}' does not exist (missing '${token}')`);
    node = next;
  }
  if (!Array.isArray(node) && !isObject(node)) throw new PatchError(`path '${path}' goes through a ${node === null ? "null" : typeof node}`);
  return { parent: node, key: tokens[tokens.length - 1] as string };
}

/** Applies one add/remove/replace in place and returns the operations that undo it, in order. */
function applyPrimitive(holder: Holder, operation: PatchOperation): PatchOperation[] {
  const { path } = operation;
  const tokens = parsePointer(path);
  const { parent, key } = parentOf(holder, tokens, path);
  const parentPath = pointer(...tokens.slice(0, -1).map((t) => t));
  if (Array.isArray(parent)) {
    switch (operation.op) {
      case "add": {
        const index = arrayIndex(key, parent.length, true, path);
        parent.splice(index, 0, cloneJson(operation.value));
        return [{ op: "remove", path: `${parentPath}/${index}` }];
      }
      case "remove": {
        const index = arrayIndex(key, parent.length, false, path);
        const [old] = parent.splice(index, 1) as [JsonValue];
        return [{ op: "add", path: `${parentPath}/${index}`, value: old }];
      }
      case "replace": {
        const index = arrayIndex(key, parent.length, false, path);
        const old = parent[index] as JsonValue;
        parent[index] = cloneJson(operation.value);
        return [{ op: "replace", path: `${parentPath}/${index}`, value: old }];
      }
      default:
        throw new PatchError(`internal: '${operation.op}' is not a primitive`);
    }
  }
  const exists = Object.prototype.hasOwnProperty.call(parent, key);
  switch (operation.op) {
    case "add":
    case "replace": {
      if (operation.op === "replace" && !exists) throw new PatchError(`cannot replace '${path}': it does not exist`);
      const old = exists ? parent[key] : undefined;
      parent[key] = cloneJson(operation.value);
      if (tokens.length === 0) return [{ op: "replace", path: "", value: old as JsonValue }];
      return old === undefined ? [{ op: "remove", path }] : [{ op: "replace", path, value: old }];
    }
    case "remove": {
      if (tokens.length === 0) throw new PatchError("cannot remove the document root");
      if (!exists) throw new PatchError(`cannot remove '${path}': it does not exist`);
      const keys = Object.keys(parent);
      const last = keys[keys.length - 1] === key;
      const before = last ? null : cloneJson(parent);
      const old = parent[key] as JsonValue;
      delete parent[key];
      // Re-adding a key appends it; restore the parent whole when the key was not last.
      return before ? [{ op: "replace", path: parentPath, value: before }] : [{ op: "add", path, value: old }];
    }
    default:
      throw new PatchError(`internal: '${operation.op}' is not a primitive`);
  }
}

function applyOne(holder: Holder, operation: PatchOperation): PatchOperation[] {
  switch (operation.op) {
    case "add":
    case "remove":
    case "replace":
      return applyPrimitive(holder, operation);
    case "test": {
      const actual = getAt(holder.root.value, operation.path);
      if (!jsonEqual(actual, operation.value)) throw new PatchError(`test failed at '${operation.path}'`);
      return [];
    }
    case "copy":
    case "move": {
      const value = getAt(holder.root.value, operation.from);
      if (value === undefined) throw new PatchError(`'${operation.op}' source '${operation.from}' does not exist`);
      if (operation.op === "move" && (operation.path + "/").startsWith(operation.from + "/") && operation.path !== operation.from) {
        throw new PatchError(`cannot move '${operation.from}' into its own child '${operation.path}'`);
      }
      if (operation.op === "move" && operation.path === operation.from) return [];
      const undo: PatchOperation[] = [];
      if (operation.op === "move") undo.unshift(...applyPrimitive(holder, { op: "remove", path: operation.from }));
      undo.unshift(...applyPrimitive(holder, { op: "add", path: operation.path, value: cloneJson(value) }));
      return undo;
    }
    default: {
      const unknown = operation as { op?: unknown };
      throw new PatchError(`unknown patch op '${String(unknown.op)}'`);
    }
  }
}

export interface PatchResult {
  /** The patched document (the input is not modified). */
  doc: JsonValue;
  /** Applying this to `doc` gives back the input exactly. */
  inverse: PatchOperation[];
}

/**
 * Applies a patch atomically: on any failing operation nothing is changed and a PatchError names
 * the operation. The input document is never modified.
 */
export function applyPatch(doc: JsonValue, patch: readonly PatchOperation[]): PatchResult {
  const holder: Holder = { root: { value: cloneJson(doc) } };
  const inverse = applyPatchInPlace(holder, patch);
  return { doc: holder.root.value, inverse };
}

/**
 * Applies a patch to a document the caller owns, in place where possible, and returns the new
 * root (a root replace swaps it) and the inverse. On failure the document may be partly patched,
 * so callers that need atomicity use applyPatch or apply the returned partial inverse.
 */
export function applyPatchMutable(doc: JsonValue, patch: readonly PatchOperation[]): PatchResult {
  const holder: Holder = { root: { value: doc } };
  const inverse = applyPatchInPlace(holder, patch);
  return { doc: holder.root.value, inverse };
}

function applyPatchInPlace(holder: Holder, patch: readonly PatchOperation[]): PatchOperation[] {
  const inverse: PatchOperation[] = [];
  patch.forEach((operation, i) => {
    try {
      inverse.unshift(...applyOne(holder, operation));
    } catch (error) {
      if (error instanceof PatchError) throw new PatchError(`patch operation ${i} (${operation.op} ${operation.path}): ${error.message}`, i);
      throw error;
    }
  });
  return inverse;
}

/** Structural check of untrusted patch input (from scripts and the bridge). */
export function parsePatch(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new PatchError("a patch must be an array of operations");
  return value.map((entry: unknown, i) => {
    if (typeof entry !== "object" || entry === null) throw new PatchError(`patch operation ${i} must be an object`, i);
    const op = entry as Record<string, unknown>;
    if (typeof op.path !== "string") throw new PatchError(`patch operation ${i} needs a string 'path'`, i);
    switch (op.op) {
      case "add":
      case "replace":
      case "test":
        if (!("value" in op)) throw new PatchError(`patch operation ${i} (${op.op}) needs a 'value'`, i);
        return { op: op.op, path: op.path, value: op.value as JsonValue };
      case "remove":
        return { op: "remove", path: op.path };
      case "move":
      case "copy":
        if (typeof op.from !== "string") throw new PatchError(`patch operation ${i} (${op.op}) needs a string 'from'`, i);
        return { op: op.op, from: op.from, path: op.path };
      default:
        throw new PatchError(`patch operation ${i} has unknown op '${String(op.op)}'`, i);
    }
  });
}
