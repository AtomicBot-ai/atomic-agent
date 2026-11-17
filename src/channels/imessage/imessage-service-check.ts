/**
 * Decide whether a message really came over iMessage.
 *
 * Only iMessage authenticates the sender; an SMS relayed by Text
 * Message Forwarding (or RCS) carries a caller id anyone can spoof, so
 * the owner check is worthless for it. `imsg watch --json` does not
 * print the per-message service, and the chat GUID prefix it does print
 * says nothing for the `any;-;<handle>` chats newer Messages keeps per
 * contact. When the stream leaves the service `unknown`, this module
 * reads `message.service` for that rowid straight from
 * `~/Library/Messages/chat.db`, opened read-only.
 *
 * Fail closed throughout: only the exact value "iMessage" passes. A
 * lookup that fails (no Full Disk Access, missing file, locked schema)
 * refuses the message and is logged once with the Full Disk Access hint,
 * not once per message.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ImsgMessage } from "./imsg-event.js";
import { IMSG_DISK_ACCESS_HINT, scrubImessageError } from "./imsg-errors.js";

/** `message.service` for a chat.db rowid, `null` when the row is absent. May throw. */
export type MessageServiceLookup = (rowId: number) => string | null;

export const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

/**
 * Read-only lookup against chat.db. The connection opens on first use
 * (construction touches no files) and is reused; `close()` releases it.
 */
export class ChatDbServiceLookup {
  private db: BetterSqlite3.Database | null = null;
  private stmt: BetterSqlite3.Statement | null = null;

  constructor(private readonly path: string = CHAT_DB_PATH) {}

  readonly lookup: MessageServiceLookup = (rowId) => {
    if (!this.stmt) {
      // `readonly` + `fileMustExist`: this process must never create or
      // write the Messages database, not even an empty one.
      const db = new DatabaseCtor(this.path, { readonly: true, fileMustExist: true });
      try {
        this.stmt = db.prepare("SELECT service FROM message WHERE ROWID = ?");
      } catch (err) {
        db.close();
        throw err;
      }
      this.db = db;
    }
    const row = this.stmt.get(rowId) as { service?: unknown } | undefined;
    return row && typeof row.service === "string" ? row.service : null;
  };

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed.
    }
    this.db = null;
    this.stmt = null;
  }
}

/** Applies the iMessage-only rule to one message. */
export class ServiceCheck {
  private loggedFailure = false;

  constructor(
    private readonly deps: { lookup?: MessageServiceLookup; logger: StructuredLogger },
  ) {}

  /** True only when the message is proven to be iMessage. Never throws. */
  isIMessage(message: ImsgMessage): boolean {
    if (message.service === "iMessage") return true;
    if (message.service !== "unknown" || !this.deps.lookup) return false;
    try {
      const service = this.deps.lookup(message.rowId);
      return service !== null && service.trim().toLowerCase() === "imessage";
    } catch (err) {
      if (!this.loggedFailure) {
        this.loggedFailure = true;
        this.deps.logger.warn("imessage: cannot read message service from chat.db; refusing unverified messages", {
          error: scrubImessageError(err),
          hint: IMSG_DISK_ACCESS_HINT,
        });
      }
      return false;
    }
  }
}
