/*
 * ATO-1034: chat folders, kept in the agent's state directory
 * (~/.atomic-agent/chat-folders.json) rather than in Electron's userData, so
 * the terminal, which shares that directory since ATO-416, can read the same
 * folders. The renderer owns the edits (chat-folders.js); main only reads,
 * checks the shape and writes the file whole, via a temp file.
 *
 * Shape (version 1):
 *   folders: [{id, name, collapsed}]   in the order the sidebar draws them
 *   chats:   {sessionId: folderId | null}   null = the person took it out of
 *            every folder, so automatic sorting leaves it alone
 *   autoSort: false when the person turned off sorting imported chats into a
 *            folder per app (on by default)
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatFolder { id: string; name: string; collapsed: boolean }
export interface ChatFolders { version: 1; folders: ChatFolder[]; chats: Record<string, string | null>; autoSort: boolean }

const MAX_FOLDERS = 200;
const MAX_CHATS = 20000;
const MAX_NAME = 80;
const ID_RE = /^f[a-z0-9]{1,24}$/;

export function chatFoldersPath(stateDir: string): string {
  return join(stateDir, "chat-folders.json");
}

export function emptyChatFolders(): ChatFolders {
  return { version: 1, folders: [], chats: {}, autoSort: true };
}

/** Whatever was read or sent, as a valid value: unknown keys, bad ids and dangling links dropped. */
export function coerceChatFolders(raw: unknown): ChatFolders {
  const out = emptyChatFolders();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { folders?: unknown; chats?: unknown; autoSort?: unknown };
  const ids = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const f of r.folders.slice(0, MAX_FOLDERS)) {
      if (!f || typeof f !== "object") continue;
      const { id, name, collapsed } = f as { id?: unknown; name?: unknown; collapsed?: unknown };
      if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) continue;
      const nm = typeof name === "string" ? name.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim().slice(0, MAX_NAME) : "";
      if (!nm) continue;
      ids.add(id);
      out.folders.push({ id, name: nm, collapsed: collapsed === true });
    }
  }
  if (r.chats && typeof r.chats === "object" && !Array.isArray(r.chats)) {
    let n = 0;
    for (const [sid, fid] of Object.entries(r.chats as Record<string, unknown>)) {
      if (n >= MAX_CHATS) break;
      if (!sid || sid.length > 512) continue;
      if (fid === null) { out.chats[sid] = null; n++; continue; }
      if (typeof fid === "string" && ids.has(fid)) { out.chats[sid] = fid; n++; }
    }
  }
  out.autoSort = r.autoSort !== false;
  return out;
}

/** The folders on disk, or empty ones. Never throws. */
export function readChatFolders(stateDir: string): ChatFolders {
  try {
    return coerceChatFolders(JSON.parse(readFileSync(chatFoldersPath(stateDir), "utf8")));
  } catch {
    return emptyChatFolders();
  }
}

/** Write the folders whole, via a temp file. Returns what was written. Never throws. */
export function writeChatFolders(stateDir: string, value: unknown): { ok: true; data: ChatFolders } | { ok: false; error: string } {
  const data = coerceChatFolders(value);
  const path = chatFoldersPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
