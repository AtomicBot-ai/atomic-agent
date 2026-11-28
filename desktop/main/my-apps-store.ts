/**
 * ATO-2383: "My apps", an artifact page kept as a small app of its own.
 *
 * "Save as app" on an artifact card writes the page to
 * `<stateDir>/apps/<id>/index.html` with an `app.json` beside it (name,
 * createdAt, the chat it came from). Settings › My apps lists them; Open
 * runs one in its own window (my-apps-ipc.ts) with no chat, no model and no
 * fetch/XHR/WebSocket. Like Goose apps (a folder of pages, opened in a sandboxed window)
 * and Claude Desktop's "install an artifact as an app" (its own window).
 *
 * The state dir is the agent's own (`~/.atomic-agent`, shared with the
 * terminal; state-dir.ts), so an app outlives the chat and a restart.
 *
 * The page runs under the artifact CSP (artifact-frame.ts) with one change:
 * its `sandbox` directive also allows same-origin. In a chat frame an opaque
 * origin keeps the page away from the window; here the page IS the window
 * (no preload, no Node, a session partition of its own), and an origin of
 * its own (`atomic-app://<id>`) is what lets its localStorage persist.
 *
 * No Electron import: the unit suite loads it from `out/main`
 * (test/my-apps-store.test.mjs). It does touch the disk, through node:fs only.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { ARTIFACT_CSP, ARTIFACT_MAX_BYTES, artifactHeaders } from "./artifact-frame.js";

export const MY_APP_SCHEME = "atomic-app";
export const MY_APPS_DIRNAME = "apps";
export const MY_APP_ENTRY = "index.html";
export const MY_APP_MANIFEST = "app.json";
export const MY_APP_NAME_MAX = 80;
/** At most this many apps are listed (a hand-made folder of thousands is not read whole). */
export const MY_APPS_LIST_MAX = 500;
export const MY_APP_DEFAULT_NAME = "Untitled app";

/** The artifact CSP, its sandbox widened to keep an origin (and so localStorage) of the app's own. */
export const MY_APP_CSP = ARTIFACT_CSP.split(/;\s*/)
  .filter((d) => d && !/^sandbox(\s|$)/.test(d))
  .concat("sandbox allow-scripts allow-same-origin")
  .join("; ");

export interface MyAppManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceChatId?: string;
  bytes: number;
  entry: typeof MY_APP_ENTRY;
}

export type MyAppResult = { ok: true; app: MyAppManifest } | { ok: false; reason: MyAppRefusal };
export type MyAppRefusal = "empty" | "too-large" | "bad-id" | "not-found" | "write-failed" | "no-version" | "install-failed" | "install-unsupported";

/** An app id: a lowercase slug (letters, digits, single dashes), 1-64 characters. Nothing else names a folder. */
export function isAppId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

/** A name as shown: one line, no control characters, at most MY_APP_NAME_MAX; blank is "Untitled app". */
export function cleanAppName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return s ? Array.from(s).slice(0, MY_APP_NAME_MAX).join("") : MY_APP_DEFAULT_NAME;
}

/** The readable part of a new id: the name's ASCII letters and digits, dashed, at most 40. */
export function appSlug(name: string): string {
  const s = String(name || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40).replace(/-+$/, "") || "app";
}

/** A new id: the name's slug and 6 random hex digits, so two apps of one name never share a folder. */
export function newAppId(name: string, rand: (n: number) => Buffer = randomBytes): string {
  return appSlug(name) + "-" + rand(3).toString("hex");
}

/** A chat id worth keeping in the manifest, or undefined. */
export function cleanChatId(id: unknown): string | undefined {
  return typeof id === "string" && /^[\w:.-]{1,200}$/.test(id) ? id : undefined;
}

export function appsRoot(stateDir: string): string {
  return join(stateDir, MY_APPS_DIRNAME);
}

/** The app's folder, or null for an id that is not one (or would land outside the root). */
export function appDir(root: string, id: unknown): string | null {
  if (!isAppId(id)) return null;
  const base = resolve(root);
  const dir = resolve(base, id);
  return dir.startsWith(base + sep) ? dir : null;
}

export function appUrl(id: string): string {
  return `${MY_APP_SCHEME}://${id}/`;
}

/** A request an app's session lets through: its own page, and what a page makes in memory. */
export function appRequestAllowed(url: string, id: string): boolean {
  const u = String(url || "");
  return isAppId(id) && (u.startsWith(appUrl(id)) || /^(?:data:|blob:|devtools:\/\/)/i.test(u));
}

/** The session partition an app's window runs in: its storage persists, and is shared with nothing. */
export function appPartition(id: string): string {
  return `persist:${MY_APP_SCHEME}-${id}`;
}

/** The app an `atomic-app://<id>/` (or `/index.html`) URL asks for, or null. */
export function appIdFromUrl(url: unknown): string | null {
  const m = /^atomic-app:\/\/([a-z0-9-]{1,64})\/?(?:index\.html)?(?:[?#].*)?$/.exec(String(url || ""));
  return m && isAppId(m[1]) ? m[1] : null;
}

/** A manifest read back from disk, checked; null when it is not one (the folder is skipped). */
export function parseManifest(raw: unknown, id: string): MyAppManifest | null {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.id !== id || !isAppId(id)) return null;
  const created = typeof o.createdAt === "string" && !Number.isNaN(Date.parse(o.createdAt)) ? o.createdAt : null;
  if (!created) return null;
  const updated = typeof o.updatedAt === "string" && !Number.isNaN(Date.parse(o.updatedAt)) ? o.updatedAt : created;
  const out: MyAppManifest = {
    version: 1, id, name: cleanAppName(o.name), createdAt: created, updatedAt: updated,
    bytes: typeof o.bytes === "number" && Number.isFinite(o.bytes) && o.bytes >= 0 ? Math.floor(o.bytes) : 0,
    entry: MY_APP_ENTRY,
  };
  const chat = cleanChatId(o.sourceChatId);
  if (chat) out.sourceChatId = chat;
  return out;
}

/** Newest first; one second apart or less, by name. */
export function sortApps(apps: MyAppManifest[]): MyAppManifest[] {
  return [...apps].sort((a, b) => (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Largest widget state an app keeps (JSON characters), as in a chat frame (ATO-2375). */
export const MY_APP_STATE_MAX = 64 * 1024;

/**
 * A page made in the chat may call the widget bridge (ATO-2375: `sendPrompt`,
 * `atomicWidget.state`); an app window has no chat to answer, so the same
 * names exist here and do no harm: sendPrompt does nothing and answers
 * false, state lives in the app's own localStorage under one key.
 */
export const MY_APP_BRIDGE_SHIM =
  "<script>(function(){var K='atomicWidget.state';"
  + "function read(){try{var v=localStorage.getItem(K);return v==null?null:JSON.parse(v);}catch(e){return null;}}"
  + "function sendPrompt(){return false;}"
  + "var state={get:function(){return Promise.resolve(read());},"
  + "set:function(v){var j;try{j=JSON.stringify(v===undefined?null:v);}catch(e){return false;}"
  + "if(typeof j!=='string'||j.length>" + MY_APP_STATE_MAX + ")return false;"
  + "try{localStorage.setItem(K,j);}catch(e){return false;}return true;}};"
  + "window.atomicWidget={sendPrompt:sendPrompt,state:state};window.sendPrompt=sendPrompt;})();</script>";

/** The document an app window loads: standards mode, both colour schemes, the bridge shim, the page. */
export function appDocument(html: string): string {
  return "<!doctype html><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"light dark\">" + MY_APP_BRIDGE_SHIM + html;
}

export function appHeaders(): Record<string, string> {
  return { ...artifactHeaders(), "Content-Security-Policy": MY_APP_CSP };
}

/* ---------- on disk ---------- */

/** Write then rename, so a crash leaves the old file or the new one, never half of one. */
function writeAtomic(path: string, text: string): void {
  const tmp = path + ".tmp-" + randomBytes(4).toString("hex");
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function readManifest(root: string, id: string): MyAppManifest | null {
  const dir = appDir(root, id);
  if (!dir) return null;
  try { return parseManifest(readFileSync(join(dir, MY_APP_MANIFEST), "utf8"), id); } catch { return null; }
}

/** Keep a page as a new app. The page is written first, the manifest last: a folder without one is not listed. */
export function saveApp(
  root: string,
  input: { name?: unknown; html?: unknown; chatId?: unknown },
  now: number = Date.now(),
  rand: (n: number) => Buffer = randomBytes,
): MyAppResult {
  const html = input && input.html;
  if (typeof html !== "string" || !html.trim()) return { ok: false, reason: "empty" };
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > ARTIFACT_MAX_BYTES) return { ok: false, reason: "too-large" };
  const name = cleanAppName(input.name);
  let id = newAppId(name, rand);
  for (let i = 0; i < 4 && appDir(root, id) && existsDir(appDir(root, id) as string); i++) id = newAppId(name, rand);
  const dir = appDir(root, id);
  if (!dir || existsDir(dir)) return { ok: false, reason: "write-failed" };
  const at = new Date(now).toISOString();
  const app: MyAppManifest = { version: 1, id, name, createdAt: at, updatedAt: at, bytes, entry: MY_APP_ENTRY };
  const chat = cleanChatId(input.chatId);
  if (chat) app.sourceChatId = chat;
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, MY_APP_ENTRY), html);
    writeAtomic(join(dir, MY_APP_MANIFEST), JSON.stringify(app, null, 2) + "\n");
  } catch {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the next list to skip */ }
    return { ok: false, reason: "write-failed" };
  }
  return { ok: true, app };
}

function existsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Every app with a readable manifest, newest first. A missing root is no apps. */
export function listApps(root: string): MyAppManifest[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const out: MyAppManifest[] = [];
  for (const n of names) {
    if (out.length >= MY_APPS_LIST_MAX) break;
    if (!isAppId(n)) continue;
    const m = readManifest(root, n);
    if (m) out.push(m);
  }
  return sortApps(out);
}

export function renameApp(root: string, id: unknown, name: unknown, now: number = Date.now()): MyAppResult {
  if (!isAppId(id) || !appDir(root, id)) return { ok: false, reason: "bad-id" };
  const m = readManifest(root, id);
  if (!m) return { ok: false, reason: "not-found" };
  const next: MyAppManifest = { ...m, name: cleanAppName(name), updatedAt: new Date(now).toISOString() };
  try { writeAtomic(join(appDir(root, id) as string, MY_APP_MANIFEST), JSON.stringify(next, null, 2) + "\n"); }
  catch { return { ok: false, reason: "write-failed" }; }
  return { ok: true, app: next };
}

/** Remove an app's folder from disk (the IPC moves it to the Trash first and falls back to this). */
export function deleteAppFiles(root: string, id: unknown): { ok: true } | { ok: false; reason: MyAppRefusal } {
  const dir = appDir(root, id);
  if (!dir) return { ok: false, reason: "bad-id" };
  if (!existsDir(dir)) return { ok: false, reason: "not-found" };
  try { rmSync(dir, { recursive: true, force: true }); } catch { return { ok: false, reason: "write-failed" }; }
  return { ok: true };
}

/** An app's manifest and page, or null (no such app, no page, or a page larger than an artifact may be). */
export function readApp(root: string, id: unknown): { app: MyAppManifest; html: string } | null {
  if (!isAppId(id)) return null;
  const app = readManifest(root, id);
  const dir = appDir(root, id);
  if (!app || !dir) return null;
  const file = join(dir, MY_APP_ENTRY);
  try {
    if (statSync(file).size > ARTIFACT_MAX_BYTES) return null;
    return { app, html: readFileSync(file, "utf8") };
  } catch { return null; }
}

/** What the app scheme answers in the window of app `ownId`: its own page, read now, or 404 for anything else. */
export function appResponse(root: string, url: string, ownId: string): { status: number; headers: Record<string, string>; body: string } {
  const id = appIdFromUrl(url);
  const got = id && id === ownId ? readApp(root, id) : null;
  if (!got) return { status: 404, headers: { ...appHeaders(), "Content-Type": "text/plain; charset=utf-8" }, body: "Not found" };
  return { status: 200, headers: appHeaders(), body: appDocument(got.html) };
}
