import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Pi's on-disk session format, kept byte-compatible by its hard fork
 * Oh-My-Pi: `sessions/<cwd-slug>/<timestamp>_<id>.jsonl`, one JSON
 * entry per line. The first line is a `{type:"session"}` header
 * carrying the session id and `cwd`; `{type:"message"}` entries wrap
 * the user / assistant / toolResult messages; Oh-My-Pi's `title` slot
 * and `title_change` audit entries feed the session title (last one
 * wins — the audit trail ends on the current title). Every other
 * entry type (compaction, model changes, labels, other Oh-My-Pi
 * extensions) is skipped. Entries form a tree via `id`/`parentId` for
 * in-place branching; the projection keeps file order, which is
 * append (chronological) order.
 */
export class PiSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSourceError";
  }
}

/** Lightweight session header; the transcript is read separately. */
export interface PiSessionMeta {
  /**
   * Session id from the `<timestamp>_<id>.jsonl` filename; the header
   * line's own id wins at read time when present.
   */
  id: string;
  /** Absolute path to the `.jsonl` transcript. */
  file: string;
  /** File mtime in ms — the cheap recency key the listing sorts by. */
  mtimeMs: number;
}

/** A content block inside a projected transcript message. */
export type PiBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string | null;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      toolCallId: string | null;
      toolName: string | null;
      text: string;
      isError: boolean;
    };

/** A projected transcript message; `toolResult` is its own role in Pi. */
export interface PiMessage {
  role: "user" | "assistant" | "toolResult";
  blocks: PiBlock[];
  atMs: number;
}

/** A fully-read session: header fields plus the projected messages. */
export interface PiSessionData {
  id: string;
  cwd: string | null;
  /** Oh-My-Pi title (slot / audit entries); upstream Pi has none. */
  title: string | null;
  messages: PiMessage[];
}

/**
 * List transcript headers under a sessions root, newest-first by file
 * mtime. The canonical layout nests one directory per working dir
 * (`--<escaped-cwd>--/`); top-level `.jsonl` files are accepted too so
 * a hand-moved transcript still imports. Recency comes from the mtime
 * rather than a parse, so a preview never pays for sessions a `limit`
 * then discards.
 */
export function listPiFormatSessions(sessionsRoot: string): PiSessionMeta[] {
  if (!existsSync(sessionsRoot)) return [];
  const metas: PiSessionMeta[] = [];
  for (const entry of sortedEntries(sessionsRoot)) {
    const path = join(sessionsRoot, entry);
    if (entry.endsWith(".jsonl")) {
      pushMeta(metas, entry, path);
      continue;
    }
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const file of sortedEntries(path)) {
      if (!file.endsWith(".jsonl")) continue;
      pushMeta(metas, file, join(path, file));
    }
  }
  metas.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return metas;
}

/**
 * Read one transcript into a neutral session. Non-message entries and
 * non-conversation roles (`bashExecution`, `custom`) are skipped; a
 * message without a usable millisecond timestamp takes the entry's ISO
 * timestamp, then the file's mtime, so a session never lands with
 * `at: 0` and sinks to the bottom of every recency list.
 */
export function readPiFormatSession(meta: PiSessionMeta): PiSessionData {
  let text: string;
  try {
    text = readFileSync(meta.file, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PiSourceError(`failed to read ${meta.file}: ${message}`);
  }
  let id = meta.id;
  let cwd: string | null = null;
  let title: string | null = null;
  const fallbackAtMs = Math.round(meta.mtimeMs);
  const messages: PiMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string" && entry.id.length > 0) id = entry.id;
      if (cwd === null && typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    if (entry.type === "title" || entry.type === "title_change") {
      if (typeof entry.title === "string" && entry.title.length > 0) {
        title = entry.title;
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const at =
      typeof entry.timestamp === "string"
        ? (isoToMs(entry.timestamp) ?? fallbackAtMs)
        : fallbackAtMs;
    const projected = projectPiMessage(entry.message, at);
    if (projected) messages.push(projected);
  }
  return { id, cwd, title, messages };
}

function pushMeta(metas: PiSessionMeta[], basename: string, file: string): void {
  let mtimeMs: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return;
    mtimeMs = stats.mtimeMs;
  } catch {
    return;
  }
  const base = basename.slice(0, -".jsonl".length);
  const sep = base.indexOf("_");
  metas.push({ id: sep >= 0 ? base.slice(sep + 1) : base, file, mtimeMs });
}

function sortedEntries(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort();
}

function projectPiMessage(
  message: unknown,
  fallbackAtMs: number,
): PiMessage | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  // Message-level timestamps are Unix ms; entry timestamps are ISO.
  const atMs =
    typeof msg.timestamp === "number" &&
    Number.isFinite(msg.timestamp) &&
    msg.timestamp > 0
      ? msg.timestamp
      : fallbackAtMs;
  if (msg.role === "user") {
    const blocks = projectContentBlocks(msg.content, { thinking: false });
    return blocks.length > 0 ? { role: "user", blocks, atMs } : null;
  }
  if (msg.role === "assistant") {
    const blocks = projectContentBlocks(msg.content, { thinking: true });
    return blocks.length > 0 ? { role: "assistant", blocks, atMs } : null;
  }
  if (msg.role === "toolResult") {
    return {
      role: "toolResult",
      blocks: [
        {
          type: "toolResult",
          toolCallId:
            typeof msg.toolCallId === "string" ? msg.toolCallId : null,
          toolName:
            typeof msg.toolName === "string" && msg.toolName.length > 0
              ? msg.toolName
              : null,
          text: flattenTextBlocks(msg.content),
          isError: msg.isError === true,
        },
      ],
      atMs,
    };
  }
  return null;
}

function projectContentBlocks(
  content: unknown,
  accept: { thinking: boolean },
): PiBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: PiBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.length > 0) {
          blocks.push({ type: "text", text: block.text });
        }
        break;
      case "thinking":
        if (
          accept.thinking &&
          typeof block.thinking === "string" &&
          block.thinking.length > 0
        ) {
          blocks.push({ type: "thinking", thinking: block.thinking });
        }
        break;
      case "toolCall": {
        const name = block.name;
        if (typeof name !== "string" || name.length === 0) break;
        blocks.push({
          type: "toolCall",
          id: typeof block.id === "string" ? block.id : null,
          name,
          args:
            block.arguments &&
            typeof block.arguments === "object" &&
            !Array.isArray(block.arguments)
              ? (block.arguments as Record<string, unknown>)
              : {},
        });
        break;
      }
      default:
        // Image blocks (and Oh-My-Pi blob refs standing in for them)
        // have no textual projection and are skipped.
        break;
    }
  }
  return blocks;
}

/** Tool results carry a string or a list of blocks; keep the text. */
function flattenTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function isoToMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
