import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * `localModels.managed.modelsDirOverride` as the config file on disk names
 * it right now, absolute (`~` is the home folder), or null when the key is
 * absent or empty. The re-read behind `getModelsDirOverride` in a
 * long-lived process (ATO-2503); `loadConfig` stays the full parse.
 *
 * A missing file means the default folder. Unreadable or broken JSON
 * throws, so the caller keeps the folder it had rather than jumping back
 * to the default because of a write it caught halfway.
 */
export function readModelsDirOverrideFromFile(file: string, home: string = homedir()): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const tree = JSON.parse(text) as { localModels?: { managed?: { modelsDirOverride?: unknown } } } | null;
  const raw = tree?.localModels?.managed?.modelsDirOverride;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  // Same expansion as `loadConfig`'s `resolvePath`.
  if (value.startsWith("~")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}
