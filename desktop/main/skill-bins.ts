/**
 * ATO-526 (UX audit U-90): does each skill's external program exist on this
 * computer? Settings > Skills lists 18 skills, all on, and many of them run
 * a CLI (`icalBuddy`, `memo`, `remindctl`, `docker`, `gh`…). Nothing said
 * whether it is installed, so the agent found out mid-task.
 *
 * The agent's GET /api/skills names the programs (`requiresBins`, from
 * SKILL.md `requires_bins`) and the install line per platform
 * (`installHints`). Here each name is looked up on the PATH the agent's
 * shell actually gets — `agentEnv().PATH`, which already carries the
 * installer folders a Dock-opened app lacks (installer-path.ts) — with the
 * platform's own rules: `:` and executable bit on macOS/Linux, `;` and
 * PATHEXT on Windows. Nothing is run and nothing is installed.
 *
 * Pure apart from `fsIsExecutable`, so the lookup is unit-tested with a
 * fake filesystem (test/skill-bins.test.mjs).
 */

import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type InstallHints = Partial<Record<"darwin" | "linux" | "win32" | "any", string>>;

export interface BinLookup {
  platform: NodeJS.Platform;
  path: string | undefined;
  /** Windows only; the default is used when unset. */
  pathext?: string | undefined;
  isExecutable: (file: string) => boolean;
}

export interface SkillBinsStatus {
  /** Each required entry as declared (`magick|convert` = either one). */
  required: string[];
  /** The entries none of whose names was found. */
  missing: string[];
  /** The install line for this platform from the skill itself, or null. */
  installHint: string | null;
}

const BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const MAX_ENTRIES = 16;

/** The PATH folders in order, with empty and relative entries left out (they mean "the current folder"). */
export function pathDirs(path: string | undefined, platform: NodeJS.Platform): string[] {
  if (!path) return [];
  const win = platform === "win32";
  return path.split(win ? ";" : ":")
    .map((d) => (win ? d.trim().replace(/^"(.*)"$/, "$1") : d))
    .filter((d) => (win ? win32.isAbsolute(d) : posix.isAbsolute(d)));
}

/** File names to try for `bin` in one folder: on Windows each PATHEXT extension, unless it already has one. */
export function binFileNames(bin: string, platform: NodeJS.Platform, pathext?: string): string[] {
  if (platform !== "win32") return [bin];
  const exts = (pathext || DEFAULT_PATHEXT).split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("."));
  const lower = bin.toLowerCase();
  if (exts.some((e) => lower.endsWith(e))) return [bin];
  return exts.map((e) => bin + e);
}

/** The full path of the first `bin` on PATH, or null. Only a bare program name is looked up. */
export function findBin(bin: string, lookup: BinLookup): string | null {
  if (!BIN_RE.test(bin)) return null;
  const join = lookup.platform === "win32" ? win32.join : posix.join;
  for (const dir of pathDirs(lookup.path, lookup.platform)) {
    for (const name of binFileNames(bin, lookup.platform, lookup.pathext)) {
      const file = join(dir, name);
      if (lookup.isExecutable(file)) return file;
    }
  }
  return null;
}

/** One declared entry is met when any of its `|` alternatives is on PATH. */
export function entryAvailable(entry: string, lookup: BinLookup, find: (bin: string) => string | null = (b) => findBin(b, lookup)): boolean {
  return entry.split("|").map((b) => b.trim()).some((b) => b.length > 0 && find(b) !== null);
}

/** The skill's install line for `platform`, falling back to its any-platform line. */
export function installHintFor(hints: unknown, platform: NodeJS.Platform): string | null {
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return null;
  const h = hints as Record<string, unknown>;
  for (const key of [platform, "any"]) {
    const v = h[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

/** The status of one list row, or null when it declares no programs. */
export function skillBinsStatus(
  row: { requiresBins?: unknown; installHints?: unknown },
  lookup: BinLookup,
  find?: (bin: string) => string | null,
): SkillBinsStatus | null {
  if (!Array.isArray(row.requiresBins)) return null;
  const required = row.requiresBins
    .filter((e): e is string => typeof e === "string" && e.split("|").every((b) => BIN_RE.test(b.trim())))
    .map((e) => e.split("|").map((b) => b.trim()).join("|"))
    .slice(0, MAX_ENTRIES);
  if (!required.length) return null;
  const missing = required.filter((e) => !entryAvailable(e, lookup, find));
  return { required, missing, installHint: installHintFor(row.installHints, lookup.platform) };
}

/**
 * A short memory of lookups, so opening Settings > Skills again does not
 * stat every PATH folder again. A "not found" is kept only `missTtlMs`
 * (a tenth by default), so a program the person just installed shows up
 * on the next refresh; a found one is kept `ttlMs`. Keyed by PATH too, so
 * a changed PATH is looked up afresh.
 */
export function createBinCache(ttlMs: number, now: () => number = Date.now, missTtlMs: number = Math.floor(ttlMs / 10)) {
  const memo = new Map<string, { at: number; file: string | null }>();
  return {
    find(bin: string, lookup: BinLookup): string | null {
      const key = `${lookup.platform}\u0000${lookup.path ?? ""}\u0000${lookup.pathext ?? ""}\u0000${bin}`;
      const hit = memo.get(key);
      const t = now();
      if (hit && t - hit.at < (hit.file === null ? missTtlMs : ttlMs)) return hit.file;
      const file = findBin(bin, lookup);
      if (memo.size > 512) memo.clear();
      memo.set(key, { at: t, file });
      return file;
    },
    clear(): void { memo.clear(); },
  };
}

/** Each row with a `bins` status added where it declares programs; the rest unchanged. */
export function withSkillBins<T extends { requiresBins?: unknown; installHints?: unknown }>(
  rows: T[],
  lookup: BinLookup,
  find?: (bin: string) => string | null,
): Array<T & { bins?: SkillBinsStatus }> {
  return rows.map((row) => {
    const bins = skillBinsStatus(row, lookup, find);
    return bins ? { ...row, bins } : (row as T & { bins?: SkillBinsStatus });
  });
}

/** PATH from an env object: on Windows a spread `process.env` keeps the key as `Path`. */
export function envPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key ? env[key] : undefined;
}

/** A regular file this process may run (Windows has no execute bit: a file is enough). */
export function fsIsExecutable(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    try {
      if (!statSync(file).isFile()) return false;
      if (platform !== "win32") accessSync(file, constants.X_OK);
      return true;
    } catch { return false; }
  };
}
