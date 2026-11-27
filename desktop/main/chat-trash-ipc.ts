/**
 * ATO-2332: the chat Trash's routes (main/chat-trash.ts says what it keeps):
 *
 *   chatTrash:list     -> { ok, entries }   purges what is past 30 days first, then follows
 *                      the agent's mark (ATO-2474, chat-trash-sync.ts)
 *   chatTrash:put      { id, title, pinned?, archived?, folder? } -> { ok, entry }   Delete… on a
 *                      chat row: stamps metadata.trashed on the agent first (its search leaves
 *                      the chat out); the entry keeps where the chat sat (ATO-2747)
 *   chatTrash:restore  { id } -> { ok, entry }   back to the lists: the stamp is cleared first;
 *                      `entry` says where the chat sat, for the window to put it back
 *   chatTrash:forget   { id } -> { ok }     Delete forever: DELETE /api/sessions/{id}, then out of Trash
 *   chatTrash:empty    -> { ok, purged, failed, total }   Empty Trash: Delete forever on every entry;
 *                      a partial run answers ok:false with the counts ("Deleted 7 of 9")
 *
 * ATO-2747: an error is one of TRASH_ERRORS, in plain words. What the agent or
 * the disk said (a message, an HTTP status, a path) is logged, never returned.
 *
 * The purge also runs a minute after start and every six hours, so a window
 * left open for weeks still deletes a chat once its 30 days are over.
 * Every change goes through one queue: a purge and a put never write over
 * each other's list.
 */

import { join } from "node:path";

import { app, ipcMain } from "electron";

import { requestErrorText, type AgentClient } from "./agent-client.js";
import { followAgent } from "./chat-trash-sync.js";
import {
  TRASH_ERRORS, coercePlace, emptyTrash, purgeExpired, readTrash, stampTrashed, trashDrop, trashPut, writeTrash,
  type TrashEntry, type TrashErrorKind,
} from "./chat-trash.js";

const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_PURGE_MS = 60 * 1000;

const trashPath = () => join(app.getPath("userData"), "chat-trash.json");
const migratedPath = () => join(app.getPath("userData"), "chat-trash-agent.json");

let queue: Promise<unknown> = Promise.resolve();
/** Run `job` after every job before it, whatever they returned. */
function inQueue<T>(job: () => Promise<T> | T): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

const idOf = (payload: unknown): string | null => {
  const id = (payload as { id?: unknown } | null)?.id;
  return typeof id === "string" && id && id.length <= 256 ? id : null;
};

const detailOf = (err: unknown): string => (err instanceof Error ? requestErrorText(err) : String(err));

/** The plain-words error for the window; what was really said goes to the log. */
function failed(kind: TrashErrorKind, detail?: string): { ok: false; error: string } {
  if (detail) console.warn(`[desktop] chat trash: ${kind}: ${detail}`);
  return { ok: false, error: TRASH_ERRORS[kind] };
}

export function wireChatTrashIpc(client: Pick<AgentClient, "deleteSession" | "sessionRoute" | "sessions">): void {
  const remove = (id: string) => client.deleteSession(id);
  const stamp = (id: string, trashed: boolean) =>
    stampTrashed((sid, path, method, body) => client.sessionRoute(sid, path, method, body, 10_000), id, trashed);

  const purge = () => inQueue(async () => {
    const before = readTrash(trashPath());
    const out = await purgeExpired(before, Date.now(), remove);
    if (out.purged.length) writeTrash(trashPath(), out.entries);
    return out;
  });

  // ATO-2474: the agent owns the mark; the list follows it (chat-trash-sync.ts).
  const follow = () => inQueue(() => followAgent(client, trashPath(), migratedPath(), (id) => stamp(id, true)));

  ipcMain.handle("chatTrash:list", async () => {
    try {
      const out = await purge();
      const followed = await follow().catch(() => null);
      return { ok: true, entries: followed ? followed.entries : out.entries };
    } catch (err) {
      return { ...failed("list", detailOf(err)), entries: readTrash(trashPath()) };
    }
  });

  ipcMain.handle("chatTrash:put", (_event, payload: unknown) => inQueue(async () => {
    const id = idOf(payload);
    if (!id) return failed("missing");
    const rawTitle = (payload as { title?: unknown }).title;
    const title = typeof rawTitle === "string" ? rawTitle : "";
    // The agent first: a chat its search could still read is not called "in Trash".
    const refused = await stamp(id, true);
    if (refused) return failed("hide", refused);
    try {
      const entries = trashPut(readTrash(trashPath()), id, title, Date.now(), coercePlace(payload));
      writeTrash(trashPath(), entries);
      return { ok: true, entry: entries.find((e) => e.id === id) as TrashEntry };
    } catch (err) {
      await stamp(id, false);   // not in Trash after all: searchable again, as it is still listed
      return failed("save", detailOf(err));
    }
  }));

  ipcMain.handle("chatTrash:restore", (_event, payload: unknown) => inQueue(async () => {
    const id = idOf(payload);
    if (!id) return failed("missing");
    // Cleared first: a failed clear keeps the chat in Trash, never listed while search still hides it.
    const refused = await stamp(id, false);
    if (refused) return failed("show", refused);
    try {
      const before = readTrash(trashPath());
      writeTrash(trashPath(), trashDrop(before, id));
      return { ok: true, entry: before.find((e) => e.id === id) ?? null };
    } catch (err) {
      return failed("save", detailOf(err));
    }
  }));

  ipcMain.handle("chatTrash:forget", (_event, payload: unknown) => inQueue(async () => {
    const id = idOf(payload);
    if (!id) return failed("missing");
    try {
      await remove(id);   // idempotent: a chat already gone answers 200
    } catch (err) {
      return failed("remove", detailOf(err));   // kept in Trash: nothing was deleted
    }
    try {
      writeTrash(trashPath(), trashDrop(readTrash(trashPath()), id));
    } catch { /* the chat is gone; the next list drops nothing, a Restore brings back nothing */ }
    return { ok: true };
  }));

  ipcMain.handle("chatTrash:empty", () => inQueue(async () => {
    const out = await emptyTrash(readTrash(trashPath()), (id) => remove(id).catch((err: unknown) => {
      throw new Error(detailOf(err));
    }));
    try {
      writeTrash(trashPath(), readTrash(trashPath()).filter((e) => !out.purged.includes(e.id)));
    } catch { /* as for chatTrash:forget */ }
    const counts = { purged: out.purged, failed: out.failed, total: out.total };
    return out.failed ? { ...failed("remove", out.detail), ...counts } : { ok: true, ...counts };
  }));

  setTimeout(() => { void purge().catch(() => undefined); }, FIRST_PURGE_MS).unref();
  setInterval(() => { void purge().catch(() => undefined); }, PURGE_EVERY_MS).unref();
}
