/**
 * ATO-2459: earlier pages of a My apps app. Every edit that changes the
 * page first copies the page it replaces to
 * `<app>/versions/<n>-<savedAtMs>.html` (n counts up from 1, savedAtMs is
 * when that page was written), and only the newest APP_VERSIONS_KEEP are
 * kept. A restore is an edit too, so the page it replaces is kept and a
 * restore can itself be undone. Like Claude artifacts' version list and
 * Google Docs' version history: the current page is never lost to an edit.
 *
 * The desktop reads and writes the same folder
 * (desktop/main/my-apps-versions.ts mirrors this file).
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { APP_ENTRY, APP_MAX_BYTES } from "./app-names.js";

export const APP_VERSIONS_DIRNAME = "versions";
/** Earlier pages kept per app; the oldest beyond this are removed on the next edit. */
export const APP_VERSIONS_KEEP = 20;

export interface AppVersion {
  /** 1 is the first page the app had. */
  version: number;
  /** When that page was written (ISO). */
  savedAt: string;
  bytes: number;
}

const VERSION_FILE_RE = /^([1-9]\d{0,8})-(\d{1,15})\.html$/;

interface VersionFile extends AppVersion {
  file: string;
}

function versionFiles(appFolder: string): VersionFile[] {
  const dir = join(appFolder, APP_VERSIONS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: VersionFile[] = [];
  for (const name of names) {
    const m = VERSION_FILE_RE.exec(name);
    if (!m) continue;
    let bytes = 0;
    try {
      bytes = statSync(join(dir, name)).size;
    } catch {
      continue;
    }
    out.push({
      version: Number(m[1]),
      savedAt: new Date(Number(m[2])).toISOString(),
      bytes,
      file: join(dir, name),
    });
  }
  return out.sort((a, b) => b.version - a.version);
}

/** The app's earlier pages, newest first. */
export function listAppVersions(appFolder: string): AppVersion[] {
  return versionFiles(appFolder).map(({ version, savedAt, bytes }) => ({ version, savedAt, bytes }));
}

/** One earlier page, or null (no such version, or larger than an app may be). */
export function readAppVersion(appFolder: string, version: unknown): string | null {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const hit = versionFiles(appFolder).find((v) => v.version === version);
  if (!hit || hit.bytes > APP_MAX_BYTES) return null;
  try {
    return readFileSync(hit.file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Copy the current page into `versions/` before it is replaced, then
 * drop the oldest beyond `keep`. Throws when the copy fails, so the
 * caller does not replace a page it could not keep.
 */
export function keepCurrentPage(appFolder: string, keep: number = APP_VERSIONS_KEEP): AppVersion | null {
  const page = join(appFolder, APP_ENTRY);
  let savedAtMs: number;
  try {
    savedAtMs = Math.floor(statSync(page).mtimeMs);
  } catch {
    return null; // no page yet: nothing to keep
  }
  const files = versionFiles(appFolder);
  const version = (files[0]?.version ?? 0) + 1;
  const dir = join(appFolder, APP_VERSIONS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${version}-${savedAtMs}.html`);
  copyFileSync(page, target);
  pruneAppVersions(appFolder, keep);
  return { version, savedAt: new Date(savedAtMs).toISOString(), bytes: statSync(target).size };
}

/** Remove the oldest earlier pages beyond `keep`. A file that will not go is left for the next edit. */
export function pruneAppVersions(appFolder: string, keep: number = APP_VERSIONS_KEEP): void {
  const max = Math.max(0, Math.floor(keep));
  for (const old of versionFiles(appFolder).slice(max)) {
    try {
      rmSync(old.file, { force: true });
    } catch {
      /* the next edit tries again */
    }
  }
}
