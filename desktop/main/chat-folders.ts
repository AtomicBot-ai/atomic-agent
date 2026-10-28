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
 *   projects: {folderId: projectPath}   ATO-1253: the folder kept for each
 *            Claude Code project, so a renamed folder keeps its chats
 *   auto:    {sessionId: true}   chats the sorting placed, which it may move
 *            again; the person's own placements are never in it
 *   projectSort: false in a file from before ATO-1253, whose one "Claude
 *            Code" folder is split into project folders once
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatFolder { id: string; name: string; collapsed: boolean }
export interface ChatFolders {
  version: 1; folders: ChatFolder[]; chats: Record<string, string | null>; autoSort: boolean;
  projects: Record<string, string>; auto: Record<string, true>; projectSort: boolean;
}

const MAX_FOLDERS = 200;
const MAX_CHATS = 20000;
const MAX_NAME = 80;
const MAX_PATH = 4096;
const ID_RE = /^f[a-z0-9]{1,24}$/;

export function chatFoldersPath(stateDir: string): string {
  return join(stateDir, "chat-folders.json");
}

export function emptyChatFolders(): ChatFolders {
  return { version: 1, folders: [], chats: {}, autoSort: true, projects: {}, auto: {}, projectSort: true };
}

/** Whatever was read or sent, as a valid value: unknown keys, bad ids and dangling links dropped. */
export function coerceChatFolders(raw: unknown): ChatFolders {
  const out = emptyChatFolders();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { folders?: unknown; chats?: unknown; autoSort?: unknown; projects?: unknown; auto?: unknown; projectSort?: unknown };
  const ids = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const f of r.folders.slice(0, MAX_FOLDERS)) {
      if (!f || typeof f !== "object") continue;
      const { id, name, collapsed } = f as { id?: unknown; name?: unknown; collapsed?: unknown };
      if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) continue;
      // Cut by characters, not UTF-16 units, as the renderer counts them: an emoji is never split.
      const nm = typeof name === "string" ? Array.from(name.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim()).slice(0, MAX_NAME).join("") : "";
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
  if (r.projects && typeof r.projects === "object" && !Array.isArray(r.projects)) {
    for (const [fid, dir] of Object.entries(r.projects as Record<string, unknown>)) {
      if (ids.has(fid) && typeof dir === "string" && dir && dir.length <= MAX_PATH) out.projects[fid] = dir;
    }
  }
  if (r.auto && typeof r.auto === "object" && !Array.isArray(r.auto)) {
    for (const [sid, on] of Object.entries(r.auto as Record<string, unknown>)) {
      if (on === true && typeof out.chats[sid] === "string") out.auto[sid] = true;
    }
  }
  out.projectSort = r.projectSort === true;
  return out;
}

/** The folders on disk, or empty ones. Never throws. */
export function readChatFolders(stateDir: string): ChatFolders {
  const path = chatFoldersPath(stateDir);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return emptyChatFolders(); }
  try {
    return coerceChatFolders(JSON.parse(text));
  } catch {
    // A file that does not parse is set aside, not overwritten by the next save: the folders in it can be recovered.
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* left as it is */ }
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
