/**
 * ATO-2459: the names and the manifest of a "My apps" app, the same on
 * disk as the desktop writes them (desktop/main/my-apps-store.ts, ATO-2383):
 *
 *   <stateDir>/apps/<id>/index.html     the page
 *   <stateDir>/apps/<id>/app.json       this manifest
 *   <stateDir>/apps/<id>/versions/      earlier pages (app-versions.ts)
 *   <stateDir>/apps/<id>/install.json   the OS shortcut, when installed
 *
 * The desktop and the terminal share the state dir (`~/.atomic-agent`),
 * so an app the agent saves shows up in the desktop's My apps and one
 * saved there can be edited from a chat. Pure: no disk here.
 */

import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";

export const APPS_DIRNAME = "apps";
export const APP_ENTRY = "index.html";
export const APP_MANIFEST = "app.json";
export const APP_NAME_MAX = 80;
/** At most this many apps are listed (a hand-made folder of thousands is not read whole). */
export const APPS_LIST_MAX = 500;
export const APP_DEFAULT_NAME = "Untitled app";
/** The desktop's artifact limit (desktop/main/artifact-frame.ts ARTIFACT_MAX_BYTES). */
export const APP_MAX_BYTES = 4 * 1024 * 1024;

export interface AppManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceChatId?: string;
  bytes: number;
  entry: typeof APP_ENTRY;
}

export type AppRefusal = "empty" | "too-large" | "bad-id" | "not-found" | "write-failed" | "no-version";
export type AppResult = { ok: true; app: AppManifest } | { ok: false; reason: AppRefusal };

/** An app id: a lowercase slug (letters, digits, single dashes), 1-64 characters. Nothing else names a folder. */
export function isAppId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

/** A name as shown: one line, no control characters, at most APP_NAME_MAX; blank is "Untitled app". */
export function cleanAppName(name: unknown): string {
  const s =
    typeof name === "string"
      ? name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
      : "";
  return s ? Array.from(s).slice(0, APP_NAME_MAX).join("") : APP_DEFAULT_NAME;
}

/** The readable part of a new id: the name's ASCII letters and digits, dashed, at most 40. */
export function appSlug(name: string): string {
  const s = String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 40).replace(/-+$/, "") || "app";
}

/** A new id: the name's slug and 6 random hex digits, so two apps of one name never share a folder. */
export function newAppId(name: string, rand: (n: number) => Buffer = randomBytes): string {
  return `${appSlug(name)}-${rand(3).toString("hex")}`;
}

/** A chat id worth keeping in the manifest, or undefined. */
export function cleanChatId(id: unknown): string | undefined {
  return typeof id === "string" && /^[\w:.-]{1,200}$/.test(id) ? id : undefined;
}

export function appsRoot(stateDir: string): string {
  return resolve(stateDir, APPS_DIRNAME);
}

/** The app's folder, or null for an id that is not one (or would land outside the root). */
export function appDir(root: string, id: unknown): string | null {
  if (!isAppId(id)) return null;
  const base = resolve(root);
  const dir = resolve(base, id);
  return dir.startsWith(base + sep) ? dir : null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** A manifest read back from disk, checked; null when it is not one (the folder is skipped). */
export function parseAppManifest(raw: unknown, id: string): AppManifest | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.id !== id || !isAppId(id)) return null;
  const created = isoOrNull(o.createdAt);
  if (!created) return null;
  const out: AppManifest = {
    version: 1,
    id,
    name: cleanAppName(o.name),
    createdAt: created,
    updatedAt: isoOrNull(o.updatedAt) ?? created,
    bytes:
      typeof o.bytes === "number" && Number.isFinite(o.bytes) && o.bytes >= 0 ? Math.floor(o.bytes) : 0,
    entry: APP_ENTRY,
  };
  const chat = cleanChatId(o.sourceChatId);
  if (chat) out.sourceChatId = chat;
  return out;
}

/** Newest first; same moment, by name then id. */
export function sortApps(apps: readonly AppManifest[]): AppManifest[] {
  return [...apps].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Why a page is refused, or null when it may be kept. */
export function pageRefusal(html: unknown): "empty" | "too-large" | null {
  if (typeof html !== "string" || !html.trim()) return "empty";
  return Buffer.byteLength(html, "utf8") > APP_MAX_BYTES ? "too-large" : null;
}
