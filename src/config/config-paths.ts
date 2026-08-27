import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { USER_CONFIG_DEFAULTS } from "./config-schema.js";

/**
 * Dotted-key addressing for `atomic-agent config get|set|unset|list`.
 *
 * The shape of the config is derived from `USER_CONFIG_DEFAULTS` at
 * module load rather than hand-listed, so a new block in the schema
 * becomes addressable without touching this file.
 *
 * Deliberately absent: any notion of a *type* per key. `parseUserConfigFile`
 * already coerces strings ("false" → false, "19099" → 19099 via `parseBool`
 * / the numeric parsers), enforces bounds and enums, and reports failures
 * as `ConfigValidationError` with the dotted path already in the message.
 * A type table here would be a second source of truth that silently drifts
 * from the schema; instead `set` substitutes the raw string and lets the
 * schema decide. See `config-command.ts`.
 */

/** A leaf that `config set` can address, and its default value. */
export interface ConfigLeaf {
  /** Dotted path, e.g. `localModels.managed.autoUpdate`. */
  readonly key: string;
  /** Default value from `USER_CONFIG_DEFAULTS`. */
  readonly defaultValue: unknown;
  /**
   * True when the default is an array. Arrays have no single-token
   * spelling that would not be an invented mini-language (indices,
   * append syntax, separator escaping), so `set` refuses them and points
   * at the whole-file JSON form. `unset` still works — restoring the
   * default needs no syntax.
   */
  readonly isArray: boolean;
}

function buildIndex(): {
  leaves: Map<string, ConfigLeaf>;
  branches: Set<string>;
} {
  const leaves = new Map<string, ConfigLeaf>();
  const branches = new Set<string>();
  const walk = (node: Record<string, unknown>, prefix: string[]): void => {
    for (const [name, value] of Object.entries(node)) {
      const path = [...prefix, name];
      const key = path.join(".");
      // Arrays and null are leaves: `null` is a real value in this schema
      // (tri-state toggles, "no override"), not an empty branch to descend.
      if (value !== null && !Array.isArray(value) && typeof value === "object") {
        branches.add(key);
        walk(value as Record<string, unknown>, path);
        continue;
      }
      leaves.set(key, { key, defaultValue: value, isArray: Array.isArray(value) });
    }
  };
  walk(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>, []);
  return { leaves, branches };
}

const INDEX = buildIndex();

/**
 * `version` is owned by the schema's migration path
 * (`ensureUserConfigFileSync` bumps it); a user pinning it by hand
 * produces a file the migrator will disagree with, so it is not settable.
 */
const READ_ONLY_KEYS = new Set(["version"]);

/** Every addressable leaf, in declaration order. */
export function listConfigLeaves(): readonly ConfigLeaf[] {
  return [...INDEX.leaves.values()];
}

/** Look up a leaf by dotted key, or `undefined` if it is not one. */
export function findConfigLeaf(key: string): ConfigLeaf | undefined {
  return INDEX.leaves.get(key);
}

/** True when `key` names an object node (e.g. `localModels.managed`). */
export function isConfigBranch(key: string): boolean {
  return INDEX.branches.has(key);
}

/** True when `key` exists but the schema, not the user, owns its value. */
export function isReadOnlyConfigKey(key: string): boolean {
  return READ_ONLY_KEYS.has(key);
}

/**
 * Nearest known leaf to a typo, or `null` when nothing is close enough.
 *
 * The threshold is deliberately tight (edit distance <= 2, and never more
 * than a third of the key's length): a wrong suggestion sends the user
 * to edit a real but unintended setting, which is worse than no
 * suggestion at all.
 */
export function suggestConfigKey(key: string): string | null {
  const target = key.toLowerCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const leaf of INDEX.leaves.keys()) {
    const distance = editDistance(target, leaf.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = leaf;
    }
  }
  if (best === null) return null;
  const ceiling = Math.min(2, Math.floor(key.length / 3));
  return bestDistance <= ceiling ? best : null;
}

/** Levenshtein distance, two-row rolling table. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/**
 * Leaf names whose *values* would be secrets if this schema ever held
 * one. Today the config file stores only env var *names*
 * (`web.search.exa.apiKeyEnv`), with the secrets themselves in `.env` —
 * but `config get`/`list` print to a terminal that gets pasted into bug
 * reports, so the masking rule is in place before a real secret lands in
 * the schema and quietly gets printed.
 *
 * The name is matched on whole camelCase words of the last path segment,
 * in any position, so both `apiKeyEnv` and a future `authToken` are
 * caught. Name alone is not enough, though: `agent.tokenBudget` and
 * `memory.profile.maxTokens` are step counters that happen to contain
 * "token". The value's type is the tiebreaker — a number is a budget, a
 * non-empty string is the thing worth hiding — so masking is decided in
 * `formatConfigValue`, where the value is in hand.
 */
const SECRET_NAMES = new Set(["secret", "token", "apikey", "password"]);

/**
 * True when a leaf's name suggests its value is a credential. Callers
 * that print values should use {@link formatConfigValue}, which also
 * applies the value-type check described above.
 */
export function isSecretConfigKey(key: string): boolean {
  const last = key.slice(key.lastIndexOf(".") + 1);
  const words = last.split(/(?=[A-Z])/).map((word) => word.toLowerCase());
  if (words.some((word) => SECRET_NAMES.has(word))) return true;
  // `apiKey`/`apiKeyEnv`: the secret noun spans two camelCase words.
  return words.some(
    (word, i) => SECRET_NAMES.has(word + (words[i + 1] ?? "")),
  );
}

/** Render a value for `get`/`list`, masking anything secret-shaped. */
export function formatConfigValue(key: string, value: unknown): string {
  if (isSecretConfigKey(key) && typeof value === "string" && value.length > 0) {
    return "***";
  }
  return JSON.stringify(value);
}

/** Read a dotted path out of a config tree, or `undefined` if absent. */
export function readConfigPath(tree: unknown, key: string): unknown {
  let node: unknown = tree;
  for (const segment of key.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return undefined;
    }
    // Own properties only: a bare `[segment]` would happily return
    // `Object.prototype.constructor` for a key named "constructor",
    // reporting a value the config file does not contain.
    if (!Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Segments that must never be walked or assigned through. Writing to
 * `__proto__` mutates `Object.prototype` for the whole process, and
 * `constructor.prototype` reaches it the long way round.
 */
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Whether a dotted key is safe to walk. Exported for the callers' guards. */
export function isSafeConfigPath(key: string): boolean {
  return key.split(".").every((s) => !UNSAFE_PATH_SEGMENTS.has(s));
}

/**
 * Write `value` at a dotted path in a raw (on-disk) config tree,
 * creating intermediate objects as needed. Mutates `tree`.
 *
 * A non-object sitting where a branch must go (including an array, which
 * `typeof` calls "object") is replaced: it cannot be a valid parent, and
 * `parseUserConfigFile` will reject the result anyway if the shape is
 * wrong — nothing is written until it passes.
 *
 * Throws on a path containing `__proto__`, `constructor` or `prototype`.
 * Callers today filter keys through the schema allowlist first, so this is
 * unreachable from the CLI — but the guard lives here, next to the
 * assignment, rather than depending on every future caller validating as
 * strictly.
 */
export function writeConfigPath(
  tree: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!isSafeConfigPath(key)) {
    throw new Error(`config: refusing to write unsafe path ${key}`);
  }
  const segments = key.split(".");
  let node = tree;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (
      child === null ||
      typeof child !== "object" ||
      Array.isArray(child) ||
      !Object.hasOwn(node, segment)
    ) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

/**
 * Atomically write a *sparse* config tree — only the keys the user has
 * actually set — using the same tmp + rename discipline as
 * `writeUserConfigFileSync`.
 *
 * Separate from `writeUserConfigFileSync` on purpose: that one takes a
 * fully-defaulted `UserConfigFile`, which is right for the whole-file
 * `set` and for migration, but wrong for a point edit. Writing the
 * defaulted tree back would expand a hand-written four-line config into
 * every key in the schema and freeze today's defaults into the user's
 * file, so a later change to a default would silently not reach them.
 * The caller validates the tree through `parseUserConfigFile` first and
 * only reaches this function once that succeeds.
 */
export function writeRawUserConfigFileSync(
  path: string,
  tree: Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(tree, null, 2) + "\n";
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

/**
 * Delete a dotted path from a raw config tree, pruning any intermediate
 * objects the deletion leaves empty so `unset` does not accumulate
 * `{"memory":{"links":{}}}` husks. Returns true when something was removed.
 */
export function deleteConfigPath(
  tree: Record<string, unknown>,
  key: string,
): boolean {
  if (!isSafeConfigPath(key)) return false;
  const segments = key.split(".");
  const chain: Record<string, unknown>[] = [tree];
  let node: Record<string, unknown> = tree;
  for (const segment of segments.slice(0, -1)) {
    const child = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      return false;
    }
    node = child as Record<string, unknown>;
    chain.push(node);
  }
  const last = segments[segments.length - 1]!;
  // `in` walks the prototype chain; only an own key is really present.
  if (!Object.hasOwn(node, last)) return false;
  delete node[last];
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![segments[i - 1]!];
  }
  return true;
}
