/**
 * Parse one line of `imsg watch --json` output.
 *
 * `imsg` (steipete/imsg, MIT) prints newline-delimited JSON, one object
 * per new message. Every field name the channel depends on is read
 * here and nowhere else, so a change in the CLI's schema is a one-file
 * fix. Field names follow the imsg JSON contract (docs/json.md,
 * "Message"): `id`, `chat_id`, `sender`, `is_from_me`, `text`,
 * `is_group`, `attachments`, `type`, `is_reaction`.
 *
 * Anything that is not a well-formed new message parses to `null` and
 * is dropped: the stream also carries edits, unsends and (with
 * `--reactions`) tapbacks, none of which is a request to the agent.
 */

/** A new inbound or outbound message, narrowed to what the channel reads. */
export interface ImsgMessage {
  /** chat.db rowid. Monotonic for new rows: the resume cursor. */
  rowId: number;
  /** chat.db chat rowid. Routing handle for groups, session key for all. */
  chatId: number;
  /** Raw handle of the author: phone number or Apple ID e-mail. */
  sender: string;
  /** True for messages this Mac sent: our own replies included. */
  isFromMe: boolean;
  isGroup: boolean;
  text: string;
  /** Number of files on the message. The channel does not ingest them yet. */
  attachmentCount: number;
}

/**
 * `null` for a blank line, a line that is not JSON, a mutation update
 * (`type: "edited" | "unsent"`), a tapback, or an object missing the
 * fields a message needs. Never throws.
 */
export function parseImsgLine(line: string): ImsgMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // Edits and unsends reuse an older row; acting on them would replay a
  // request the owner already sent (or one they took back).
  if (obj.type !== undefined) return null;
  if (obj.is_reaction === true) return null;
  const rowId = obj.id;
  const chatId = obj.chat_id;
  if (!isPositiveInt(rowId) || !isPositiveInt(chatId)) return null;
  return {
    rowId,
    chatId,
    sender: typeof obj.sender === "string" ? obj.sender : "",
    isFromMe: obj.is_from_me === true,
    isGroup: obj.is_group === true,
    text: typeof obj.text === "string" ? obj.text : "",
    attachmentCount: Array.isArray(obj.attachments) ? obj.attachments.length : 0,
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Splits a byte stream into lines. A chunk from a pipe can end in the
 * middle of a line; the tail is held until the next chunk completes it.
 * A runaway line with no newline is dropped once it passes `maxLine`
 * so a broken child cannot grow memory without bound.
 */
export class LineSplitter {
  private buffer = "";

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLine = 1024 * 1024,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLine) this.buffer = "";
  }

  /** Flush a final line that had no trailing newline. */
  end(): void {
    if (this.buffer.length > 0) this.onLine(this.buffer);
    this.buffer = "";
  }
}
