/**
 * Read / write integration credentials.
 *
 * Values live in `<stateDir>/.env` (0600, atomic writes) via the
 * existing `setDotenvKey`, never in `config.json`. Reads go through
 * `process.env`, which `loadDotenvFromStateDir` has already populated,
 * so a value written here is visible to the next `getConfig()` consumer
 * without a bespoke cache.
 */

import { setDotenvKey } from "../config/dotenv-writer.js";
import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type {
  IntegrationDescriptor,
  IntegrationField,
} from "./integration-descriptor.js";

/**
 * Read one field's current value, or `undefined` when unset/blank.
 *
 * Config-backed fields are read from an already-loaded config object;
 * the caller supplies it so this stays a pure function and tests do
 * not need a state dir.
 */
export function readFieldValue(
  field: IntegrationField,
  env: NodeJS.ProcessEnv = process.env,
  config?: Record<string, unknown>,
): string | undefined {
  const raw =
    field.store === "config"
      ? readConfigPath(config, field.configPath)
      : field.envVar === undefined
        ? undefined
        : env[field.envVar];
  if (field.kind === "boolean") {
    // A toggle is always "present": off is a deliberate value, not an
    // empty field waiting to be filled in.
    return raw === true ? "on" : "off";
  }
  if (field.kind === "list") {
    // An empty list reads as unset, so `required` still means "the
    // operator has to fill this in" for a list field.
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.filter((e): e is string => typeof e === "string").join(", ");
  }
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Walk a dotted path, returning `undefined` at the first gap. */
export function readConfigPath(
  config: Record<string, unknown> | undefined,
  path: string | undefined,
): unknown {
  if (!config || !path) return undefined;
  let node: unknown = config;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Field keys of `descriptor` that currently hold a value. */
export function presentFieldKeys(
  descriptor: IntegrationDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  config?: Record<string, unknown>,
): Set<string> {
  const present = new Set<string>();
  for (const field of descriptor.fields) {
    if (readFieldValue(field, env, config) !== undefined) {
      present.add(field.key);
    }
  }
  return present;
}

/**
 * Render a value for display. Secrets become bullets so a shoulder-surf
 * or a screen-share never leaks one; the length is capped so a long key
 * cannot blow out the pane width.
 */
export function displayFieldValue(
  field: IntegrationField,
  value: string | undefined,
): string {
  if (value === undefined) return "—";
  if (!field.secret) return value;
  const masked = "•".repeat(Math.min(value.length, 32));
  return value.length > 32 ? `${masked}+${value.length - 32}` : masked;
}

export class IntegrationSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSecretError";
  }
}

/**
 * Persist a field value, or clear it when `value` is `null`.
 *
 * `process.env` is updated in the same breath so the live process sees
 * the change without a restart — otherwise the hub would report a key
 * as saved while every consumer still read the old one.
 */
export function writeFieldValue(
  stateDir: string,
  field: IntegrationField,
  value: string | null,
  env: NodeJS.ProcessEnv = process.env,
  userConfigFile?: string,
): void {
  let trimmed: string | null = null;
  if (value !== null) {
    trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new IntegrationSecretError(`${field.label} is empty`);
    }
    // A list validates per entry in `parseList` below — running a
    // single-id validator over the joined line would reject every
    // multi-entry value.
    if (field.kind !== "list") {
      const invalid = field.validate?.(trimmed);
      if (invalid !== undefined) throw new IntegrationSecretError(invalid);
    }
  }

  if (field.kind === "boolean") {
    if (!userConfigFile || !field.configPath) {
      throw new IntegrationSecretError(
        `${field.label} is a toggle but no config path was supplied`,
      );
    }
    writeConfigPath(userConfigFile, field.configPath, trimmed === "on");
    return;
  }

  if (field.kind === "list") {
    if (!userConfigFile || !field.configPath) {
      throw new IntegrationSecretError(
        `${field.label} is a list but no config path was supplied`,
      );
    }
    writeConfigPath(userConfigFile, field.configPath, parseList(field, trimmed));
    return;
  }

  if (field.store === "config") {
    if (!userConfigFile || !field.configPath) {
      throw new IntegrationSecretError(
        `${field.label} is config-backed but no config path was supplied`,
      );
    }
    writeConfigPath(userConfigFile, field.configPath, trimmed);
    return;
  }

  const envVar = field.envVar;
  if (envVar === undefined) {
    throw new IntegrationSecretError(
      `${field.label} has no env var to store it in`,
    );
  }
  if (trimmed === null) {
    setDotenvKey(stateDir, envVar, null);
    delete env[envVar];
    return;
  }
  setDotenvKey(stateDir, envVar, trimmed);
  env[envVar] = trimmed;
}

/**
 * Split one comma-separated line into the entries a `list` field
 * stores, validating each on its own so the message names the entry
 * that is wrong. Whitespace and empty slots (a trailing comma, a
 * double comma) are forgiving — those are typing, not intent.
 *
 * `writeFieldValue` has already run `field.validate` over the whole
 * line for a text field; for a list it must NOT, because a validator
 * written for one id can never match a joined line. That is why the
 * per-entry pass lives here.
 */
function parseList(field: IntegrationField, raw: string | null): string[] {
  if (raw === null) return [];
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    throw new IntegrationSecretError(`${field.label} is empty`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const invalid = field.validate?.(entry);
    if (invalid !== undefined) {
      throw new IntegrationSecretError(`${entry}: ${invalid}`);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Set a dotted path in `config.json`, re-validating the whole file
 * first so a stale on-disk schema cannot ride in on this edit, then
 * dropping the config cache so the next `getConfig()` sees it.
 */
function writeConfigPath(
  userConfigFile: string,
  path: string,
  value: string | string[] | boolean | null,
): void {
  const prev = ensureUserConfigFileSync(userConfigFile) as unknown as Record<
    string,
    unknown
  >;
  const segments = path.split(".");
  const draft = structuredClone(prev);
  let node = draft as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null) {
      throw new IntegrationSecretError(`config path ${path} does not exist`);
    }
    node = next as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
  writeUserConfigFileSync(userConfigFile, parseUserConfigFile(draft));
  resetConfigCache();
}
