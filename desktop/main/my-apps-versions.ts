/**
 * ATO-2459: earlier pages of a My apps app, the desktop's copy of
 * src/tools/app/app-versions.ts (the desktop never imports the core; see
 * local-gguf.ts for the same arrangement). The agent's `app.update` and
 * this file write one layout:
 *
 *   <app>/versions/<n>-<savedAtMs>.html   n counts up from 1; savedAtMs is
 *                                         when that page was written
 *
 * An edit keeps the page it replaces first; the newest MY_APP_VERSIONS_KEEP
 * stay. A restore here is an edit too, so it keeps the page it replaces and
 * can itself be undone. Like Claude artifacts' versions and Google Docs'
 * version history.
 *
 * No Electron import: the unit suite loads it from `out/main`.
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACT_MAX_BYTES } from "./artifact-frame.js";
import { MY_APP_ENTRY, MY_APP_MANIFEST, appDir, isAppId, parseManifest, type MyAppResult } from "./my-apps-store.js";

export const MY_APP_VERSIONS_DIRNAME = "versions";
export const MY_APP_VERSIONS_KEEP = 20;

export interface MyAppVersion {
  version: number;
  savedAt: string;
  bytes: number;
}

const VERSION_FILE_RE = /^([1-9]\d{0,8})-(\d{1,15})\.html$/;

function versionFiles(dir: string): Array<MyAppVersion & { file: string }> {
  const vdir = join(dir, MY_APP_VERSIONS_DIRNAME);
  let names: string[];
  try { names = readdirSync(vdir); } catch { return []; }
  const out: Array<MyAppVersion & { file: string }> = [];
  for (const name of names) {
    const m = VERSION_FILE_RE.exec(name);
    if (!m) continue;
    let bytes: number;
    try { bytes = statSync(join(vdir, name)).size; } catch { continue; }
    out.push({ version: Number(m[1]), savedAt: new Date(Number(m[2])).toISOString(), bytes, file: join(vdir, name) });
  }
  return out.sort((a, b) => b.version - a.version);
}

/** The app's earlier pages, newest first; [] for an id that is not one. */
export function listAppVersions(root: string, id: unknown): MyAppVersion[] {
  const dir = appDir(root, id);
  return dir ? versionFiles(dir).map(({ version, savedAt, bytes }) => ({ version, savedAt, bytes })) : [];
}

function writeAtomic(path: string, text: string): void {
  const tmp = path + ".tmp-" + randomBytes(4).toString("hex");
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Copy the current page into versions/ and drop the oldest beyond `keep`. Throws when the copy fails. */
export function keepCurrentPage(dir: string, keep: number = MY_APP_VERSIONS_KEEP): MyAppVersion | null {
  const page = join(dir, MY_APP_ENTRY);
  let savedAtMs: number;
  try { savedAtMs = Math.floor(statSync(page).mtimeMs); } catch { return null; }
  const version = (versionFiles(dir)[0]?.version ?? 0) + 1;
  mkdirSync(join(dir, MY_APP_VERSIONS_DIRNAME), { recursive: true });
  const target = join(dir, MY_APP_VERSIONS_DIRNAME, `${version}-${savedAtMs}.html`);
  copyFileSync(page, target);
  for (const old of versionFiles(dir).slice(Math.max(0, keep))) {
    try { rmSync(old.file, { force: true }); } catch { /* the next edit tries again */ }
  }
  return { version, savedAt: new Date(savedAtMs).toISOString(), bytes: statSync(target).size };
}

export type MyAppRestoreResult = MyAppResult & { kept?: MyAppVersion | null };

/** Put version `version` back as the page; the page it replaces becomes the newest version. */
export function restoreAppVersion(root: string, id: unknown, version: unknown, now: number = Date.now()): MyAppRestoreResult {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  let manifest: ReturnType<typeof parseManifest>;
  try { manifest = parseManifest(readFileSync(join(dir, MY_APP_MANIFEST), "utf8"), id); } catch { manifest = null; }
  if (!manifest) return { ok: false, reason: "not-found" };
  const hit = typeof version === "number" ? versionFiles(dir).find((v) => v.version === version) : undefined;
  if (!hit || hit.bytes > ARTIFACT_MAX_BYTES) return { ok: false, reason: "no-version" };
  try {
    const html = readFileSync(hit.file, "utf8");
    const kept = keepCurrentPage(dir);
    writeAtomic(join(dir, MY_APP_ENTRY), html);
    const app = { ...manifest, updatedAt: new Date(now).toISOString(), bytes: Buffer.byteLength(html, "utf8") };
    writeAtomic(join(dir, MY_APP_MANIFEST), JSON.stringify(app, null, 2) + "\n");
    return { ok: true, app, kept };
  } catch {
    return { ok: false, reason: "write-failed" };
  }
}
