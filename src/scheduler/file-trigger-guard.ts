import { isAbsolute, join, matchesGlob, parse, relative, resolve, sep } from "node:path";

/**
 * Path rules for file triggers (ATO-441), kept apart from the watcher so
 * they are plain functions with no filesystem access.
 */

/** Directory names never descended into or reported. */
export const FILE_TRIGGER_IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
]);

export type TriggerRootResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Resolve a configured trigger path and refuse the ones that would watch
 * far too much: a filesystem root, the home directory itself and any of
 * its parents. Everything inside home (`~/Inbox`, `~/logs/app.log`) and
 * outside it (`/var/log/app.log`) is allowed.
 */
export function resolveTriggerRoot(raw: string, homeDir: string): TriggerRootResult {
  const expanded =
    raw === "~"
      ? homeDir
      : raw.startsWith("~/") || raw.startsWith("~\\")
        ? join(homeDir, raw.slice(2))
        : raw;
  if (!isAbsolute(expanded)) {
    return { ok: false, reason: "path must be absolute or start with ~/" };
  }
  const path = resolve(expanded);
  if (parse(path).root === path) {
    return { ok: false, reason: "refusing to watch a filesystem root" };
  }
  const home = resolve(homeDir);
  const toHome = relative(path, home);
  if (toHome === "" || (!toHome.startsWith("..") && !isAbsolute(toHome))) {
    return {
      ok: false,
      reason: "refusing to watch the home directory or a folder above it; pick a subfolder",
    };
  }
  return { ok: true, path };
}

/** Whether `path` lies in (or is) an ignored directory under `root`. */
export function isInIgnoredDir(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep).some((segment) => FILE_TRIGGER_IGNORED_DIRS.has(segment));
}

/**
 * Whether a file under a watched directory passes the trigger's glob.
 * The pattern is matched against the path relative to the root with `/`
 * separators; no glob means every file passes.
 */
export function matchesTriggerGlob(root: string, path: string, glob: string | undefined): boolean {
  if (glob === undefined) return true;
  const rel = relative(root, path).split(sep).join("/");
  if (rel === "" || rel.startsWith("..")) return false;
  return matchesGlob(rel, glob);
}
