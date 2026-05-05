import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Persisted pointer that maps the Telegram channel to its currently
 * active agent session. Mirrors the spirit of
 * `WebhookSessionStore` — flat JSON file, robust to corruption,
 * recoverable by hand-editing — but the contents are scoped to the
 * single-operator channel: one `current` session id plus a bounded
 * `history` of rotated ids for `/new` audit.
 */
export interface TelegramSessionPointerData {
  current: string | null;
  history?: readonly string[];
}

const HISTORY_LIMIT = 16;

export class TelegramSessionPointer {
  constructor(private readonly path: string) {}

  read(): TelegramSessionPointerData {
    if (!existsSync(this.path)) return { current: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return { current: null };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { current: null };
    }
    const obj = parsed as Record<string, unknown>;
    const current =
      typeof obj.current === "string" && obj.current.length > 0
        ? obj.current
        : null;
    const rawHistory = Array.isArray(obj.history) ? obj.history : [];
    const history = rawHistory.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return history.length > 0 ? { current, history } : { current };
  }

  /** Set the current session id, preserving any prior history. */
  setCurrent(sessionId: string): void {
    const data = this.read();
    this.write({
      current: sessionId,
      ...(data.history && data.history.length > 0
        ? { history: data.history }
        : {}),
    });
  }

  /**
   * Rotate the pointer: push the current id into history (capped) and
   * drop `current` so the next inbound DM allocates a fresh session.
   * Idempotent when `current` is already null.
   */
  rotate(): void {
    const data = this.read();
    if (!data.current) return;
    const history = [data.current, ...(data.history ?? [])].slice(
      0,
      HISTORY_LIMIT,
    );
    this.write({ current: null, history });
  }

  /** Drop both `current` and `history`. Used on hard reset. */
  reset(): void {
    if (!existsSync(this.path)) return;
    this.write({ current: null });
  }

  private write(data: TelegramSessionPointerData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: Record<string, unknown> = { current: data.current };
    if (data.history && data.history.length > 0) {
      payload.history = [...data.history];
    }
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}
