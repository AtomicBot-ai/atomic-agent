/**
 * ATO-2332: the chat Trash's routes (main/chat-trash.ts says what it keeps):
 *
 *   chatTrash:list     -> { ok, entries }   purges what is past 30 days first
 *   chatTrash:put      { id, title } -> { ok, entry }   Delete… on a chat row
 *   chatTrash:restore  { id } -> { ok }     back to the lists (the agent never lost it)
 *   chatTrash:forget   { id } -> { ok }     Delete forever: DELETE /api/sessions/{id}, then out of Trash
 *   chatTrash:empty    -> { ok, purged }    Empty Trash: Delete forever on every entry
 *
 * The purge also runs a minute after start and every six hours, so a window
 * left open for weeks still deletes a chat once its 30 days are over.
 * Every change goes through one queue: a purge and a put never write over
 * each other's list.
 */

import { join } from "node:path";

import { app, ipcMain } from "electron";

import { requestErrorText, type AgentClient } from "./agent-client.js";
import { purgeExpired, readTrash, trashDrop, trashPut, writeTrash, type TrashEntry } from "./chat-trash.js";

const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_PURGE_MS = 60 * 1000;

const trashPath = () => join(app.getPath("userData"), "chat-trash.json");

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

export function wireChatTrashIpc(client: Pick<AgentClient, "deleteSession">): void {
  const remove = (id: string) => client.deleteSession(id);

  const purge = () => inQueue(async () => {
    const before = readTrash(trashPath());
    const out = await purgeExpired(before, Date.now(), remove);
    if (out.purged.length) writeTrash(trashPath(), out.entries);
    return out;
  });

  ipcMain.handle("chatTrash:list", async () => {
    try {
      const out = await purge();
      return { ok: true, entries: out.entries };
    } catch (err) {
      return { ok: false, error: requestErrorText(err), entries: readTrash(trashPath()) };
    }
  });

  ipcMain.handle("chatTrash:put", (_event, payload: unknown) => inQueue(() => {
    const id = idOf(payload);
    if (!id) return { ok: false, error: "id required" };
    const rawTitle = (payload as { title?: unknown }).title;
    const title = typeof rawTitle === "string" ? rawTitle : "";
    try {
      const entries = trashPut(readTrash(trashPath()), id, title, Date.now());
      writeTrash(trashPath(), entries);
      return { ok: true, entry: entries.find((e) => e.id === id) as TrashEntry };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  ipcMain.handle("chatTrash:restore", (_event, payload: unknown) => inQueue(() => {
    const id = idOf(payload);
    if (!id) return { ok: false, error: "id required" };
    try {
      writeTrash(trashPath(), trashDrop(readTrash(trashPath()), id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  ipcMain.handle("chatTrash:forget", (_event, payload: unknown) => inQueue(async () => {
    const id = idOf(payload);
    if (!id) return { ok: false, error: "id required" };
    try {
      await remove(id);   // idempotent: a chat already gone answers 200
    } catch (err) {
      return { ok: false, error: requestErrorText(err) };   // kept in Trash: nothing was deleted
    }
    try {
      writeTrash(trashPath(), trashDrop(readTrash(trashPath()), id));
    } catch { /* the chat is gone; the next list drops nothing, a Restore brings back nothing */ }
    return { ok: true };
  }));

  ipcMain.handle("chatTrash:empty", () => inQueue(async () => {
    const purged: string[] = [];
    let error: string | undefined;
    for (const e of readTrash(trashPath())) {
      try {
        await remove(e.id);
        purged.push(e.id);
      } catch (err) {
        error = requestErrorText(err);
      }
    }
    try {
      writeTrash(trashPath(), readTrash(trashPath()).filter((e) => !purged.includes(e.id)));
    } catch { /* as for chatTrash:forget */ }
    return error ? { ok: false, error, purged } : { ok: true, purged };
  }));

  setTimeout(() => { void purge().catch(() => undefined); }, FIRST_PURGE_MS).unref();
  setInterval(() => { void purge().catch(() => undefined); }, PURGE_EVERY_MS).unref();
}
