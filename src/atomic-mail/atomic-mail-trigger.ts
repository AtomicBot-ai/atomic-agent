import { join } from "node:path";

import type { WebhookConfig } from "../config/index.js";
import type { TaskStatus } from "../tasks/task-types.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { AtomicMailService } from "./atomic-mail-service.js";
import type { TriggerMail } from "./atomic-mail-trigger-batches.js";
import {
  buildMailReply,
  buildMailTaskMessage,
  checkSenderAuth,
  isAllowedSender,
} from "./atomic-mail-trigger-message.js";
import {
  MAIL_TRIGGER_STATE_FILENAME,
  SEEN_IDS_CAP,
  readMailTriggerState,
  writeMailTriggerState,
  type MailTriggerState,
} from "./atomic-mail-trigger-state.js";

/**
 * A task from an incoming e-mail (ATO-601). A webhook binding with
 * `source: "atomic-mail"` is fired by a new message in the agent's own
 * Atomic Mail inbox instead of an HTTP hit, and creates its task the
 * same way the webhook route does (`TaskRunner.create`, never
 * `runTurn`).
 *
 * Driven by the scheduler's tick (only the leading process polls, see
 * `scheduler-leadership.ts`), each binding at most every
 * `email.pollIntervalMs`. Rules, in order:
 *
 *  - a binding with an empty `allowedSenders` never polls;
 *  - its first poll only marks what is already in the inbox as seen;
 *  - a message is marked seen before its task is created, so a crash
 *    loses at most one task and never makes two;
 *  - the agent's own address, a sender off the list and a sender the
 *    receiving server did not authenticate (no `dmarc=pass` or aligned
 *    SPF/DKIM pass in the topmost `Authentication-Results`, see
 *    `checkSenderAuth`) create nothing and are logged, unless the
 *    binding sets `email.trustFromHeader`;
 *  - at most {@link MAX_TASKS_PER_POLL} tasks per poll — the rest wait;
 *  - the subject and body reach the task fenced as untrusted data.
 *
 * With `replyByEmail`, the agent's final answer goes back to the sender
 * when the task ends (a failed or blocked task gets a short note). No
 * approval is asked per reply: the config opt-in is the consent.
 */

export const MAX_TASKS_PER_POLL = 5;
/** Messages read per poll, newest first. */
export const INBOX_READ_LIMIT = 50;
/** How often finished tasks are looked for, to send their replies. */
export const REPLY_CHECK_MS = 15_000;
/** A reply not sent within this window is dropped. */
export const REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MailTriggerTask {
  status: TaskStatus;
  sessionId: string | null;
}

export interface AtomicMailTriggerOptions {
  stateDir: string;
  mail: Pick<AtomicMailService, "readiness" | "listInboxForTrigger" | "send">;
  /** The live `webhooks` block; read on every tick so edits apply without a restart. */
  bindings: () => Record<string, WebhookConfig>;
  createTask: (input: {
    binding: string;
    userMessage: string;
    sessionId: string | null;
  }) => { id: string };
  resolveSessionId: (binding: string, cfg: WebhookConfig) => string | null;
  getTask: (id: string) => MailTriggerTask | null;
  /** The agent's last answer in a session, for the reply. */
  readReplyText: (sessionId: string) => string | null;
  logger?: Pick<StructuredLogger, "info" | "warn" | "debug">;
}

type MailBinding = WebhookConfig & { email: NonNullable<WebhookConfig["email"]> };

/** The bindings that poll: mail source and a non-empty allow-list. */
export function activeMailBindings(
  bindings: Record<string, WebhookConfig>,
): Array<[string, MailBinding]> {
  return Object.entries(bindings).filter(
    (entry): entry is [string, MailBinding] =>
      entry[1].source === "atomic-mail" &&
      entry[1].email !== undefined &&
      entry[1].email.allowedSenders.length > 0,
  );
}

export class AtomicMailTrigger {
  private busy = false;
  private readonly lastPoll = new Map<string, number>();
  private lastReplyCheck = Number.NEGATIVE_INFINITY;
  private readonly statePath: string;

  constructor(private readonly options: AtomicMailTriggerOptions) {
    this.statePath = join(options.stateDir, MAIL_TRIGGER_STATE_FILENAME);
  }

  /** One scheduler tick. Never throws; overlapping calls are dropped. */
  async tick(now: number, signal?: AbortSignal): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = activeMailBindings(this.options.bindings()).filter(
        ([name, cfg]) =>
          now - (this.lastPoll.get(name) ?? Number.NEGATIVE_INFINITY) >=
          cfg.email.pollIntervalMs,
      );
      if (due.length > 0) await this.poll(due, now, signal);
      if (now - this.lastReplyCheck >= REPLY_CHECK_MS) {
        this.lastReplyCheck = now;
        await this.sendReplies(now, signal);
      }
    } catch (err) {
      this.options.logger?.warn("mail trigger tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
    }
  }

  private async poll(
    due: Array<[string, MailBinding]>,
    now: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [name] of due) this.lastPoll.set(name, now);
    const ready = this.options.mail.readiness();
    if (ready.level === "no_inbox") {
      this.options.logger?.debug("mail trigger: no Atomic Mail inbox; not polling");
      return;
    }
    const mails = await this.options.mail.listInboxForTrigger(INBOX_READ_LIMIT, {
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) return;
    const state = readMailTriggerState(this.statePath);
    for (const [name, cfg] of due) {
      this.pollBinding(name, cfg, mails, ready.address.toLowerCase(), state, now);
    }
  }

  private pollBinding(
    name: string,
    cfg: MailBinding,
    mails: readonly TriggerMail[],
    ownAddress: string,
    state: MailTriggerState,
    now: number,
  ): void {
    const entry = state.bindings[name];
    if (!entry) {
      state.bindings[name] = { seen: mails.map((m) => m.id).slice(0, SEEN_IDS_CAP) };
      writeMailTriggerState(this.statePath, state);
      this.options.logger?.info("mail trigger primed; mail already in the inbox is skipped", {
        binding: name,
        skipped: mails.length,
      });
      return;
    }
    const seen = new Set(entry.seen);
    const fresh = mails.filter((m) => m.id && !seen.has(m.id)).reverse();
    let created = 0;
    for (const mail of fresh) {
      if (created >= MAX_TASKS_PER_POLL) break;
      entry.seen = [...entry.seen, mail.id].slice(-SEEN_IDS_CAP);
      writeMailTriggerState(this.statePath, state);
      const why = this.refusal(mail, cfg, ownAddress);
      if (why) {
        this.options.logger?.info("mail trigger: message ignored", {
          binding: name,
          reason: why,
        });
        continue;
      }
      const task = this.options.createTask({
        binding: name,
        userMessage: buildMailTaskMessage(cfg.userMessageTemplate, mail),
        sessionId: this.options.resolveSessionId(name, cfg),
      });
      created += 1;
      this.options.logger?.info("mail trigger: task created", {
        binding: name,
        taskId: task.id,
      });
      if (cfg.email.replyByEmail) {
        state.pendingReplies.push({
          taskId: task.id,
          binding: name,
          to: mail.fromEmail,
          subject: mail.subject,
          createdAt: now,
        });
        writeMailTriggerState(this.statePath, state);
      }
    }
  }

  private refusal(mail: TriggerMail, cfg: MailBinding, ownAddress: string): string | null {
    if (mail.fromEmail === ownAddress) return "sent by the agent's own address";
    if (!isAllowedSender(mail.fromEmail, cfg.email.allowedSenders)) {
      return "sender not in allowedSenders";
    }
    if (!cfg.email.trustFromHeader) {
      const auth = checkSenderAuth(mail.authResults, mail.fromEmail);
      if (!auth.ok) return `sender not authenticated: ${auth.reason}`;
    }
    return null;
  }

  private async sendReplies(now: number, signal: AbortSignal | undefined): Promise<void> {
    const state = readMailTriggerState(this.statePath);
    if (state.pendingReplies.length === 0) return;
    const keep: typeof state.pendingReplies = [];
    for (const reply of state.pendingReplies) {
      const task = this.options.getTask(reply.taskId);
      if (!task || task.status === "cancelled" || now - reply.createdAt > REPLY_MAX_AGE_MS) {
        continue;
      }
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "blocked") {
        keep.push(reply);
        continue;
      }
      const replyText =
        task.status === "completed" && task.sessionId
          ? this.options.readReplyText(task.sessionId)
          : null;
      const mail = buildMailReply({ subject: reply.subject, outcome: task.status, replyText });
      try {
        await this.options.mail.send({ to: reply.to, ...mail }, signal ? { signal } : undefined);
      } catch (err) {
        keep.push(reply);
        this.options.logger?.warn("mail trigger: reply not sent; will retry", {
          taskId: reply.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Reread so a poll in between keeps its own additions.
    const latest = readMailTriggerState(this.statePath);
    const handled = new Set(state.pendingReplies.map((r) => r.taskId));
    latest.pendingReplies = [
      ...keep,
      ...latest.pendingReplies.filter((r) => !handled.has(r.taskId)),
    ];
    writeMailTriggerState(this.statePath, latest);
  }
}
