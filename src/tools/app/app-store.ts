/**
 * ATO-2459: the My apps store on disk, shared by the agent tools
 * (`app.save` / `app.update` / `app.delete` / `app.list`) and, through
 * the same layout, the desktop (desktop/main/my-apps-store.ts, ATO-2383).
 * Layout and names: app-names.ts; earlier pages: app-versions.ts.
 *
 * Writes go through a temp file and a rename, so a crash leaves the old
 * file or the new one, never half of one. The page is written before
 * the manifest: a folder without a manifest is not listed.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPS_LIST_MAX,
  APP_ENTRY,
  APP_MANIFEST,
  APP_MAX_BYTES,
  appDir,
  cleanAppName,
  cleanChatId,
  isAppId,
  newAppId,
  pageRefusal,
  parseAppManifest,
  sortApps,
  type AppManifest,
  type AppRefusal,
  type AppResult,
} from "./app-names.js";
import { keepCurrentPage, readAppVersion, type AppVersion } from "./app-versions.js";

/** Deleted apps wait here (not an app id, so never listed); the newest APP_TRASH_KEEP stay. */
export const APP_TRASH_DIRNAME = ".trash";
export const APP_TRASH_KEEP = 20;

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function writeManifest(dir: string, app: AppManifest): void {
  writeAtomic(join(dir, APP_MANIFEST), `${JSON.stringify(app, null, 2)}\n`);
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readAppManifest(root: string, id: unknown): AppManifest | null {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return null;
  try {
    return parseAppManifest(readFileSync(join(dir, APP_MANIFEST), "utf8"), id);
  } catch {
    return null;
  }
}

/** Keep a page as a new app. */
export function saveApp(
  root: string,
  input: { name?: unknown; html?: unknown; chatId?: unknown },
  now: number = Date.now(),
  rand: (n: number) => Buffer = randomBytes,
): AppResult {
  const refusal = pageRefusal(input.html);
  if (refusal) return { ok: false, reason: refusal };
  const html = input.html as string;
  const name = cleanAppName(input.name);
  let id = newAppId(name, rand);
  for (let i = 0; i < 4 && existsDir(appDir(root, id) ?? ""); i++) id = newAppId(name, rand);
  const dir = appDir(root, id);
  if (!dir || existsDir(dir)) return { ok: false, reason: "write-failed" };
  const at = new Date(now).toISOString();
  const app: AppManifest = {
    version: 1,
    id,
    name,
    createdAt: at,
    updatedAt: at,
    bytes: Buffer.byteLength(html, "utf8"),
    entry: APP_ENTRY,
  };
  const chat = cleanChatId(input.chatId);
  if (chat) app.sourceChatId = chat;
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, APP_ENTRY), html);
    writeManifest(dir, app);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left for the next list to skip */
    }
    return { ok: false, reason: "write-failed" };
  }
  return { ok: true, app };
}

export type AppUpdateResult =
  | { ok: true; app: AppManifest; kept: AppVersion | null; pageChanged: boolean }
  | { ok: false; reason: AppRefusal };

/**
 * Change an app's page and/or name. A new page first keeps the one it
 * replaces as a version; the same page again keeps nothing.
 */
export function updateApp(
  root: string,
  id: unknown,
  input: { name?: unknown; html?: unknown },
  now: number = Date.now(),
): AppUpdateResult {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  const current = readAppManifest(root, id);
  if (!current) return { ok: false, reason: "not-found" };
  const hasHtml = input.html !== undefined;
  if (hasHtml) {
    const refusal = pageRefusal(input.html);
    if (refusal) return { ok: false, reason: refusal };
  }
  const html = hasHtml ? (input.html as string) : null;
  let pageChanged = false;
  let kept: AppVersion | null = null;
  try {
    if (html !== null && html !== readPage(dir)) {
      kept = keepCurrentPage(dir);
      writeAtomic(join(dir, APP_ENTRY), html);
      pageChanged = true;
    }
    const next: AppManifest = {
      ...current,
      name: input.name !== undefined ? cleanAppName(input.name) : current.name,
      updatedAt: new Date(now).toISOString(),
      bytes: html !== null ? Buffer.byteLength(html, "utf8") : current.bytes,
    };
    writeManifest(dir, next);
    return { ok: true, app: next, kept, pageChanged };
  } catch {
    return { ok: false, reason: "write-failed" };
  }
}

/** Put an earlier page back. The page it replaces is kept as a version, so this can be undone. */
export function restoreAppVersion(root: string, id: unknown, version: unknown, now: number = Date.now()): AppUpdateResult {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  if (!readAppManifest(root, id)) return { ok: false, reason: "not-found" };
  const html = readAppVersion(dir, version);
  if (html === null) return { ok: false, reason: "no-version" };
  return updateApp(root, id, { html }, now);
}

function readPage(dir: string): string | null {
  const file = join(dir, APP_ENTRY);
  try {
    if (statSync(file).size > APP_MAX_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every app with a readable manifest, newest first. A missing root is no apps. */
export function listApps(root: string): AppManifest[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: AppManifest[] = [];
  for (const n of names) {
    if (out.length >= APPS_LIST_MAX) break;
    if (!isAppId(n)) continue;
    const m = readAppManifest(root, n);
    if (m) out.push(m);
  }
  return sortApps(out);
}

/** An app's manifest and page, or null. */
export function readApp(root: string, id: unknown): { app: AppManifest; html: string } | null {
  const app = readAppManifest(root, id);
  const dir = appDir(root, id);
  if (!app || !dir) return null;
  const html = readPage(dir);
  return html === null ? null : { app, html };
}

/**
 * Move an app's folder to `<root>/.trash/<id>-<now>` (so a wrong delete
 * can be undone by hand), then drop the oldest beyond APP_TRASH_KEEP.
 */
export function trashApp(root: string, id: unknown, now: number = Date.now()): { ok: true } | { ok: false; reason: AppRefusal } {
  const dir = appDir(root, id);
  if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
  if (!existsDir(dir)) return { ok: false, reason: "not-found" };
  const trash = join(root, APP_TRASH_DIRNAME);
  try {
    mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, `${id}-${now}`));
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  pruneTrash(trash);
  return { ok: true };
}

function pruneTrash(trash: string): void {
  let names: string[];
  try {
    names = readdirSync(trash);
  } catch {
    return;
  }
  const stamped = names
    .map((n) => ({ n, at: Number(/-(\d{1,15})$/.exec(n)?.[1] ?? 0) }))
    .sort((a, b) => b.at - a.at);
  for (const old of stamped.slice(APP_TRASH_KEEP)) {
    try {
      rmSync(join(trash, old.n), { recursive: true, force: true });
    } catch {
      /* the next delete tries again */
    }
  }
}
