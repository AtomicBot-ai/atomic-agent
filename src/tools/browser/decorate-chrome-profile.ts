import fs from "node:fs";
import path from "node:path";

/**
 * Best-effort decoration of a Chrome `user-data-dir` so it looks like a
 * profile a human created rather than a disposable scratch directory.
 *
 * Two things fingerprinters and anti-bot services look at:
 *   1. `Local State` → `profile.info_cache.Default.name`  — empty or
 *      default strings are a weak tell that the profile was scripted.
 *   2. `Default/Preferences` → `exit_type`/`exited_cleanly` — when
 *      Chrome is killed abruptly it writes `Crashed`, which the next
 *      launch surfaces as the "restore tabs" bubble. We pre-set the
 *      clean-exit keys so Chrome starts quietly even if it was killed
 *      last time.
 *
 * Everything here is safe to call repeatedly; absent files are created
 * and existing content is preserved.
 */

const DEFAULT_PROFILE_NAME = "atomic";

export interface DecorateChromeProfileOptions {
  /** Display name that appears in the Chrome profile menu. */
  profileName?: string;
}

function safeReadJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeWriteJson(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function setDeep(
  obj: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
): void {
  let node: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) {
    node[last] = value;
  }
}

/**
 * Give the `Default` profile inside `userDataDir` a human-ish name and
 * mark the previous session as cleanly closed. Idempotent.
 */
export function decorateChromeProfile(
  userDataDir: string,
  opts: DecorateChromeProfileOptions = {},
): void {
  const name = opts.profileName ?? DEFAULT_PROFILE_NAME;

  const localStatePath = path.join(userDataDir, "Local State");
  const localState = safeReadJson(localStatePath) ?? {};
  setDeep(localState, ["profile", "info_cache", "Default", "name"], name);
  setDeep(localState, ["profile", "info_cache", "Default", "shortcut_name"], name);
  setDeep(localState, ["profile", "info_cache", "Default", "user_name"], name);
  safeWriteJson(localStatePath, localState);

  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  const prefs = safeReadJson(prefsPath) ?? {};
  setDeep(prefs, ["profile", "name"], name);
  setDeep(prefs, ["profile", "exit_type"], "Normal");
  setDeep(prefs, ["profile", "exited_cleanly"], true);
  safeWriteJson(prefsPath, prefs);
}

/**
 * Called right before we deliberately kill the browser process so the
 * next launch does not display the crash-recovery bubble.
 */
export function markChromeProfileCleanExit(userDataDir: string): void {
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  const prefs = safeReadJson(prefsPath);
  if (!prefs) return;
  setDeep(prefs, ["profile", "exit_type"], "Normal");
  setDeep(prefs, ["profile", "exited_cleanly"], true);
  safeWriteJson(prefsPath, prefs);
}
