/**
 * Polling instead of a webhook (ATO-2464): no public address, no tunnel.
 *
 * Every `intervalMs` (60 s by default) the poller asks Linear for the
 * comments and assignments since its cursor and hands each one to the
 * same `onEvent` a webhook delivery reaches, so owners, mentions, the
 * loop guard and approvals behave the same. It is the Linear channel's
 * own scoped timer, like Telegram's long polling: one unref'd timeout
 * chain, cleared on `close()`.
 *
 * The cursor lives in `<stateDir>/linear-poll-cursor.json` with the keys
 * of the events already handled, so a restart neither replays nor skips.
 * With no cursor the poller starts from now (nothing old is answered);
 * after a long stop it looks back at most 24 hours, as Discord's
 * catch-up does. Each poll re-reads a minute before the cursor, because
 * a comment can commit with a `createdAt` just behind one already seen;
 * the handled keys keep that overlap from running anything twice.
 *
 * Implements the endpoint surface (`listen` / `close`), so the channel
 * starts and stops it exactly like the webhook server.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { LinearApiError, type LinearApi } from "./linear-api.js";
import { pollAssignments, pollComments, type PolledEvent } from "./linear-poll-queries.js";
import { LINEAR_API_KEY_KEY, scrubLinearError, type LinearWebhookPayload } from "./linear-types.js";

const OVERLAP_MS = 60_000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const HANDLED_CAP = 400;
const FILE_VERSION = 1;

export interface LinearPollerDeps {
  api: Pick<LinearApi, "query">;
  intervalMs: number;
  cursorPath: string;
  onEvent: (payload: LinearWebhookPayload, delivery: string) => void;
  /** The API key's user when assignment triggers are on, else `null` (comments only). */
  assignee: () => string | null;
  /** A poll after the first one found the key refused; the channel goes down. */
  onFatal: (message: string) => void;
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  now?: () => number;
}

interface CursorFile {
  since: number;
  handled: string[];
}

export const LINEAR_KEY_REFUSED = `Linear refused the API key. Check ${LINEAR_API_KEY_KEY}.`;

export class LinearPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor: CursorFile | null = null;
  /** With no saved cursor: events older than the start are seen, never answered. */
  private floorMs = 0;
  private readonly now: () => number;

  constructor(private readonly deps: LinearPollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** First poll now; rejects only when Linear refuses the key. Then every `intervalMs`. */
  async listen(): Promise<void> {
    this.running = true;
    this.floorMs = existsSync(this.deps.cursorPath) ? 0 : this.now();
    this.cursor = this.loadCursor();
    try {
      await this.pollOnce();
    } catch (err) {
      if (isAuth(err)) {
        this.running = false;
        throw new Error(LINEAR_KEY_REFUSED);
      }
      this.deps.logger.warn("linear: poll failed, retrying at the next interval", { error: scrubLinearError(err) });
    }
    this.schedule();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
    } catch (err) {
      if (isAuth(err)) {
        this.running = false;
        this.deps.onFatal(LINEAR_KEY_REFUSED);
        return;
      }
      this.deps.logger.warn("linear: poll failed, retrying at the next interval", { error: scrubLinearError(err) });
    }
    this.schedule();
  }

  /** One poll: fetch, hand over what is new, move and save the cursor. */
  async pollOnce(): Promise<void> {
    const cursor = this.cursor ?? (this.cursor = this.loadCursor());
    const sinceIso = new Date(cursor.since - OVERLAP_MS).toISOString();
    const events: PolledEvent[] = await pollComments(this.deps.api, sinceIso);
    const viewer = this.deps.assignee();
    if (viewer !== null) events.push(...(await pollAssignments(this.deps.api, viewer, sinceIso)));
    if (!this.running) return;
    events.sort((a, b) => a.createdAtMs - b.createdAtMs);
    const handled = new Set(cursor.handled);
    let since = cursor.since;
    for (const event of events) {
      since = Math.max(since, event.createdAtMs);
      if (handled.has(event.key)) continue;
      handled.add(event.key);
      if (event.createdAtMs < this.floorMs) continue;
      this.deps.onEvent(event.payload, `poll:${event.key}`);
    }
    this.cursor = { since, handled: [...handled].slice(-HANDLED_CAP) };
    this.saveCursor(this.cursor);
  }

  private loadCursor(): CursorFile {
    const now = this.now();
    const fresh: CursorFile = { since: now, handled: [] };
    if (!existsSync(this.deps.cursorPath)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.deps.cursorPath, "utf8")) as Partial<CursorFile> | null;
      if (typeof raw?.since !== "number" || !Number.isFinite(raw.since)) return fresh;
      const handled = Array.isArray(raw.handled) ? raw.handled.filter((k): k is string => typeof k === "string") : [];
      return { since: Math.min(now, Math.max(raw.since, now - MAX_LOOKBACK_MS)), handled };
    } catch {
      return fresh;
    }
  }

  private saveCursor(cursor: CursorFile): void {
    try {
      mkdirSync(dirname(this.deps.cursorPath), { recursive: true });
      const tmp = `${this.deps.cursorPath}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: FILE_VERSION, ...cursor }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.deps.cursorPath);
    } catch (err) {
      // The in-memory cursor still dedupes this process; a restart may re-read a little.
      this.deps.logger.warn("linear: could not save the poll cursor", { error: scrubLinearError(err) });
    }
  }
}

function isAuth(err: unknown): boolean {
  return err instanceof LinearApiError && err.code === "auth";
}
