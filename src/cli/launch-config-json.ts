/**
 * ATO-2448: set and undo a few keys in a CLI's JSON settings file, the
 * way `ollama launch --config` edits `~/.claude/settings.json` and
 * `opencode.json`. Pure: text in, text out, plus a record of what each key
 * held before, so `--revert` puts back exactly that and leaves every other
 * key, and any key the person changed since, alone.
 */

export interface JsonEdit {
  /** Key path from the top, e.g. `["env", "ANTHROPIC_BASE_URL"]`. */
  readonly path: readonly string[];
  readonly value: unknown;
}

/** What one edit replaced: `had: false` when the key did not exist. */
export interface JsonUndo {
  readonly path: readonly string[];
  readonly had: boolean;
  readonly before?: unknown;
  /** What was written, to tell whether the person changed it since. */
  readonly written: unknown;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed file: `{}` for none or an empty one; an error for comments or broken JSON. */
export function parseSettings(text: string | null): JsonObject | { error: string } {
  if (text === null || text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : { error: "its top level is not a JSON object" };
  } catch {
    return { error: "it is not plain JSON (comments or a syntax error)" };
  }
}

function lookup(root: JsonObject, path: readonly string[]): { had: boolean; value?: unknown } {
  let node: unknown = root;
  for (const key of path) {
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return { had: false };
    node = node[key];
  }
  return { had: true, value: node };
}

function place(root: JsonObject, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key] as JsonObject;
  }
  node[path[path.length - 1] as string] = value;
}

function remove(root: JsonObject, path: readonly string[]): void {
  const parents: JsonObject[] = [];
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node[key])) return;
    parents.push(node);
    node = node[key] as JsonObject;
  }
  delete node[path[path.length - 1] as string];
  // Drop an object this edit emptied (`env: {}`), innermost first.
  for (let i = path.length - 2; i >= 0; i--) {
    const parent = parents[i] as JsonObject;
    const key = path[i] as string;
    if (isObject(parent[key]) && Object.keys(parent[key] as JsonObject).length === 0) delete parent[key];
    else break;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function serializeSettings(root: JsonObject): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Apply the edits; the undo list holds what each key had before. */
export function applyJsonEdits(root: JsonObject, edits: readonly JsonEdit[]): { root: JsonObject; undo: JsonUndo[] } {
  const next = structuredClone(root);
  const undo: JsonUndo[] = [];
  for (const edit of edits) {
    const was = lookup(next, edit.path);
    undo.push(was.had ? { path: edit.path, had: true, before: was.value, written: edit.value } : { path: edit.path, had: false, written: edit.value });
    place(next, edit.path, edit.value);
  }
  return { root: next, undo };
}

/**
 * Undo, last edit first. A key whose value is no longer what was written
 * (the person changed it) is left as it is and named in `kept`.
 */
export function revertJsonEdits(root: JsonObject, undo: readonly JsonUndo[]): { root: JsonObject; kept: string[] } {
  const next = structuredClone(root);
  const kept: string[] = [];
  for (const step of [...undo].reverse()) {
    const now = lookup(next, step.path);
    if (!now.had || !same(now.value, step.written)) {
      kept.push(step.path.join("."));
      continue;
    }
    if (step.had) place(next, step.path, step.before);
    else remove(next, step.path);
  }
  return { root: next, kept };
}
