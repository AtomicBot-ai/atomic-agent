import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../../config/index.js";

/**
 * Chat folders made in the desktop app (ATO-1034), shown in the rail
 * and the picker (ATO-1180).
 *
 * The desktop keeps them in `<stateDir>/chat-folders.json`
 * (`desktop/main/chat-folders.ts` on the desktop branch), the state
 * directory the terminal shares since ATO-416:
 *
 *   folders: [{id, name, collapsed}]       in the order the sidebar draws them
 *   chats:   {sessionId: folderId | null}  null = taken out of every folder
 *   autoSort, projects, auto, projectSort  the desktop's own sorting state
 *
 * The terminal only reads it. A missing, unreadable or malformed file
 * is "no folders", never an error, and the file is never moved or
 * rewritten from here: the desktop owns it, and sets a bad file aside
 * itself the next time it reads it.
 */
export interface RailChatFolder {
  id: string;
  name: string;
}

export interface RailChatFolders {
  /** In the order the desktop draws them. */
  folders: readonly RailChatFolder[];
  /** Session id to folder id, only for chats that are in a folder. */
  chats: ReadonlyMap<string, string>;
}

export const NO_CHAT_FOLDERS: RailChatFolders = {
  folders: [],
  chats: new Map(),
};

// The desktop's own limits, so the terminal accepts exactly what it writes.
const MAX_FOLDERS = 200;
const MAX_CHATS = 20000;
const MAX_NAME = 80;
const ID_RE = /^f[a-z0-9]{1,24}$/;
/** Far above what 200 folders and 20000 chats take; a bigger file is not ours. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function chatFoldersPath(stateDir: string): string {
  return join(stateDir, "chat-folders.json");
}

/** Whatever was parsed, as folders: bad ids, empty names and dangling links dropped. */
export function coerceRailChatFolders(raw: unknown): RailChatFolders {
  if (!raw || typeof raw !== "object") return NO_CHAT_FOLDERS;
  const r = raw as { folders?: unknown; chats?: unknown };
  const folders: RailChatFolder[] = [];
  const ids = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const f of r.folders.slice(0, MAX_FOLDERS)) {
      if (!f || typeof f !== "object") continue;
      const { id, name } = f as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) continue;
      const nm =
        typeof name === "string"
          ? Array.from(name.replace(/\s+/g, " ").trim())
              .slice(0, MAX_NAME)
              .join("")
          : "";
      if (!nm) continue;
      ids.add(id);
      folders.push({ id, name: nm });
    }
  }
  const chats = new Map<string, string>();
  if (r.chats && typeof r.chats === "object" && !Array.isArray(r.chats)) {
    for (const [sid, fid] of Object.entries(r.chats as Record<string, unknown>)) {
      if (chats.size >= MAX_CHATS) break;
      if (!sid || sid.length > 512) continue;
      if (typeof fid === "string" && ids.has(fid)) chats.set(sid, fid);
    }
  }
  if (folders.length === 0) return NO_CHAT_FOLDERS;
  return { folders, chats };
}

/** The folders in `stateDir`, or none. Never throws, never writes. */
export function readRailChatFolders(stateDir: string): RailChatFolders {
  try {
    const path = chatFoldersPath(stateDir);
    if (statSync(path).size > MAX_FILE_BYTES) return NO_CHAT_FOLDERS;
    return coerceRailChatFolders(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return NO_CHAT_FOLDERS;
  }
}

/** Where the rail reads folders from. Injectable so tests never touch a state dir. */
export type RailChatFoldersSource = () => RailChatFolders;

/**
 * The default source: the configured state dir. The rail re-arranges on
 * every refresh, so the file is parsed again only when its size or
 * modification time changed.
 */
export function configRailChatFoldersSource(): RailChatFoldersSource {
  let cachedKey: string | null = null;
  let cached: RailChatFolders = NO_CHAT_FOLDERS;
  return () => {
    let key: string;
    const stateDir = getConfig().paths.stateDir;
    try {
      const stat = statSync(chatFoldersPath(stateDir));
      key = `${stateDir}\0${stat.size}\0${stat.mtimeMs}`;
    } catch {
      cachedKey = null;
      cached = NO_CHAT_FOLDERS;
      return cached;
    }
    if (key !== cachedKey) {
      cached = readRailChatFolders(stateDir);
      cachedKey = key;
    }
    return cached;
  };
}

/**
 * Group an arranged rail by folder: the pinned block stays on top as it
 * is, then each folder's chats in the desktop's folder order, then the
 * chats in no folder. Inside a group the incoming order (manual or
 * recency) is kept. Every entry in a folder gets its `folder` name
 * stamped, so a row can say where it lives; with no folders the list
 * comes back unchanged.
 */
export function groupRailByFolder<
  T extends { sessionId: string; pinned: boolean; folder?: string },
>(entries: readonly T[], folders: RailChatFolders): T[] {
  if (folders.folders.length === 0) return [...entries];
  const nameOf = new Map(folders.folders.map((f) => [f.id, f.name]));
  const stamp = (entry: T): T => {
    const fid = folders.chats.get(entry.sessionId);
    const name = fid === undefined ? undefined : nameOf.get(fid);
    return name === undefined ? entry : { ...entry, folder: name };
  };
  const pinned: T[] = [];
  const byFolder = new Map<string, T[]>(
    folders.folders.map((f) => [f.id, [] as T[]]),
  );
  const rest: T[] = [];
  for (const entry of entries) {
    if (entry.pinned) {
      pinned.push(stamp(entry));
      continue;
    }
    const fid = folders.chats.get(entry.sessionId);
    const bucket = fid === undefined ? undefined : byFolder.get(fid);
    if (bucket) bucket.push(stamp(entry));
    else rest.push(entry);
  }
  const grouped: T[] = [...pinned];
  for (const f of folders.folders) grouped.push(...(byFolder.get(f.id) ?? []));
  grouped.push(...rest);
  return grouped;
}

/**
 * The folder header to draw above row `index` of `rows`, or null. A
 * header opens each run of unpinned rows in one folder, and "no folder"
 * opens the unfiled rows that follow a folder. Pinned rows never get
 * one: the pinned block keeps its own place on top. `index === 0`
 * gets a header too, so a window that starts mid-group still says
 * which folder it is in.
 */
export function folderHeaderAt(
  rows: readonly { pinned: boolean; folder?: string }[],
  index: number,
): string | null {
  const row = rows[index];
  if (!row || row.pinned) return null;
  const prev = index > 0 ? rows[index - 1] : undefined;
  const prevFolder = prev && !prev.pinned ? prev.folder : undefined;
  if (row.folder !== undefined) {
    return prev && !prev.pinned && prevFolder === row.folder ? null : row.folder;
  }
  // An unfiled row: only worth a header right after a folder's rows.
  return prevFolder !== undefined ? "no folder" : null;
}
