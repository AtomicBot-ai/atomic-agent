import type { SessionState } from "../session/index.js";

/**
 * One resident session inside the sidecar's long-lived runtime. `session`
 * mirrors the latest persisted `SessionState` (updated after every turn);
 * `controller` is the abort channel for the session's current `chat.send`
 * (a fresh one is minted per send so a completed/cancelled turn never leaks
 * its aborted signal into the next).
 */
export interface SessionPoolEntry {
  session: SessionState;
  controller: AbortController;
}

/**
 * In-memory registry of the sessions the host has created or opened over
 * this sidecar connection. Persistence lives in `SessionStore`; the pool is
 * just the working set + per-session abort controllers. There is no
 * per-session runtime — the whole process shares one `AgentRuntime`.
 */
export class SessionPool {
  private readonly entries = new Map<string, SessionPoolEntry>();

  register(session: SessionState): SessionPoolEntry {
    const existing = this.entries.get(session.id);
    if (existing) {
      existing.session = session;
      return existing;
    }
    const entry: SessionPoolEntry = {
      session,
      controller: new AbortController(),
    };
    this.entries.set(session.id, entry);
    return entry;
  }

  get(sessionId: string): SessionPoolEntry | undefined {
    return this.entries.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Update the mirrored state after a turn persisted a new snapshot. */
  setSession(session: SessionState): void {
    const entry = this.entries.get(session.id);
    if (entry) entry.session = session;
  }

  /** Mint a fresh abort controller for a new `chat.send` and return it. */
  resetController(sessionId: string): AbortController {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`session not resident in pool: ${sessionId}`);
    entry.controller = new AbortController();
    return entry.controller;
  }

  delete(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.controller.abort();
    this.entries.delete(sessionId);
  }

  /** Abort every in-flight turn (used at shutdown). */
  abortAll(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
  }
}
