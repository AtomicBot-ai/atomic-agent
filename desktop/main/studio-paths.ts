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
 * Settings: `<stateDir>/studio.json`, `{imageOutputDir?, videoOutputDir?}`.
 * Core keeps the output folders only in memory per run
 * (src/diffusion/state.ts `config`), so the desktop holds the choice and
 * sends it again to every new Core instance.
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

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

export interface StudioSettings { imageOutputDir?: string; videoOutputDir?: string }

export function studioSettingsPath(stateDir: string): string {
  return join(stateDir, "studio.json");
}

export function readStudioSettings(stateDir: string): StudioSettings {
  try {
    const raw = JSON.parse(readFileSync(studioSettingsPath(stateDir), "utf8")) as Record<string, unknown>;
    const out: StudioSettings = {};
    if (typeof raw.imageOutputDir === "string" && isAbsolute(raw.imageOutputDir)) out.imageOutputDir = raw.imageOutputDir;
    if (typeof raw.videoOutputDir === "string" && isAbsolute(raw.videoOutputDir)) out.videoOutputDir = raw.videoOutputDir;
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
