import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Per-chat session map for a remote-control channel.
 *
 * One flat JSON file per channel (`<stateDir>/telegram-session.json`,
 * `<stateDir>/discord-session.json`) mapping a **chat key** — a Telegram
 * chat id (plus forum-topic id), a Discord channel id — to the agent
 * session that chat is talking to. Each chat is its own conversation:
 * two Discord channels, or two Telegram groups, never share context.
 *
 * File shape (v2):
 *
 *     {
 *       "version": 2,
 *       "chats": {
 *         "<chatKey>": { "current": "s-…", "history": ["s-…"], "label": "…", "updatedAt": 1 }
 *       }
 *     }
 *
 * The v1 file was a single `{ current, history }` for the whole channel.
 * It is read as `legacy` and handed to the first direct-message chat
 * that asks for it (`adoptLegacy`), so an operator upgrading mid-
 * conversation keeps their DM session instead of silently starting over.
 * Group / guild chats never inherit it — the old shared session was, in
 * practice, the DM.
 *
 * Same robustness contract as the v1 pointer: corrupt or truncated
 * files read as empty rather than wedging the channel, writes are
 * atomic (tmp + rename), and the file stays hand-editable.
 */
export interface ChatSessionEntry {
  current: string | null;
  /** Rotated-away ids, newest first, capped at `HISTORY_LIMIT`. */
  history?: readonly string[];
  /** Human label for `/sessions` — chat title, channel id, "DM". */
  label?: string;
  /** Last time `current` changed (ms since epoch). */
  updatedAt?: number;
}

export interface ChatSessionMapData {
  chats: Record<string, ChatSessionEntry>;
  /** Un-adopted v1 pointer, if the file predates per-chat sessions. */
  legacy?: ChatSessionEntry;
}

const FILE_VERSION = 2;
const HISTORY_LIMIT = 16;
const EMPTY_ENTRY: ChatSessionEntry = { current: null };

export class ChatSessionMap {
  constructor(private readonly path: string) {}

  read(): ChatSessionMapData {
    if (!existsSync(this.path)) return { chats: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // A truncated write must not brick the channel: start fresh.
      return { chats: {} };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { chats: {} };
    }
    const obj = parsed as Record<string, unknown>;
    if (!("chats" in obj) && "current" in obj) {
      // v1: one pointer for the whole channel.
      const legacy = parseEntry(obj);
      return legacy.current || (legacy.history?.length ?? 0) > 0
        ? { chats: {}, legacy }
        : { chats: {} };
    }
    const chats: Record<string, ChatSessionEntry> = {};
    const rawChats = obj.chats;
    if (rawChats && typeof rawChats === "object" && !Array.isArray(rawChats)) {
      for (const [key, value] of Object.entries(
        rawChats as Record<string, unknown>,
      )) {
        if (!key || !value || typeof value !== "object") continue;
        chats[key] = parseEntry(value as Record<string, unknown>);
      }
    }
    const data: ChatSessionMapData = { chats };
    if (obj.legacy && typeof obj.legacy === "object") {
      const legacy = parseEntry(obj.legacy as Record<string, unknown>);
      if (legacy.current || (legacy.history?.length ?? 0) > 0) {
        data.legacy = legacy;
      }
    }
    return data;
  }

  /** The entry for `chatKey`; `{ current: null }` when unknown. */
  get(chatKey: string): ChatSessionEntry {
    return this.read().chats[chatKey] ?? EMPTY_ENTRY;
  }

  /** Every chat that has (or had) a session, insertion order. */
  entries(): Array<{ chatKey: string; entry: ChatSessionEntry }> {
    return Object.entries(this.read().chats).map(([chatKey, entry]) => ({
      chatKey,
      entry,
    }));
  }

  /** Whether the file still carries an un-adopted v1 pointer. */
  hasLegacy(): boolean {
    return this.read().legacy !== undefined;
  }

  /**
   * Point `chatKey` at `sessionId`. A different previous `current` is
   * pushed into history so `/switch` never loses the session it left.
   */
  setCurrent(chatKey: string, sessionId: string, label?: string): void {
    const data = this.read();
    const prev = data.chats[chatKey] ?? EMPTY_ENTRY;
    // Free the target's own slot *before* capping, so switching back to
    // an archived id never evicts the oldest entry for nothing.
    const rest = (prev.history ?? []).filter((h) => h !== sessionId);
    const history =
      prev.current && prev.current !== sessionId
        ? pushHistory(prev.current, rest)
        : rest;
    data.chats[chatKey] = buildEntry(sessionId, history, label ?? prev.label);
    this.write(data);
  }

  /**
   * Rotate `chatKey`: push its current id into history (capped) and
   * drop `current` so the next inbound message allocates a fresh
   * session. Idempotent when the chat has no current session.
   */
  rotate(chatKey: string): void {
    const data = this.read();
    const prev = data.chats[chatKey];
    if (!prev?.current) return;
    data.chats[chatKey] = buildEntry(
      null,
      pushHistory(prev.current, prev.history),
      prev.label,
    );
    this.write(data);
  }

  /**
   * Hand the un-adopted v1 pointer to `chatKey`. Returns the adopted
   * session id, or `null` when there is nothing to adopt or the chat
   * already has an entry. Clears `legacy` so it is adopted once.
   */
  adoptLegacy(chatKey: string, label?: string): string | null {
    const data = this.read();
    if (!data.legacy) return null;
    if (data.chats[chatKey]) return null;
    const { legacy } = data;
    delete data.legacy;
    data.chats[chatKey] = buildEntry(legacy.current, legacy.history, label);
    this.write(data);
    return legacy.current;
  }

  /** Forget a chat entirely (no history kept). */
  remove(chatKey: string): void {
    const data = this.read();
    if (!(chatKey in data.chats)) return;
    delete data.chats[chatKey];
    this.write(data);
  }

  /** Drop every chat and any legacy pointer. Used on hard reset. */
  reset(): void {
    if (!existsSync(this.path)) return;
    this.write({ chats: {} });
  }

  private write(data: ChatSessionMapData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const chats: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(data.chats)) {
      chats[key] = serializeEntry(entry);
    }
    const payload: Record<string, unknown> = { version: FILE_VERSION, chats };
    if (data.legacy) payload.legacy = serializeEntry(data.legacy);
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}

function parseEntry(obj: Record<string, unknown>): ChatSessionEntry {
  const current =
    typeof obj.current === "string" && obj.current.length > 0
      ? obj.current
      : null;
  const history = (Array.isArray(obj.history) ? obj.history : []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const entry: ChatSessionEntry = { current };
  if (history.length > 0) entry.history = history;
  if (typeof obj.label === "string" && obj.label.length > 0) {
    entry.label = obj.label;
  }
  if (typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)) {
    entry.updatedAt = obj.updatedAt;
  }
  return entry;
}

function buildEntry(
  current: string | null,
  history: readonly string[] | undefined,
  label: string | undefined,
): ChatSessionEntry {
  const entry: ChatSessionEntry = { current, updatedAt: Date.now() };
  if (history && history.length > 0) entry.history = history;
  if (label) entry.label = label;
  return entry;
}

function pushHistory(
  id: string,
  history: readonly string[] | undefined,
): readonly string[] {
  return [id, ...(history ?? []).filter((h) => h !== id)].slice(
    0,
    HISTORY_LIMIT,
  );
}

function serializeEntry(entry: ChatSessionEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { current: entry.current };
  if (entry.history && entry.history.length > 0) {
    out.history = [...entry.history];
  }
  if (entry.label) out.label = entry.label;
  if (entry.updatedAt !== undefined) out.updatedAt = entry.updatedAt;
  return out;
}
