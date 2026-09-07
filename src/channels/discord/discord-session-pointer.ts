/**
 * Persisted pointer mapping the Discord channel to its active agent
 * session. Same contract as `TelegramSessionPointer` — flat JSON, safe
 * against corruption, hand-editable — kept separate so the two channels
 * never share a session: a turn started in Discord and a turn started
 * in Telegram are different conversations.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface DiscordSessionPointerData {
  current: string | null;
  history?: readonly string[];
}

const HISTORY_LIMIT = 16;

export class DiscordSessionPointer {
  constructor(private readonly path: string) {}

  read(): DiscordSessionPointerData {
    if (!existsSync(this.path)) return { current: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // A truncated write must not brick the channel: start fresh.
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
    const history = (Array.isArray(obj.history) ? obj.history : []).filter(
      (h): h is string => typeof h === "string" && h.length > 0,
    );
    return { current, history };
  }

  write(data: DiscordSessionPointerData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  set(sessionId: string): void {
    const prev = this.read();
    this.write({ current: sessionId, history: prev.history ?? [] });
  }

  /** Archive the current session and clear the pointer (`/new`). */
  rotate(): void {
    const prev = this.read();
    const history = [
      ...(prev.current ? [prev.current] : []),
      ...(prev.history ?? []),
    ].slice(0, HISTORY_LIMIT);
    this.write({ current: null, history });
  }
}
