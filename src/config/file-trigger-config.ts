import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parseNonEmptyString } from "./config-primitives.js";

/**
 * A file or log line that wakes the agent up (ATO-441). Each entry under
 * the `fileTriggers` block of `config.json` watches one path from the
 * process that leads the scheduler and files a task, the same way a
 * webhook hit does, when a file appears, changes, or a new line in a
 * watched log contains `contains`.
 *
 *  - `path`: an absolute (or `~/`) file or directory. The home directory
 *    itself, its parents and a filesystem root are refused when the
 *    watcher starts, not here: config loading does no filesystem work.
 *  - `glob`: optional pattern matched against the path relative to a
 *    watched directory (`*.pdf`, `logs/*.log`). Ignored for a file path.
 *  - `events`: `add` (a new file) and/or `change` (an existing file
 *    grew or was rewritten). Default `["add"]`.
 *  - `contains`: optional substring. With it, a `change` only fires when
 *    a line appended since the last look contains it; only the new
 *    bytes are read.
 *  - `debounceMs`: quiet time after the last event for a file before it
 *    is handled, so a file still being copied fires once.
 *  - `userMessageTemplate`: the task's prompt; `{{path}}`,
 *    `{{relativePath}}`, `{{name}}`, `{{event}}`, `{{trigger}}` and
 *    `{{lines}}` (the matching lines) are filled in.
 *  - `sessionId`: optional fixed session for every task; absent means a
 *    fresh session per task (the webhook `ephemeral` mode).
 *  - `depth` / `maxFiles`: how deep and how many files one watcher may
 *    cover. Past `maxFiles` the watcher stops with a warning.
 */
export type FileTriggerEvent = "add" | "change";

export interface FileTriggerConfig {
  path: string;
  glob?: string;
  events: FileTriggerEvent[];
  contains?: string;
  debounceMs: number;
  userMessageTemplate: string;
  sessionId?: string;
  depth: number;
  maxFiles: number;
  enabled: boolean;
}

export const FILE_TRIGGER_DEFAULTS = {
  debounceMs: 1_000,
  depth: 2,
  maxFiles: 1_000,
} as const;

/** Hard bounds. A larger value is a validation error, not a silent clamp. */
export const FILE_TRIGGER_LIMITS = {
  maxDebounceMs: 600_000,
  maxDepth: 8,
  maxFiles: 10_000,
  maxContainsLength: 1_000,
} as const;

const EVENTS: readonly FileTriggerEvent[] = ["add", "change"];

/** Validate and normalise the keyed `fileTriggers` block. */
export function parseFileTriggerMap(
  raw: unknown,
  field: string,
): Record<string, FileTriggerConfig> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, FileTriggerConfig> = {};
  for (const [name, rawCfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        "file trigger name must match [a-zA-Z0-9_-]+",
      );
    }
    if (rawCfg === null || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        `expected object, got ${JSON.stringify(rawCfg)}`,
      );
    }
    out[name] = parseOne(rawCfg as Record<string, unknown>, `${field}.${name}`);
  }
  return out;
}

function parseOne(cfg: Record<string, unknown>, at: string): FileTriggerConfig {
  const path = parseNonEmptyString(cfg.path, `${at}.path`);
  if (!path.startsWith("/") && !path.startsWith("~") && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("\\\\")) {
    throw new ConfigValidationError(`${at}.path`, "expected an absolute path or one starting with ~/");
  }
  const userMessageTemplate = parseNonEmptyString(
    cfg.userMessageTemplate,
    `${at}.userMessageTemplate`,
  );
  const glob = optionalString(cfg.glob, `${at}.glob`);
  const contains = optionalString(cfg.contains, `${at}.contains`);
  if (contains !== undefined && contains.length > FILE_TRIGGER_LIMITS.maxContainsLength) {
    throw new ConfigValidationError(
      `${at}.contains`,
      `expected at most ${FILE_TRIGGER_LIMITS.maxContainsLength} characters`,
    );
  }
  const sessionId = optionalString(cfg.sessionId, `${at}.sessionId`);
  return {
    path,
    ...(glob !== undefined ? { glob } : {}),
    events: parseEvents(cfg.events, `${at}.events`),
    ...(contains !== undefined ? { contains } : {}),
    debounceMs: boundedInt(cfg.debounceMs, `${at}.debounceMs`, 0, FILE_TRIGGER_LIMITS.maxDebounceMs, FILE_TRIGGER_DEFAULTS.debounceMs),
    userMessageTemplate,
    ...(sessionId !== undefined ? { sessionId } : {}),
    depth: boundedInt(cfg.depth, `${at}.depth`, 0, FILE_TRIGGER_LIMITS.maxDepth, FILE_TRIGGER_DEFAULTS.depth),
    maxFiles: boundedInt(cfg.maxFiles, `${at}.maxFiles`, 1, FILE_TRIGGER_LIMITS.maxFiles, FILE_TRIGGER_DEFAULTS.maxFiles),
    enabled: cfg.enabled === undefined || cfg.enabled === null ? true : parseBool(cfg.enabled, `${at}.enabled`),
  };
}

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return parseNonEmptyString(raw, field);
}

function parseEvents(raw: unknown, field: string): FileTriggerEvent[] {
  if (raw === undefined || raw === null) return ["add"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(field, `expected a non-empty list of ${EVENTS.join("|")}`);
  }
  const out: FileTriggerEvent[] = [];
  for (const entry of raw) {
    if (!(EVENTS as readonly unknown[]).includes(entry)) {
      throw new ConfigValidationError(field, `expected ${EVENTS.join("|")}, got ${JSON.stringify(entry)}`);
    }
    if (!out.includes(entry as FileTriggerEvent)) out.push(entry as FileTriggerEvent);
  }
  return out;
}

function boundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new ConfigValidationError(field, `expected an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}
