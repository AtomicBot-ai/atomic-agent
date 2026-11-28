/**
 * ATO-2474: the agent owns the Trash mark; this file keeps the window's list
 * (chat-trash.json, main/chat-trash.ts) in line with it.
 *
 * The agent stamps `metadata.trashed` on a chat (POST /api/sessions/{id}/trashed)
 * and every list it serves leaves that chat out: the terminal's rail, its
 * picker, search, `--continue`. GET /api/sessions still lists it, with
 * `trashed` and `trashedAt`, so the window can follow the agent:
 *
 *   - Once per machine, every chat already in the window's Trash is stamped
 *     on the agent (`migrate`): chats put there while the agent had no route
 *     carried no mark, so the terminal still showed them. The run is done
 *     only when every stamp went through; a failed one is tried on the next
 *     start, and nothing is dropped until then.
 *   - After that, a chat the agent lists as out of Trash leaves the window's
 *     list (restored in the terminal with `/sessions --restore`), and a chat
 *     the agent lists as in Trash but the window does not know joins it, with
 *     the agent's date, so its 30 days run from when it really went there.
 *   - A chat the agent does not list (an agent from before ATO-2474, a list
 *     cut at 1000 rows, a chat already gone) is left as the window has it.
 *
 * Pure: no Electron, so test/chat-trash-sync.test.mjs loads it as built.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { coerceTrash, readTrash, writeTrash, type TrashEntry } from "./chat-trash.js";

/** One row of GET /api/sessions, as far as Trash goes. */
export type AgentTrashRow = { id: string; title: string; trashed: boolean; trashedAt: number | null };

/**
 * The rows of a GET /api/sessions answer, or null when it cannot be followed:
 * not a list, or an agent whose rows carry no `trashed` (from before ATO-2474).
 */
export function agentTrashRows(body: unknown): AgentTrashRow[] | null {
  const list = (body as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) return null;
  const out: AgentTrashRow[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const { id, title, trashed, trashedAt } = r as { id?: unknown; title?: unknown; trashed?: unknown; trashedAt?: unknown };
    if (typeof id !== "string" || !id) continue;
    if (typeof trashed !== "boolean") return null;
    out.push({
      id,
      title: typeof title === "string" ? title : "",
      trashed,
      trashedAt: typeof trashedAt === "number" && Number.isFinite(trashedAt) ? trashedAt : null,
    });
  }
  return out;
}

export type FollowResult = {
  entries: TrashEntry[];
  /** Every entry known to the agent now carries its mark (the one-time run is over). */
  migrated: boolean;
  /** Ids that left the list because the agent says they are out of Trash. */
  dropped: string[];
  /** Ids that joined the list from the agent's mark. */
  adopted: string[];
};

/**
 * `entries` in line with the agent's `rows`. `migrated`: the one-time stamping
 * run is already done. `stamp(id)` marks a chat in Trash on the agent and
 * answers null when done (chat-trash.ts stampTrashed).
 */
export async function followAgentTrash(
  entries: TrashEntry[],
  rows: AgentTrashRow[],
  opts: { migrated: boolean; now: number; stamp: (id: string) => Promise<string | null> },
): Promise<FollowResult> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const markedNow = new Set<string>();
  let migrated = opts.migrated;
  if (!migrated) {
    let all = true;
    for (const e of entries) {
      const row = byId.get(e.id);
      if (!row || row.trashed) continue;
      if ((await opts.stamp(e.id)) === null) markedNow.add(e.id);
      else all = false;
    }
    migrated = all;
  }
  const inTrash = (id: string) => markedNow.has(id) || byId.get(id)?.trashed === true;
  const dropped = migrated
    ? entries.filter((e) => byId.has(e.id) && !inTrash(e.id)).map((e) => e.id)
    : [];
  const kept = entries.filter((e) => !dropped.includes(e.id));
  const known = new Set(kept.map((e) => e.id));
  const joined = rows
    .filter((r) => r.trashed && !known.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, deletedAt: r.trashedAt ?? opts.now }));
  return {
    entries: coerceTrash([...kept, ...joined]),
    migrated,
    dropped,
    adopted: joined.map((e) => e.id),
  };
}

/** Whether the one-time run is done (the marker file, beside chat-trash.json). */
export function readMigrated(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { migratedAt?: unknown };
    return typeof raw.migratedAt === "number";
  } catch {
    return false;
  }
}

export function writeMigrated(path: string, now: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ migratedAt: now }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * One follow run, inside chat-trash-ipc.ts's queue: read the agent's list,
 * line the window's Trash up with it and save what changed. Null when the
 * agent cannot be followed now (not running, or older than ATO-2474); the
 * window's list is then used as it is.
 */
export async function followAgent(
  client: { sessions: () => Promise<unknown> },
  trashFile: string,
  markerFile: string,
  stamp: (id: string) => Promise<string | null>,
  now: number = Date.now(),
): Promise<FollowResult | null> {
  let body: unknown;
  try {
    body = await client.sessions();
  } catch {
    return null;
  }
  const rows = agentTrashRows(body);
  if (!rows) return null;
  const before = readTrash(trashFile);
  const wasMigrated = readMigrated(markerFile);
  const out = await followAgentTrash(before, rows, { migrated: wasMigrated, now, stamp });
  if (out.dropped.length || out.adopted.length) writeTrash(trashFile, out.entries);
  if (out.migrated && !wasMigrated) writeMigrated(markerFile, now);
  return out;
}
