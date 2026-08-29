import { existsSync, readFileSync } from "node:fs";

import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  USER_CONFIG_VERSION,
  writeUserConfigFileSync,
} from "../config/index.js";
import { HELP } from "./config-help.js";
import {
  deleteConfigPath,
  findConfigLeaf,
  formatConfigValue,
  isConfigBranch,
  isReadOnlyConfigKey,
  listConfigLeaves,
  readConfigPath,
  suggestConfigKey,
  writeConfigPath,
  writeRawUserConfigFileSync,
} from "../config/config-paths.js";

export async function configCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "get":
        return handleGet(args.slice(1));
      case "set":
        return handleSet(args.slice(1));
      case "unset":
        return handleUnset(args.slice(1));
      case "list":
        return handleList();
      case "path":
        process.stdout.write(`${getConfig().paths.userConfigFile}\n`);
        return 0;
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`config ${sub} failed: ${err.message}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`config ${sub} failed: ${message}\n`);
    return 1;
  }
}

function handleGet(args: string[]): number {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  if (args.length === 0) {
    process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
    return 0;
  }
  const key = args[0]!;
  if (isConfigBranch(key)) {
    // A branch has no single value; print the subtree rather than
    // refusing, since that is unambiguously what was asked for.
    process.stdout.write(
      `${JSON.stringify(readConfigPath(file, key), null, 2)}\n`,
    );
    return 0;
  }
  if (!findConfigLeaf(key)) return rejectUnknownKey("get", key);
  process.stdout.write(`${formatConfigValue(key, readConfigPath(file, key))}\n`);
  return 0;
}

function handleSet(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write(
      "usage: atomic-agent config set <key> <value>\n" +
        "   or: atomic-agent config set '<json>'\n",
    );
    return 1;
  }
  // Form discrimination. A leading `{` means the whole-file JSON payload,
  // including the case where the shell split one JSON argument across
  // several argv entries (`set { "version":40, ... }`), which is why the
  // test for that keeps passing.
  const first = args[0]!;
  if (args.length >= 2 && !first.startsWith("{")) {
    return setOneKey(first, args.slice(1).join(" "));
  }
  if (!first.startsWith("{")) {
    // Single non-JSON argument: a key with no value. Treating this as
    // `get` would silently do something other than what was typed.
    process.stderr.write(
      `config set failed: no value given for ${first}\n` +
        `usage: atomic-agent config set ${first} <value>\n`,
    );
    return 1;
  }
  return setWholeFile(args.join(" "));
}

function setWholeFile(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`config set failed: invalid JSON: ${message}\n`);
    return 1;
  }
  // Reading a version from the future is right for a file on disk — some
  // newer build wrote it. Typing one here is not: nothing understands it,
  // the write path will not let a later `config set` lower it again, and
  // the file would sit permanently above every future schema, skipping
  // every migration.
  if (
    typeof (parsed as { version?: unknown } | null)?.version === "number" &&
    (parsed as { version: number }).version > USER_CONFIG_VERSION
  ) {
    process.stderr.write(
      `config set failed: version ${(parsed as { version: number }).version} is newer than this build understands (${USER_CONFIG_VERSION})\n`,
    );
    return 1;
  }
  const next = parseUserConfigFile(parsed);
  const path = getConfig().paths.userConfigFile;
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  process.stdout.write(`wrote ${path}\n`);
  return 0;
}

function setOneKey(key: string, value: string): number {
  const leaf = findConfigLeaf(key);
  if (!leaf) return rejectUnknownKey("set", key);
  if (isReadOnlyConfigKey(key)) {
    process.stderr.write(
      `config set failed: ${key} is managed by the config schema and cannot be set by hand\n`,
    );
    return 1;
  }
  if (leaf.isArray) {
    process.stderr.write(
      `config set failed: ${key} is a list; set it with the whole-file JSON form\n` +
        `  atomic-agent config set '{"version":${USER_CONFIG_VERSION}, ...}'\n`,
    );
    return 1;
  }
  const path = getConfig().paths.userConfigFile;
  const tree = readRawConfigTree(path);
  // The raw string goes in as-is: `parseUserConfigFile` coerces it to the
  // declared type ("false" → false, "40" → 40) and enforces bounds and
  // enums. Guessing the type here would be a second source of truth that
  // drifts from the schema the moment a field changes type.
  writeConfigPath(tree, key, value);
  // Validate first, write second: `parseUserConfigFile` throws on a bad
  // value, so a rejected `set` leaves the file untouched.
  const next = parseUserConfigFile(tree);
  // Store the *coerced* value the schema produced ("false" → false,
  // "40" → 40) rather than the raw string. Both reload identically, since
  // the schema coerces on every read, but a config file should hold
  // JSON-typed values — anything else is a surprise to whoever opens it
  // next. Only this one key is taken from the parse output; the rest of
  // the tree stays exactly as it was on disk, so the file does not get
  // expanded with every default (see `writeRawUserConfigFileSync`).
  writeConfigPath(tree, key, readConfigPath(next, key));
  writeRawUserConfigFileSync(path, tree);
  resetConfigCache();
  process.stdout.write(
    `${key} = ${formatConfigValue(key, readConfigPath(next, key))}\n`,
  );
  return 0;
}

function handleUnset(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write("usage: atomic-agent config unset <key>\n");
    return 1;
  }
  const key = args[0]!;
  const leaf = findConfigLeaf(key);
  if (!leaf) return rejectUnknownKey("unset", key);
  if (isReadOnlyConfigKey(key)) {
    process.stderr.write(
      `config unset failed: ${key} is managed by the config schema\n`,
    );
    return 1;
  }
  const path = getConfig().paths.userConfigFile;
  const tree = readRawConfigTree(path);
  deleteConfigPath(tree, key);
  const next = parseUserConfigFile(tree);
  writeRawUserConfigFileSync(path, tree);
  resetConfigCache();
  process.stdout.write(
    `${key} → ${formatConfigValue(key, readConfigPath(next, key))} (default)\n`,
  );
  return 0;
}

function handleList(): number {
  const file = ensureUserConfigFileSync(getConfig().paths.userConfigFile);
  const rows = listConfigLeaves().map((leaf) => {
    const actual = readConfigPath(file, leaf.key);
    const rendered = `${leaf.key} = ${formatConfigValue(leaf.key, actual)}`;
    const isDefault =
      JSON.stringify(actual) === JSON.stringify(leaf.defaultValue);
    return { rendered, isDefault, leaf };
  });
  // Align the `(default …)` notes with each other, not with all 139 rows:
  // padding to the widest key in the whole config would strand the notes
  // far off to the right of the handful of lines that carry them.
  const annotated = rows.filter((row) => !row.isDefault);
  const width = annotated.length
    ? Math.max(...annotated.map((row) => row.rendered.length))
    : 0;
  for (const row of rows) {
    if (row.isDefault) {
      process.stdout.write(`${row.rendered}\n`);
      continue;
    }
    const shown = formatConfigValue(row.leaf.key, row.leaf.defaultValue);
    process.stdout.write(
      `${row.rendered.padEnd(width)}  (default ${shown})\n`,
    );
  }
  return 0;
}

/**
 * Reject a key the schema does not define.
 *
 * This check is the whole reason `set` does not simply hand the tree to
 * the schema: `parseUserConfigFile` *ignores* unknown keys, so a typo
 * would validate, write a file without the setting, and report success.
 */
function rejectUnknownKey(sub: string, key: string): number {
  const suggestion = suggestConfigKey(key);
  const hint = suggestion ? ` (did you mean ${suggestion}?)` : "";
  process.stderr.write(`config ${sub} failed: unknown key ${key}${hint}\n`);
  process.stderr.write("run `atomic-agent config list` to see every key\n");
  return 1;
}

/**
 * Read the config file as a plain JSON tree, without filling in defaults.
 *
 * Deliberately not `ensureUserConfigFileSync`: that returns the fully
 * defaulted config, so writing it back would freeze today's 139 defaults
 * into the user's file and silently pin them against future schema
 * changes. A point edit must leave the rest of the file byte-for-byte
 * alone, which means starting from what is actually on disk.
 */
function readRawConfigTree(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError("<file>", `${path} is not valid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigValidationError("<file>", `${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
