/**
 * ATO-2332: the chat Trash (renderer/chat-trash.js, main/chat-trash-ipc.ts).
 *
 * Delete… on a chat row no longer removes the chat from this machine: it moves
 * it to Trash, as macOS Finder, Claude.ai and Slack's "recently deleted" do.
 * The chat stays in the agent's store, stamped `metadata.trashed` (stampTrashed,
 * POST /api/sessions/{id}/trashed) so the agent's session search leaves it out
 * as it would a deleted chat; Restore clears the stamp. This file remembers which
 * chats are in Trash, the title each showed and when it went there. The window
 * hides those chats from every list and draws them in a Trash section, with
 * Restore and Delete forever. A chat that has been in Trash for 30 days is
 * deleted for good (DELETE /api/sessions/{id}) by purgeExpired; nothing
 * younger is ever deleted without the person pressing Delete forever.
 *
 * The list lives in Electron's userData as chat-trash.json, beside prefs.json:
 * one window's view state, never the agent's config. No Electron here, so the
 * Node checks load it (test/chat-trash.test.mjs).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE = 300;

export type TrashEntry = { id: string; title: string; deletedAt: number };

/** AgentClient.sessionRoute: POST /api/sessions/{id}/<path>, answered as status and JSON. */
export type SessionRoute = (id: string, path: string, method: "POST", body: unknown) => Promise<{ status: number; body: unknown }>;

/**
 * Stamp the session in Trash (`trashed`) or out of it on the agent, so its
 * session search hides or shows it (core: route-session-trashed.ts). Null when
 * done, else why not, and then the caller changes nothing. A 404 goes ahead:
 * a chat the agent does not hold has nothing to search, and an agent from
 * before the route ("No route for") cannot be told.
 */
export async function stampTrashed(route: SessionRoute, id: string, trashed: boolean): Promise<string | null> {
  try {
    const res = await route(id, "trashed", "POST", { trashed });
    if (res.status === 200 || res.status === 404) return null;
    const msg = (res.body as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof msg === "string" && msg ? msg : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** A read of the file, or anything else, as a clean list: one entry per id, newest first. */
export function coerceTrash(raw: unknown): TrashEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
    ? (raw as { entries: unknown[] }).entries : [];
  const out: TrashEntry[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const { id, title, deletedAt } = e as { id?: unknown; title?: unknown; deletedAt?: unknown };
    if (typeof id !== "string" || !id || id.length > 256 || seen.has(id)) continue;
    if (typeof deletedAt !== "number" || !Number.isFinite(deletedAt)) continue;
    seen.add(id);
    out.push({ id, title: typeof title === "string" ? title.slice(0, MAX_TITLE) : "", deletedAt });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Chat `id` moved to Trash at `now`; a chat already there keeps its first date. */
export function trashPut(entries: TrashEntry[], id: string, title: string, now: number): TrashEntry[] {
  if (entries.some((e) => e.id === id)) return entries.slice();
  return coerceTrash([{ id, title, deletedAt: now }, ...entries]);
}

/** Chat `id` out of Trash (restored, or deleted for good). */
export function trashDrop(entries: TrashEntry[], id: string): TrashEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Whether an entry has been in Trash for the full 30 days at `now`. */
export function trashExpired(entry: TrashEntry, now: number, days = TRASH_DAYS): boolean {
  return now - entry.deletedAt >= days * DAY_MS;
}

/**
 * Delete for good every chat past its 30 days, through `remove` (the agent's
 * idempotent DELETE). An entry leaves the list only once its delete went
 * through; one the agent could not take now (it is restarting) stays, and is
 * tried again on the next purge. Younger entries are never touched.
 */
export async function purgeExpired(
  entries: TrashEntry[],
  now: number,
  remove: (id: string) => Promise<unknown>,
): Promise<{ entries: TrashEntry[]; purged: string[] }> {
  const purged: string[] = [];
  for (const e of entries) {
    if (!trashExpired(e, now)) continue;
    try {
      await remove(e.id);
      purged.push(e.id);
    } catch { /* kept for the next purge */ }
  }
  return { entries: entries.filter((e) => !purged.includes(e.id)), purged };
}

/** The file's entries; a missing or unreadable file is an empty Trash. */
export function readTrash(path: string): TrashEntry[] {
  try {
    return coerceTrash(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/** Written whole through a temp file, so a crash mid-write leaves the old list. */
export function writeTrash(path: string, entries: TrashEntry[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries: coerceTrash(entries) }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
