/**
 * ATO-2500: the favourite models, one list for the desktop and the terminal.
 *
 * The terminal keeps its favourites (`/model favorite`, ctrl+p) in
 * `<state dir>/model-favorites.json` (src/tui/model-ring/model-ring-store.ts),
 * and the desktop runs on the same state dir, so the model picker's
 * Favorites group reads and writes that file too instead of its own
 * localStorage list. Copied here, not imported, because the desktop main
 * process cannot import `src/` (as interview-invite.ts). Keep the two alike:
 *
 *   {"models": ["provider/model", ...]}   oldest first, at most 20,
 *                                         local models as local-llama/<id>
 *
 * The window keys a favourite `provider|model` (renderer/model-favorites.js);
 * the file spells it `provider/model`, split on the FIRST separator either
 * way (model ids carry slashes, provider ids never do). Every change reads
 * the file again first, so a star set in the terminal meanwhile is kept.
 * Pure except the fs helpers at the bottom, which never throw.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_FAVORITES_FILE = "model-favorites.json";
/** MODEL_RING_MAX in src/tui/model-ring/model-ring.ts. */
export const MODEL_FAVORITES_MAX = 20;

function splitAt(raw: string, sep: string): [string, string] | null {
  const at = raw.indexOf(sep);
  if (at <= 0 || at === raw.length - 1 || /\s/.test(raw)) return null;
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** The window's `provider|model` as the file's `provider/model`; null when it is not one. */
export function favKeyToEntry(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const parts = splitAt(key.trim(), "|");
  return parts ? `${parts[0]}/${parts[1]}` : null;
}

/** The file's `provider/model` as the window's `provider|model`; null when it is not one. */
export function favEntryToKey(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const parts = splitAt(entry.trim(), "/");
  return parts ? `${parts[0]}|${parts[1]}` : null;
}

/** Window keys kept in order, junk and repeats dropped, capped. */
export function cleanFavKeys(raw: unknown): string[] {
  const out: string[] = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    const entry = favKeyToEntry(k);
    const key = entry ? favEntryToKey(entry) : null;
    if (!key || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MODEL_FAVORITES_MAX) break;
  }
  return out;
}

/**
 * The one-time move of the window's old list (ATO-2169 kept it in
 * localStorage): the file's favourites first, as they are, then the old
 * ones the file does not hold yet, in their order, capped.
 */
export function mergeFavKeys(fileKeys: readonly string[], legacyKeys: unknown): string[] {
  return cleanFavKeys([...fileKeys, ...cleanFavKeys(legacyKeys)]);
}

/** Star or unstar `key`, as the window always did: a full list drops its oldest. */
export function toggleFavKey(keys: readonly string[], key: string): { keys: string[]; on: boolean } {
  if (keys.includes(key)) return { keys: keys.filter((k) => k !== key), on: false };
  const next = [...keys, key];
  return { keys: next.length > MODEL_FAVORITES_MAX ? next.slice(next.length - MODEL_FAVORITES_MAX) : next, on: true };
}

/** The file's list as window keys; a missing or broken file is no favourites. */
export function readFavKeys(stateDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, MODEL_FAVORITES_FILE), "utf8"));
    const models = (parsed as { models?: unknown } | null)?.models;
    return cleanFavKeys((Array.isArray(models) ? models : []).map(favEntryToKey));
  } catch {
    return [];
  }
}

/** Writes the whole list (temp file, then rename), in the terminal's format. False when it could not be saved. */
export function writeFavKeys(stateDir: string, keys: readonly string[]): boolean {
  const path = join(stateDir, MODEL_FAVORITES_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    const models = cleanFavKeys(keys).map(favKeyToEntry);
    writeFileSync(tmp, `${JSON.stringify({ models }, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    return false;
  }
}

/** `modelFav:load` (model-favorites-ipc.ts): the file's list, with the window's old list merged in once. */
export function modelFavLoad(stateDir: string, legacy: unknown): { ok: true; keys: string[]; saved: boolean } {
  const file = readFavKeys(stateDir);
  const old = cleanFavKeys(legacy);
  if (!old.length) return { ok: true, keys: file, saved: true };
  const merged = mergeFavKeys(file, old);
  if (merged.length === file.length && merged.every((k, i) => k === file[i])) return { ok: true, keys: file, saved: true };
  // Not saved: the window still draws the merged list and keeps its old one for the next try.
  return { ok: true, keys: merged, saved: writeFavKeys(stateDir, merged) };
}

/** `modelFav:toggle`: read the file again, star or unstar `key`, write it. */
export function modelFavToggle(stateDir: string, key: unknown): { ok: boolean; keys: string[]; on: boolean } {
  const keys = readFavKeys(stateDir);
  const [clean] = cleanFavKeys([key]);
  if (!clean) return { ok: false, keys, on: false };
  const next = toggleFavKey(keys, clean);
  if (!writeFavKeys(stateDir, next.keys)) return { ok: false, keys, on: keys.includes(clean) };
  return { ok: true, keys: next.keys, on: next.on };
}
