import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  ConfigValidationError,
  ENV_DEFAULTS,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  type UserConfigFile,
} from "./config-schema.js";

/** Resolve the absolute path to the user config file inside a state dir. */
export function getUserConfigPath(stateDir: string): string {
  return join(stateDir, ENV_DEFAULTS.USER_CONFIG_FILE_NAME);
}

/** Resolve the absolute path to the `.env` file inside a state dir. */
export function getDotenvPath(stateDir: string): string {
  return join(stateDir, ".env");
}

/**
 * The agent's own trust surface: `config.json` (holds
 * `agent.approvalLevel`) and `.env` (API keys / bot tokens loaded at
 * boot). A silent rewrite of either is a self-escalation vector, so the
 * approval ladder categorises a write to these as `trust_config` (asks
 * until level 5). This is the single place that *knows where the trust
 * surface lives*; the bootstrap resolves it once from `config.paths` and
 * injects the list into the fs tools, which never derive it themselves.
 */
export function getTrustConfigPaths(paths: {
  userConfigFile: string;
  stateDir: string;
}): readonly string[] {
  return [paths.userConfigFile, getDotenvPath(paths.stateDir)];
}

/**
 * Synchronously read and validate the user config file.
 * Returns `null` if the file does not exist. Throws `ConfigValidationError`
 * if the file is present but malformed.
 *
 * Pure read — does not migrate the file on disk. Use
 * `ensureUserConfigFileSync` from the bootstrap path to get the
 * active-migration behaviour.
 */
export function readUserConfigFileSync(path: string): UserConfigFile | null {
  const raw = readRawUserConfigFileSync(path);
  if (!raw) return null;
  return parseUserConfigFile(raw.parsed);
}

/**
 * Atomically write the user config file: tmp file + rename. Creates
 * the parent directory as needed.
 *
 * The written `version` is never lower than the one already on disk. A
 * dozen call sites build their payload by spreading a config object and
 * writing it back, and several skip `parseUserConfigFile` entirely, so
 * the guard lives here rather than in the parse: this is the only
 * function in the tree that writes `config.json`. Without it, an older
 * build that opens a newer file relabels it on the first settings
 * toggle, and the version field is load-bearing — `version < 41` forces
 * `localModels.managed.autoUpdate` back on, `version < 22` overrides an
 * explicit `memory.*` opt-out, `version < 25` rewrites
 * `http.approvalMode`. Downgrading the label silently reverts choices
 * the user made.
 */
export function writeUserConfigFileSync(path: string, data: UserConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const onDisk = readVersionFieldFromFileSync(path);
  const raised = onDisk !== null && onDisk > data.version;
  const version = raised ? (onDisk as number) : data.version;
  if (raised) {
    process.stderr.write(
      `[atomic-agent] kept config version ${onDisk} (this build writes v${data.version}) at ${path}\n`,
    );
  }
  const payload =
    JSON.stringify(version === data.version ? data : { ...data, version }, null, 2) +
    "\n";
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

/**
 * Ensure the user config file exists and is at the current schema
 * version.
 *
 *  - File missing: write defaults, warn once on stderr, return defaults.
 *  - File present at older `version`: parse (which fills in defaults
 *    for any added blocks transparently), atomically rewrite the file
 *    in v{USER_CONFIG_VERSION} shape, and log one migration line to
 *    stderr for auditability. Existing user values are preserved
 *    verbatim — only the `version` field bumps and any newly added
 *    blocks (e.g. `vision` in v6) are filled with defaults.
 *  - File present at the current `version`: parse and return without
 *    touching the file on disk.
 *  - File present at a NEWER `version` (an install that was rolled back,
 *    or two builds sharing one state dir): parse with this build's
 *    schema and return without touching the file. Unknown top-level
 *    blocks ride along untouched; the newer `version` is kept.
 *
 * The return value is always the validated, normalised contents.
 */
/**
 * Where "created default config …" and "migrated config …" go.
 *
 * They are diagnostics, not output, and the TUI is the one caller that
 * cannot afford them on stderr: it prints them *before* the alternate
 * screen is entered, so a first run opens with two raw lines above the
 * interface — a file path and a warning, as the first thing a new user
 * reads. A sink lets that caller collect them and replay them inside the
 * UI instead. Every other caller (the CLI, the sidecar) keeps stderr,
 * which is the default.
 */
export type ConfigNoticeSink = (line: string) => void;

let configNoticeSink: ConfigNoticeSink | null = null;

export function setConfigNoticeSink(sink: ConfigNoticeSink | null): void {
  configNoticeSink = sink;
}

function emitConfigNotice(line: string): void {
  if (configNoticeSink) {
    configNoticeSink(line);
    return;
  }
  process.stderr.write(`${line}\n`);
}

export function ensureUserConfigFileSync(path: string): UserConfigFile {
  const raw = readRawUserConfigFileSync(path);
  if (!raw) {
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    emitConfigNotice(`[atomic-agent] created default config at ${path}`);
    return USER_CONFIG_DEFAULTS;
  }
  const parsed = withConfigPathInError(path, () => parseUserConfigFile(raw.parsed));
  // Migrate upward only. `!==` would treat "written by a newer build" as
  // "needs migrating" and rewrite the file down to this build's schema at
  // startup, before the user has touched anything — the exact move that
  // turns a rollback into data loss.
  if (raw.originalVersion === null || raw.originalVersion < USER_CONFIG_VERSION) {
    writeUserConfigFileSync(path, parsed);
    emitConfigNotice(
      `[atomic-agent] migrated config v${raw.originalVersion} → v${USER_CONFIG_VERSION} at ${path}`,
    );
  }
  return parsed;
}

/**
 * Name the file and a way out when the config is unusable. `getConfig()`
 * runs ahead of every command, so a validation failure here is the first
 * thing a user sees, and the bare `invalid config: version: …` it used to
 * print names neither the file nor a remedy — leaving nothing to do but
 * search the source.
 */
function withConfigPathInError<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    throw new ConfigValidationError(
      err.field,
      `${err.reason} (in ${path}) — edit or delete that file to start from defaults, or point ATOMIC_AGENT_STATE_DIR elsewhere`,
    );
  }
}

interface RawUserConfigFile {
  /** Untouched parsed JSON tree, ready for `parseUserConfigFile`. */
  parsed: unknown;
  /** Pre-migration `version` field straight from disk, or `null` when missing/malformed. */
  originalVersion: number | null;
}

function readRawUserConfigFileSync(path: string): RawUserConfigFile | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigValidationError(
      "<file>",
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { parsed, originalVersion: readVersionField(parsed) };
}

/**
 * The `version` currently on disk, or `null` when the file is absent,
 * unreadable, not JSON, or carries no numeric version. Deliberately
 * total: this runs on the write path, where a malformed existing file
 * must not stop the caller from replacing it.
 */
function readVersionFieldFromFileSync(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    return readVersionField(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readVersionField(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).version;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
