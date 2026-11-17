import type { PageActionInput, PageActionName } from "./browser-backend.js";

/**
 * Argument parsing for `browser.act` (ATO-957). Pure: no backend, no
 * file system. Bad arguments throw with a message that names the fix, so
 * a small model can correct the call on the next step.
 */

export const PAGE_ACTIONS: readonly PageActionName[] = [
  "select",
  "upload",
  "back",
  "forward",
  "key",
  "hover",
  "dialog",
  "wait",
];

const REF_PATTERN = /^[a-zA-Z0-9]+$/;
export const MAX_SELECT_VALUES = 20;
export const MAX_UPLOAD_FILES = 10;
/** A fixed pause is capped: longer waits should wait for something. */
export const MAX_WAIT_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 30_000;
const MAX_TEXT = 500;

const MODIFIER = "(?:Alt|Control|Meta|Shift|ControlOrMeta)";
const KEY_NAME =
  "(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Escape|Tab|Backspace|Delete|Insert|Space|" +
  "ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)";
/** `Enter`, `Escape`, `Control+a`, `Shift+Tab`: Playwright's `press` syntax, a closed set. */
const KEY_PATTERN = new RegExp(`^(?:${MODIFIER}\\+){0,3}${KEY_NAME}$`);

function fail(message: string): never {
  throw new Error(`browser.act: ${message}`);
}

function parseRef(value: unknown, action: string): string {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    fail(`\`${action}\` needs \`ref\`, an alphanumeric ref (e.g. e12) from the latest snapshot`);
  }
  return value;
}

function optionalRef(value: unknown, action: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseRef(value, action);
}

/** A string or a list of strings; a lone string becomes a one-item list. */
function parseStringList(value: unknown, field: string, max: number): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    fail(`\`${field}\` must be a non-empty string or list of strings`);
  }
  if (list.length > max) fail(`\`${field}\` takes at most ${max} items`);
  return list.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      fail(`every \`${field}\` item must be a non-empty string`);
    }
    return item;
  });
}

function parseState(value: unknown): "visible" | "hidden" {
  if (value === undefined || value === null) return "visible";
  if (value === "visible" || value === "hidden") return value;
  return fail('`state` must be "visible" or "hidden"');
}

function parseTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_WAIT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail("`timeoutMs` must be a positive number");
  }
  return Math.min(Math.trunc(value), MAX_WAIT_TIMEOUT_MS);
}

function parseWait(args: Record<string, unknown>): PageActionInput {
  const text = args.text;
  if (typeof text === "string" && text.trim().length > 0) {
    if (text.length > MAX_TEXT) fail(`\`text\` is longer than ${MAX_TEXT} characters`);
    return { action: "wait", text, state: parseState(args.state), timeoutMs: parseTimeout(args.timeoutMs) };
  }
  const ref = optionalRef(args.ref, "wait");
  if (ref !== undefined) {
    return { action: "wait", ref, state: parseState(args.state), timeoutMs: parseTimeout(args.timeoutMs) };
  }
  const ms = args.ms;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return { action: "wait", ms: Math.min(Math.trunc(ms), MAX_WAIT_MS) };
  }
  return fail("`wait` needs `text` (wait for it to appear or, with state: \"hidden\", go), `ref`, or `ms` (a pause, at most 10000)");
}

export function parsePageAction(args: Record<string, unknown>): PageActionInput {
  const action = args.action;
  if (typeof action !== "string" || !(PAGE_ACTIONS as readonly string[]).includes(action)) {
    fail(`\`action\` must be one of ${PAGE_ACTIONS.join("|")}`);
  }
  switch (action as PageActionName) {
    case "select":
      return {
        action: "select",
        ref: parseRef(args.ref, "select"),
        values: parseStringList(args.values ?? args.value, "values", MAX_SELECT_VALUES),
      };
    case "upload":
      return {
        action: "upload",
        ref: parseRef(args.ref, "upload"),
        paths: parseStringList(args.paths ?? args.path, "paths", MAX_UPLOAD_FILES),
      };
    case "back":
      return { action: "back" };
    case "forward":
      return { action: "forward" };
    case "key": {
      const key = args.key;
      if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
        fail("`key` must be one key, optionally with modifiers: Enter, Escape, Tab, ArrowDown, PageDown, Control+a, Shift+Tab…");
      }
      const ref = optionalRef(args.ref, "key");
      return ref === undefined ? { action: "key", key } : { action: "key", key, ref };
    }
    case "hover":
      return { action: "hover", ref: parseRef(args.ref, "hover") };
    case "dialog": {
      const accept = args.accept;
      if (typeof accept !== "boolean") fail("`dialog` needs `accept`: true (OK) or false (Cancel)");
      const text = args.text;
      if (text !== undefined && text !== null && typeof text !== "string") fail("`text` must be a string");
      if (typeof text === "string" && text.length > MAX_TEXT) fail(`\`text\` is longer than ${MAX_TEXT} characters`);
      return typeof text === "string" && accept
        ? { action: "dialog", accept: true, text }
        : { action: "dialog", accept };
    }
    case "wait":
      return parseWait(args);
  }
}

/**
 * The key that may send or submit what is focused: Enter (with any
 * modifiers, Control+Enter sends in many chat apps) or Space (presses a
 * focused button). Other keys move focus, scroll or edit.
 */
export function keyCommits(key: string): "enter" | "space" | null {
  const last = key.split("+").pop() ?? "";
  if (last === "Enter") return "enter";
  if (last === "Space") return "space";
  return null;
}
