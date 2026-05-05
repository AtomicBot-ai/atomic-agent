import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Match the same conventional env-var key shape that `loadDotenvFromStateDir`
 * accepts: starts with an uppercase letter or underscore, followed by
 * uppercase letters / digits / underscores. Lowercase keys are intentionally
 * rejected so writes through this surface stay consistent with reads.
 */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Restrictive permissions for `<stateDir>/.env`: owner read/write only. */
const SECRET_FILE_MODE = 0o600;

export class DotenvWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DotenvWriterError";
  }
}

export interface SetDotenvKeyResult {
  /** Absolute path of the `.env` file that was written (or `unlink`ed). */
  path: string;
  /** Whether the file existed before this call. */
  preexisting: boolean;
  /**
   * Whether a write actually occurred. Setting a key to its current value
   * is a no-op (`changed === false`), and removing a missing key when the
   * file does not exist is also a no-op.
   */
  changed: boolean;
}

/**
 * Atomically set or remove a key in `<stateDir>/.env`.
 *
 *  - `value: string`  — set or update the key. Empty string is allowed and
 *                       written verbatim (matches dotenv conventions).
 *  - `value: null`    — remove the key if present. No-op when absent.
 *
 * Always preserves comments, blank lines, ordering, and other keys
 * verbatim. Quoting is added around values that contain whitespace or
 * shell-special characters so the value round-trips through
 * `loadDotenvFromStateDir`. The file is written atomically (`tmp` +
 * `rename`) and chmod'd to 0600 so the bot token is never readable by
 * other users on a shared machine.
 *
 * **Never logs the value.** The result object exposes the key and a
 * boolean — values do not leave this module through the return surface.
 */
export function setDotenvKey(
  stateDir: string,
  key: string,
  value: string | null,
): SetDotenvKeyResult {
  if (!KEY_PATTERN.test(key)) {
    throw new DotenvWriterError(`invalid key '${key}'`);
  }

  const path = join(stateDir, ".env");
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : "";
  const updated = applyMutation(original, key, value);

  if (updated === null) {
    // Removal request against a key that is not present.
    if (!existed) {
      return { path, preexisting: false, changed: false };
    }
    return { path, preexisting: true, changed: false };
  }

  if (updated === original && existed) {
    return { path, preexisting: true, changed: false };
  }

  // Removal collapsed the file to empty: prefer unlink so an empty
  // `.env` does not linger and confuse `loadDotenvFromStateDir` into
  // thinking secrets are configured.
  if (updated.length === 0) {
    if (existed) unlinkSync(path);
    return { path, preexisting: existed, changed: existed };
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, updated, { encoding: "utf8", mode: SECRET_FILE_MODE });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — best effort cleanup
    }
    throw err;
  }
  // `rename` preserves the source-mode on most platforms but a few do
  // not; chmod again to be defensive. Cheap and idempotent.
  try {
    chmodSync(path, SECRET_FILE_MODE);
  } catch {
    // chmod is best-effort on Windows; the rename already won.
  }
  return { path, preexisting: existed, changed: true };
}

/**
 * Apply the requested mutation to the dotenv text. Returns:
 *  - the new text when the file content changes, or stays the same
 *    (caller decides whether to write);
 *  - `null` when the mutation is a removal of an absent key (no file
 *    write should happen at all in that case).
 */
function applyMutation(
  original: string,
  key: string,
  value: string | null,
): string | null {
  const lines = original.length === 0 ? [] : original.split(/\r?\n/);
  // Drop a single trailing empty line introduced by `split` on a
  // trailing newline so we don't accumulate blank lines on rewrite.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let foundIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (matchesKey(lines[i] ?? "", key)) {
      foundIndex = i;
      break;
    }
  }

  if (value === null) {
    if (foundIndex === -1) return null;
    lines.splice(foundIndex, 1);
    return joinWithTrailingNewline(lines);
  }

  const formatted = `${key}=${formatValue(value)}`;
  if (foundIndex === -1) {
    lines.push(formatted);
  } else {
    lines[foundIndex] = formatted;
  }
  return joinWithTrailingNewline(lines);
}

/**
 * Recognise the line as carrying `key`. Tolerant of leading whitespace
 * around the key (matches the loader's `.trim()` behaviour) but not of
 * an `export ` prefix — neither this writer nor the loader supports it.
 */
function matchesKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return false;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return false;
  return trimmed.slice(0, eq).trim() === key;
}

/**
 * Quote the value when it contains whitespace, `#`, or quote
 * characters so the loader (which uses simple line-splitting) reads
 * the same string back. Plain alphanumeric/punctuation values pass
 * through unquoted to match conventional `.env` files.
 */
function formatValue(value: string): string {
  if (value.length === 0) return "";
  if (/[\s"'#\\]/.test(value)) {
    // Escape backslashes and double quotes; the reader strips a
    // single matching outer quote pair without honouring escapes, so
    // keep this conservative — values with embedded `"` round-trip
    // by being wrapped in `'...'` instead.
    if (value.includes('"') && !value.includes("'")) {
      return `'${value}'`;
    }
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function joinWithTrailingNewline(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}
