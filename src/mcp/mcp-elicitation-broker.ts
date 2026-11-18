/**
 * MCP elicitation broker (ATO-1492).
 *
 * The one `McpElicitationPort` a host hands the runtime. It keeps the
 * open questions of every MCP server in one place and lets any number
 * of "presenters" (a desktop window on `GET /api/events`, the TUI, a
 * chat bridge) show them and send the person's answer back.
 *
 * Why its own broker and not the approval gate: an approval can be
 * answered by the approval ladder on its own (level 5 approves
 * everything, "always allow" rules, the in-chat grant). An elicitation
 * must only ever be answered by a person, even a plain "confirm?" with
 * no fields. So it never goes near the gate.
 *
 * Rules:
 *   1. Nobody attached means nobody can answer: the surface is `none`
 *      and the handler declines at once without asking (cron tasks,
 *      heartbeats, overnight runs, a serve with no window open).
 *   2. `accept` only comes from `answer()`, i.e. from a presenter that
 *      showed the form to a person. The answer is checked against the
 *      form before the question is closed, so a person can fix a typo
 *      instead of the server getting a cancel.
 *   3. When the last presenter goes away while questions are open
 *      (the window closed), they wait `detachGraceMs` for one to come
 *      back (a reload, an SSE reconnect), then answer `unavailable`.
 *   4. Answers are never logged or kept: the broker forgets a question
 *      the moment it is closed.
 */

import { randomUUID } from "node:crypto";

import type {
  McpElicitationPort,
  McpElicitationQuestion,
  McpElicitationReply,
  McpElicitationSurface,
} from "./mcp-elicitation-handler.js";
import { validateElicitationAnswer } from "./mcp-elicitation-answer.js";
import { isRecord } from "./mcp-elicitation-schema.js";

/** One open question as a presenter sees it. */
export interface PendingMcpElicitation {
  /** Broker-local id, the key a presenter answers with. */
  id: string;
  question: McpElicitationQuestion;
  /** ISO time the server asked. */
  askedAt: string;
}

/** How an open question was closed. `answered` is the person's own choice. */
export type McpElicitationCloseReason =
  | "answered"
  | "server_cancelled"
  | "no_presenter";

export type McpElicitationBrokerEvent =
  | { type: "asked"; request: PendingMcpElicitation }
  | {
      type: "closed";
      id: string;
      /** Never carries the content of an accepted answer. */
      action: McpElicitationReply["action"];
      reason: McpElicitationCloseReason;
    };

/**
 * Something that can show a question to a person. `interactive` is a
 * person at the screen (desktop, TUI); `remote-chat` is a chat bridge
 * where the person may not be looking (the handler gives up after 5
 * minutes there).
 */
export interface McpElicitationPresenter {
  surface: Exclude<McpElicitationSurface, "none">;
  onEvent(event: McpElicitationBrokerEvent): void;
}

export type McpElicitationAnswerResult =
  | { ok: true }
  | { ok: false; error: "not_pending" | "bad_action" | "invalid_answer"; reason?: string };

export interface McpElicitationBrokerOptions {
  /** How long open questions wait for a presenter to come back. Default 30 s. */
  detachGraceMs?: number;
  /** Test seam. */
  now?: () => Date;
  /** Test seam. */
  newId?: () => string;
}

export const DEFAULT_ELICITATION_DETACH_GRACE_MS = 30_000;

interface OpenQuestion {
  pending: PendingMcpElicitation;
  settle: (reply: McpElicitationReply, reason: McpElicitationCloseReason) => void;
}

export class McpElicitationBroker implements McpElicitationPort {
  private readonly presenters = new Set<McpElicitationPresenter>();
  private readonly open = new Map<string, OpenQuestion>();
  private readonly detachGraceMs: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: McpElicitationBrokerOptions = {}) {
    this.detachGraceMs = options.detachGraceMs ?? DEFAULT_ELICITATION_DETACH_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /**
   * Read by the handler for every request. The best surface attached
   * right now wins: a person at the screen over a chat bridge.
   */
  readonly surface = (): McpElicitationSurface => {
    let best: McpElicitationSurface = "none";
    for (const p of this.presenters) {
      if (p.surface === "interactive") return "interactive";
      best = "remote-chat";
    }
    return best;
  };

  /**
   * Start showing questions. Every question already open is sent to the
   * new presenter at once, so a reloaded window gets its form back.
   * Returns the detach function.
   */
  attach(presenter: McpElicitationPresenter): () => void {
    this.presenters.add(presenter);
    this.clearGrace();
    for (const { pending } of this.open.values()) {
      deliver(presenter, { type: "asked", request: pending });
    }
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.presenters.delete(presenter);
      if (this.presenters.size === 0 && this.open.size > 0) this.startGrace();
    };
  }

  ask(question: McpElicitationQuestion, signal: AbortSignal): Promise<McpElicitationReply> {
    if (this.presenters.size === 0) {
      return Promise.resolve({ action: "unavailable", reason: "no presenter attached" });
    }
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    return new Promise<McpElicitationReply>((resolve) => {
      const id = this.newId();
      const pending: PendingMcpElicitation = {
        id,
        question,
        askedAt: this.now().toISOString(),
      };
      const onAbort = (): void => settle({ action: "cancel" }, "server_cancelled");
      const settle = (reply: McpElicitationReply, reason: McpElicitationCloseReason): void => {
        if (!this.open.delete(id)) return;
        signal.removeEventListener("abort", onAbort);
        if (this.open.size === 0) this.clearGrace();
        this.broadcast({ type: "closed", id, action: reply.action, reason });
        resolve(reply);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.open.set(id, { pending, settle });
      this.broadcast({ type: "asked", request: pending });
    });
  }

  /**
   * The person's answer from a presenter. An `accept` whose content does
   * not fit the form is refused and the question stays open, so the
   * presenter can say what is wrong. `reason` names a field, never a value.
   */
  answer(id: string, reply: unknown): McpElicitationAnswerResult {
    const entry = this.open.get(id);
    if (!entry) return { ok: false, error: "not_pending" };
    if (!isRecord(reply)) return { ok: false, error: "bad_action" };
    const action = reply.action;
    if (action === "decline" || action === "cancel") {
      entry.settle({ action }, "answered");
      return { ok: true };
    }
    if (action !== "accept") return { ok: false, error: "bad_action" };
    const content = reply.content ?? {};
    const checked = validateElicitationAnswer(entry.pending.question.fields, content);
    if (!checked.ok) return { ok: false, error: "invalid_answer", reason: checked.reason };
    entry.settle({ action: "accept", content: checked.value }, "answered");
    return { ok: true };
  }

  /** Open questions, oldest first. */
  pending(): PendingMcpElicitation[] {
    return [...this.open.values()].map((e) => e.pending);
  }

  /** Close everything as `unavailable` (host shutting down). */
  closeAll(): void {
    for (const entry of [...this.open.values()]) {
      entry.settle({ action: "unavailable", reason: "host closed" }, "no_presenter");
    }
    this.clearGrace();
  }

  private broadcast(event: McpElicitationBrokerEvent): void {
    for (const p of [...this.presenters]) deliver(p, event);
  }

  private startGrace(): void {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.presenters.size > 0) return;
      for (const entry of [...this.open.values()]) {
        entry.settle({ action: "unavailable", reason: "presenter went away" }, "no_presenter");
      }
    }, this.detachGraceMs);
    // A pending grace must not keep a finished process alive.
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }
}

/** A presenter that throws must not break the broker or the other presenters. */
function deliver(presenter: McpElicitationPresenter, event: McpElicitationBrokerEvent): void {
  try {
    presenter.onEvent(event);
  } catch {
    // best effort, like the approval bus
  }
}
