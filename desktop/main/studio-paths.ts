/**
 * Studio: which files the window may name, and where Studio keeps its own
 * settings. No Electron.
 *
 * The window never gets to point main at an arbitrary file:
 *   - Show in Finder, Save as… and the preview read only a file inside one
 *     of Studio's output folders (images/ and videos/ under Core's data
 *     folder, or the folders chosen in Settings). The path is resolved
 *     first, so a link inside the folder that leads out of it is outside.
 *   - An input image (`{path}`) is accepted only inside those folders (a
 *     gallery item) or when this process's own open dialog returned it;
 *     anything else must come as bytes (`{base64}`). Core reads any path
 *     it is given, so this check is the only one.
 *
 * Settings: `<stateDir>/studio.json`, `{imageOutputDir?, videoOutputDir?,
 * outputDirsMigrated?}`. Core keeps the output folders only in memory per run
 * (src/diffusion/state.ts `config`), so the desktop holds the choice and
 * sends it again to every new Core instance.
 *
 * Default output folders: `<managed data dir>/studio/images` and `/videos`,
 * beside `<managed data dir>/diffusion/models`. Core's own default is inside
 * its per-version data folder (`core/versions/<v>/data/images`), which a Core
 * upgrade replaces, so the desktop always sends its own default instead. The
 * files made before that are moved over once (`planOutputMigration`).
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

/** The real path of `p`, or null when it does not exist or is not absolute. */
export function realPathOf(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0") || !isAbsolute(p)) return null;
  try { return realpathSync(p); } catch { return null; }
}

/** True when `child` (already real) is `root` or inside it. Case-insensitive on Windows and macOS. */
export function isInside(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === "win32" || platform === "darwin";
  const a = fold ? child.toLowerCase() : child;
  const b = fold ? root.toLowerCase() : root;
  const rel = relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path of `p` when it is a file inside one of `roots` (each
 * resolved too), else null.
 */
export function insideRoots(p: unknown, roots: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  const real = realPathOf(p);
  if (!real) return null;
  for (const root of roots) {
    const realRoot = realPathOf(root);
    if (realRoot && real !== realRoot && isInside(real, realRoot, platform)) return real;
  }
  return null;
}

/** Remembers the paths the open dialog returned, newest last, at most `max`. */
export class PickedPaths {
  private readonly paths: string[] = [];
  constructor(private readonly max = 200) {}
  add(p: string): void {
    const real = realPathOf(p);
    if (!real) return;
    const at = this.paths.indexOf(real);
    if (at >= 0) this.paths.splice(at, 1);
    this.paths.push(real);
    if (this.paths.length > this.max) this.paths.shift();
  }
  has(p: unknown): boolean {
    const real = realPathOf(p);
    return !!real && this.paths.includes(real);
  }
}

/**
 * Whether an input image source may be handed to Core: bytes always (Core
 * checks them), a path only inside `roots` or when the dialog picked it.
 */
export function sourceAllowed(source: unknown, roots: readonly string[], picked: PickedPaths, platform: NodeJS.Platform = process.platform): boolean {
  if (!source || typeof source !== "object") return false;
  const s = source as { path?: unknown; base64?: unknown };
  if (typeof s.base64 === "string") return s.base64.length > 0 && s.base64.length <= 48 * 1024 * 1024;
  return insideRoots(s.path, roots, platform) !== null || picked.has(s.path);
}

/** Every `{path}` source in a Core request body (initImage, maskImage, endImage, referenceImages[]). */
export function requestSources(body: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const key of ["initImage", "maskImage", "endImage"]) if (body[key] !== undefined) out.push(body[key]);
  if (Array.isArray(body.referenceImages)) out.push(...body.referenceImages);
  return out;
}

/* --------------------------------------------------------------- settings */

export interface StudioSettings {
  imageOutputDir?: string;
  videoOutputDir?: string;
  /** Set once the files in Core's old per-version folders were moved to the stable defaults. */
  outputDirsMigrated?: boolean;
}

export function studioSettingsPath(stateDir: string): string {
  return join(stateDir, "studio.json");
}

export function readStudioSettings(stateDir: string): StudioSettings {
  try {
    const raw = JSON.parse(readFileSync(studioSettingsPath(stateDir), "utf8")) as Record<string, unknown>;
    const out: StudioSettings = {};
    if (typeof raw.imageOutputDir === "string" && isAbsolute(raw.imageOutputDir)) out.imageOutputDir = raw.imageOutputDir;
    if (typeof raw.videoOutputDir === "string" && isAbsolute(raw.videoOutputDir)) out.videoOutputDir = raw.videoOutputDir;
    if (raw.outputDirsMigrated === true) out.outputDirsMigrated = true;
    return out;
  } catch {
    return {};
  }
}

export function writeStudioSettings(stateDir: string, settings: StudioSettings): void {
  const path = studioSettingsPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/* ------------------------------------------------------- output folders */

/** Studio's default output folders: stable across Core upgrades, beside the diffusion models. */
export function studioDefaultOutputDirs(dataDir: string): { image: string; video: string } {
  return { image: join(dataDir, "studio", "images"), video: join(dataDir, "studio", "videos") };
}

/**
 * Core's own default folder for `kind` in each of its version folders
 * (`<dataDir>/core/versions/<v>/data/images|videos`), the current version first.
 */
export function legacyOutputDirs(dataDir: string, kind: "image" | "video", currentVersion: string, versions: readonly string[]): string[] {
  const sub = kind === "video" ? "videos" : "images";
  const ordered = [currentVersion, ...versions.filter((v) => v !== currentVersion).sort()];
  return [...new Set(ordered)]
    .filter((v) => v.length > 0 && !v.includes("/") && !v.includes("\\") && v !== "." && v !== "..")
    .map((v) => join(dataDir, "core", "versions", v, "data", sub));
}

/**
 * Whether a folder entry is a gallery file worth moving: not a write in
 * progress (Core writes `.<name>.tmp` then renames) and not Finder's or
 * Explorer's litter. `.flags.json` (pins, archive) goes with the files.
 */
export function isMovableOutputEntry(name: string): boolean {
  if (name === ".flags.json") return true;
  if (name.startsWith(".") || name.endsWith(".tmp") || name.endsWith(".part")) return false;
  return name !== "Thumbs.db" && name !== "desktop.ini";
}

export interface OutputMigrationSource { dir: string; entries: readonly string[] }

/**
 * The one-time move of Studio files from Core's per-version folders into the
 * stable default. Nothing moves when it already ran, or when the new folder
 * already holds files (the user made some there: two galleries are never
 * merged). Otherwise every movable entry of every old folder moves, the
 * current version first; a name already taken stays where it is.
 */
export function planOutputMigration(input: {
  migrated: boolean;
  target: string;
  targetEntries: readonly string[];
  sources: readonly OutputMigrationSource[];
}): Array<{ from: string; to: string }> {
  if (input.migrated) return [];
  if (input.targetEntries.some(isMovableOutputEntry)) return [];
  const taken = new Set<string>();
  const moves: Array<{ from: string; to: string }> = [];
  for (const source of input.sources) {
    if (source.dir === input.target) continue;
    for (const name of source.entries) {
      if (!isMovableOutputEntry(name) || basename(name) !== name || taken.has(name)) continue;
      taken.add(name);
      moves.push({ from: join(source.dir, name), to: join(input.target, name) });
    }
  }
  return moves;
}
