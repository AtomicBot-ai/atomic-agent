import { join } from "node:path";

import { checkSenderAuth, buildMailTaskMessage, isAllowedSender } from "../atomic-mail/atomic-mail-trigger-message.js";
import { MAX_TASKS_PER_POLL } from "../atomic-mail/atomic-mail-trigger.js";
import {
  buildAttachmentUserMessage,
  createAttachmentInbox,
  type AttachmentOutcome,
} from "../channels/attachments/inbox.js";
import type { WebhookConfig } from "../config/index.js";
import { resolveImapSecret, type ImapTriggerConfig } from "../config/imap-trigger-config.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import { saveMailAttachments } from "./imap-attachments.js";
import { ImapClient, connectImapTls, type ImapSelectResult, type ImapTransport } from "./imap-client.js";
import { authservIdOf, parseImapMessage } from "./imap-message.js";
import {
  IMAP_TRIGGER_STATE_FILENAME,
  readImapTriggerState,
  writeImapTriggerState,
  type ImapBindingState,
} from "./imap-trigger-state.js";

/**
 * A task from a mail in the operator's own mailbox over IMAP (ATO-601),
 * for a webhook binding with `source: "imap"`. The sibling of the Atomic
 * Mail trigger (`atomic-mail-trigger.ts`) and built on the same rules,
 * so both sources behave alike:
 *
 *  - an empty `email.allowedSenders` keeps the binding off;
 *  - the first contact primes it: what is already in the folder is skipped;
 *  - a mail is marked handled (its UID) before its task is created, so a
 *    crash loses at most one task and never makes two;
 *  - a sender off the list, or one the receiving server did not
 *    authenticate (see `checkSenderAuth`; with `imap.authservId`, the
 *    topmost `Authentication-Results` must also carry that id), creates
 *    nothing, is logged, and the mail is left as it was (still unread,
 *    never downloaded past its header);
 *  - only mail from an auto-start sender (`email.autoStartSenders`, by
 *    default the mailbox's own address, `imap.user` when it is one)
 *    starts its task right away; any other allowed sender's task is
 *    created paused and waits for the person to start it, as for Atomic
 *    Mail (decided 18.11.2026);
 *  - at most {@link MAX_TASKS_PER_POLL} tasks per pass;
 *  - the subject and body reach the task fenced as untrusted data, the
 *    saved attachments as a list of paths below it.
 *
 * Only unread mail (`UNSEEN`) above the last handled UID is looked at;
 * a mail that became a task is marked `\Seen` (`imap.markSeen`).
 *
 * Push: with `imap.idle` (the default) one connection per binding stays
 * open in IDLE and a new mail is handled at once. The scheduler's tick
 * (only the leading process ticks, see `scheduler-leadership.ts`)
 * starts that connection and keeps it alive: when ticks stop (this
 * process lost the lead, or the scheduler stopped) the connection
 * closes. A server without IDLE, or a connection that failed, falls
 * back to polling every `email.pollIntervalMs`, and IDLE is retried
 * with a growing back-off.
 */

/** UIDs whose headers are read per pass. */
export const IMAP_HEADER_BATCH = 50;
/** RFC 2177 asks for a fresh IDLE at least every 29 minutes; a pass also runs then. */
export const IMAP_IDLE_CYCLE_MS = 10 * 60 * 1000;
/** The IDLE connection stays only while ticks keep coming within this window. */
export const IMAP_IDLE_LEASE_MIN_MS = 2 * 60 * 1000;
export const IMAP_IDLE_LEASE_MAX_MS = 10 * 60 * 1000;
export const IMAP_IDLE_RETRY_MIN_MS = 60 * 1000;
export const IMAP_IDLE_RETRY_MAX_MS = 30 * 60 * 1000;
/** A mail bigger than this many times the attachment budget is not downloaded (base64 and text overhead). */
const MESSAGE_SIZE_FACTOR = 1.5;
const MESSAGE_SIZE_SLACK = 1024 * 1024;

export type ImapConnect = (cfg: ImapTriggerConfig, signal?: AbortSignal) => Promise<ImapTransport>;

export interface ImapMailTriggerOptions {
  stateDir: string;
  /** The live `webhooks` block; read on every tick so edits apply without a restart. */
  bindings: () => Record<string, WebhookConfig>;
  createTask: (input: {
    binding: string;
    userMessage: string;
    sessionId: string | null;
    /** Not from an auto-start sender: the task waits for the person to start it. */
    startPaused: boolean;
  }) => { id: string };
  resolveSessionId: (binding: string, cfg: WebhookConfig) => string | null;
  logger?: Pick<StructuredLogger, "info" | "warn" | "debug">;
  /** Test seams. */
  connect?: ImapConnect;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  idleCycleMs?: number;
}

export type ImapBinding = WebhookConfig & {
  email: NonNullable<WebhookConfig["email"]>;
  imap: ImapTriggerConfig;
};

/** The bindings that run: IMAP source and a non-empty allow-list. */
export function activeImapBindings(bindings: Record<string, WebhookConfig>): Array<[string, ImapBinding]> {
  return Object.entries(bindings).filter(
    (entry): entry is [string, ImapBinding] =>
      entry[1].source === "imap" &&
      entry[1].imap !== undefined &&
      entry[1].email !== undefined &&
      entry[1].email.allowedSenders.length > 0,
  );
}

/**
 * Senders whose mail task starts at once: the binding's
 * `autoStartSenders`, or by default the mailbox's own address (the login
 * name, when it is an address). A login that is not an address gives
 * none, so every task then waits.
 */
export function imapAutoStartSenders(cfg: ImapBinding): string[] {
  if (cfg.email.autoStartSenders) return cfg.email.autoStartSenders;
  const user = cfg.imap.user.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user) ? [user] : [];
}

function accountKey(imap: ImapTriggerConfig): string {
  return `${imap.user.toLowerCase()}@${imap.host}:${imap.port}/${imap.mailbox}`;
}

/** What makes a running IDLE connection stale: any change but the sender rules. */
function connectionKey(cfg: ImapBinding): string {
  return JSON.stringify(cfg.imap);
}

interface IdleWorker {
  key: string;
  controller: AbortController;
  done: Promise<void>;
}

interface PassResult {
  /** More new mail is waiting than this pass handled. */
  backlog: boolean;
}

const defaultConnect: ImapConnect = (cfg, signal) =>
  connectImapTls(cfg.host, cfg.port, signal ? { signal } : {});

export class ImapMailTrigger {
  private busy = false;
  private readonly statePath: string;
  private readonly lastPoll = new Map<string, number>();
  private readonly workers = new Map<string, IdleWorker>();
  /** Per binding: when IDLE may be tried again, and how many failures in a row. */
  private readonly idleRetry = new Map<string, { at: number; failures: number }>();
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastGap = 0;
  private watched: AbortSignal | null = null;
  private readonly clock: () => number;

  constructor(private readonly options: ImapMailTriggerOptions) {
    this.statePath = join(options.stateDir, IMAP_TRIGGER_STATE_FILENAME);
    this.clock = options.clock ?? Date.now;
  }

  /** One scheduler tick. Never throws; overlapping calls are dropped. */
  async tick(now: number, signal?: AbortSignal): Promise<void> {
    if (Number.isFinite(this.lastTickAt)) this.lastGap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (signal && this.watched !== signal) {
      this.watched = signal;
      signal.addEventListener("abort", () => this.stopAll(), { once: true });
    }
    if (signal?.aborted || this.busy) return;
    this.busy = true;
    try {
      const active = activeImapBindings(this.options.bindings());
      const names = new Set(active.map(([name]) => name));
      for (const [name, worker] of this.workers) {
        const cfg = active.find(([n]) => n === name)?.[1];
        if (!names.has(name) || !cfg?.imap.idle || worker.key !== connectionKey(cfg)) worker.controller.abort();
      }
      for (const [name, cfg] of active) {
        if (cfg.imap.idle && !this.workers.has(name) && now >= (this.idleRetry.get(name)?.at ?? 0)) {
          this.startIdle(name, cfg);
        }
        if (this.workers.has(name)) continue;
        if (now - (this.lastPoll.get(name) ?? Number.NEGATIVE_INFINITY) < cfg.email.pollIntervalMs) continue;
        this.lastPoll.set(name, now);
        await this.pollOnce(name, cfg, signal);
      }
    } catch (err) {
      this.options.logger?.warn("imap trigger tick failed", { error: errorText(err) });
    } finally {
      this.busy = false;
    }
  }

  /** Closes every IDLE connection and waits for them to finish. */
  async stop(): Promise<void> {
    const pending = [...this.workers.values()].map((w) => {
      w.controller.abort();
      return w.done;
    });
    await Promise.all(pending);
  }

  private stopAll(): void {
    for (const worker of this.workers.values()) worker.controller.abort();
  }

  /** Ticks still arrive: this process still leads the scheduler. */
  private leaseValid(): boolean {
    const lease = Math.min(IMAP_IDLE_LEASE_MAX_MS, Math.max(IMAP_IDLE_LEASE_MIN_MS, 3 * this.lastGap));
    return this.clock() - this.lastTickAt <= lease;
  }

  private async pollOnce(name: string, cfg: ImapBinding, signal: AbortSignal | undefined): Promise<void> {
    let client: ImapClient | null = null;
    try {
      const opened = await this.open(name, cfg, signal);
      client = opened.client;
      await this.pass(name, cfg, client, opened.box);
    } catch (err) {
      this.options.logger?.warn("imap trigger: poll failed", { binding: name, error: errorText(err) });
    } finally {
      await client?.logout();
    }
  }

  private startIdle(name: string, cfg: ImapBinding): void {
    const controller = new AbortController();
    const worker: IdleWorker = {
      key: connectionKey(cfg),
      controller,
      done: Promise.resolve(),
    };
    this.workers.set(name, worker);
    worker.done = this.runIdle(name, cfg, controller.signal).finally(() => {
      if (this.workers.get(name) === worker) this.workers.delete(name);
      // Polling picks up from here on its own interval.
      this.lastPoll.set(name, this.clock());
    });
  }

  private async runIdle(name: string, cfg: ImapBinding, signal: AbortSignal): Promise<void> {
    let client: ImapClient | null = null;
    const onAbort = () => client?.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const opened = await this.open(name, cfg, signal);
      client = opened.client;
      if (signal.aborted) return;
      if (!client.has("IDLE")) {
        this.options.logger?.info("imap trigger: server has no IDLE; polling instead", { binding: name });
        // Not a failure, but no point asking again soon.
        this.idleRetry.set(name, { at: this.clock() + IMAP_IDLE_RETRY_MAX_MS, failures: 0 });
        return;
      }
      this.options.logger?.info("imap trigger: waiting for new mail (IDLE)", { binding: name });
      let box: ImapSelectResult = opened.box;
      for (;;) {
        if (signal.aborted || !this.leaseValid()) return;
        const latest = activeImapBindings(this.options.bindings()).find(([n]) => n === name)?.[1];
        if (!latest || connectionKey(latest) !== connectionKey(cfg)) return;
        const result = await this.pass(name, latest, client, box);
        this.idleRetry.delete(name);
        if (signal.aborted) return;
        const wait = result.backlog ? latest.email.pollIntervalMs : (this.options.idleCycleMs ?? IMAP_IDLE_CYCLE_MS);
        const outcome = await client.idle(wait, signal);
        if (outcome === "aborted") return;
        // SELECT again: cheap, and it catches a UIDVALIDITY change.
        box = await client.select(latest.imap.mailbox);
      }
    } catch (err) {
      if (signal.aborted) return;
      const prev = this.idleRetry.get(name)?.failures ?? 0;
      const delay = Math.min(IMAP_IDLE_RETRY_MAX_MS, IMAP_IDLE_RETRY_MIN_MS * 2 ** prev);
      this.idleRetry.set(name, { at: this.clock() + delay, failures: prev + 1 });
      this.options.logger?.warn("imap trigger: IDLE connection failed; polling until it is retried", {
        binding: name,
        error: errorText(err),
        retryInMs: delay,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      await client?.logout();
    }
  }

  private async open(
    name: string,
    cfg: ImapBinding,
    signal: AbortSignal | undefined,
  ): Promise<{ client: ImapClient; box: ImapSelectResult }> {
    const secret = resolveImapSecret(cfg.imap, this.options.env ?? process.env);
    if (!secret) {
      throw new Error(
        cfg.imap.passwordEnv
          ? `no password: ${cfg.imap.passwordEnv} is not set`
          : "no password configured",
      );
    }
    const transport = await (this.options.connect ?? defaultConnect)(cfg.imap, signal);
    const client = new ImapClient(transport);
    try {
      await client.ready();
      if (cfg.imap.auth === "xoauth2") await client.authenticateXoauth2(cfg.imap.user, secret);
      else await client.login(cfg.imap.user, secret);
      const box = await client.select(cfg.imap.mailbox);
      this.options.logger?.debug("imap trigger: connected", { binding: name, mailbox: cfg.imap.mailbox });
      return { client, box };
    } catch (err) {
      client.close();
      throw err;
    }
  }

  private updateEntry(name: string, entry: ImapBindingState): void {
    // Reread so another binding's write in between is kept.
    const state = readImapTriggerState(this.statePath);
    state.bindings[name] = entry;
    writeImapTriggerState(this.statePath, state);
  }

  /** One pass over the folder: new unread mail becomes tasks. */
  private async pass(name: string, cfg: ImapBinding, client: ImapClient, box: ImapSelectResult): Promise<PassResult> {
    const account = accountKey(cfg.imap);
    const entry = readImapTriggerState(this.statePath).bindings[name];
    if (!entry || entry.account !== account || entry.uidValidity !== box.uidValidity) {
      const lastUid =
        box.uidNext !== null && box.uidNext > 0
          ? box.uidNext - 1
          : (await client.uidSearch("ALL")).reduce((max, uid) => Math.max(max, uid), 0);
      this.updateEntry(name, { account, uidValidity: box.uidValidity, lastUid });
      this.options.logger?.info("imap trigger primed; mail already in the folder is skipped", {
        binding: name,
        reason: !entry ? "first run" : entry.account !== account ? "mailbox changed" : "UIDVALIDITY changed",
      });
      return { backlog: false };
    }
    const uids = (await client.uidSearch(`UNSEEN UID ${entry.lastUid + 1}:*`))
      .filter((uid) => uid > entry.lastUid)
      .sort((a, b) => a - b);
    if (uids.length === 0) return { backlog: false };
    const batch = uids.slice(0, IMAP_HEADER_BATCH);
    const heads = await client.uidFetch(batch, "(UID RFC822.SIZE BODY.PEEK[HEADER])");
    const sizeCap = cfg.imap.attachments.maxTotalBytes * MESSAGE_SIZE_FACTOR + MESSAGE_SIZE_SLACK;
    let created = 0;
    let handled = 0;
    for (const uid of batch) {
      if (created >= MAX_TASKS_PER_POLL) break;
      handled += 1;
      // Another process (the previous scheduler leader, during a hand-over)
      // may have taken this mail already: the file is the referee.
      const fresh = readImapTriggerState(this.statePath).bindings[name];
      if (fresh && fresh.account === account && fresh.uidValidity === box.uidValidity && fresh.lastUid >= uid) {
        entry.lastUid = fresh.lastUid;
        continue;
      }
      entry.lastUid = uid;
      this.updateEntry(name, entry);
      const head = heads.get(uid);
      if (!head?.body) continue; // gone (moved or expunged) since the search
      const id = `${box.uidValidity}:${uid}`;
      const headerMail = parseImapMessage(head.body, id).mail;
      const autoStart = imapAutoStartSenders(cfg);
      const why = this.refusal(headerMail, cfg, autoStart);
      if (why) {
        this.options.logger?.info("mail trigger: message ignored", { binding: name, source: "imap", reason: why });
        continue;
      }
      let parsed = { mail: headerMail, attachments: [] as ReturnType<typeof parseImapMessage>["attachments"] };
      let note: AttachmentOutcome[] = [];
      if (head.size !== null && head.size > sizeCap) {
        parsed.mail = {
          ...headerMail,
          text: `(This mail is ${Math.round(head.size / 1024)} KB, over what the agent downloads; its body and attachments were not fetched.)`,
        };
      } else {
        const full = (await client.uidFetch([uid], "(UID BODY.PEEK[])")).get(uid);
        if (full?.body) parsed = parseImapMessage(full.body, id);
      }
      if (parsed.attachments.length > 0) {
        const inbox = createAttachmentInbox({ dir: join(this.options.stateDir, "inbox", "email", safeDirName(name)) });
        note = await saveMailAttachments(parsed.attachments, cfg.imap.attachments, inbox);
      }
      const message = buildMailTaskMessage(cfg.userMessageTemplate, parsed.mail);
      // Auto-start needs proof that the receiving server wrote the auth
      // header: without `imap.authservId` the topmost Authentication-Results
      // may be the sender's own, so the task waits for the person.
      const startPaused =
        !isAllowedSender(headerMail.fromEmail, autoStart) || (!cfg.imap.authservId && !cfg.email.trustFromHeader);
      const task = this.options.createTask({
        binding: name,
        userMessage: note.length > 0 ? buildAttachmentUserMessage(message, note) : message,
        sessionId: this.options.resolveSessionId(name, cfg),
        startPaused,
      });
      created += 1;
      this.options.logger?.info(startPaused ? "mail trigger: task created, waiting to be started" : "mail trigger: task created", {
        binding: name,
        source: "imap",
        taskId: task.id,
        attachments: note.filter((n) => n.status === "saved").length,
      });
      if (cfg.imap.markSeen) {
        try {
          await client.markSeen([uid]);
        } catch (err) {
          this.options.logger?.warn("imap trigger: could not mark the mail read", { binding: name, error: errorText(err) });
        }
      }
    }
    return { backlog: handled < uids.length };
  }

  private refusal(
    mail: { fromEmail: string; authResults: string | null },
    cfg: ImapBinding,
    autoStart: readonly string[],
  ): string | null {
    if (!isAllowedSender(mail.fromEmail, cfg.email.allowedSenders) && !isAllowedSender(mail.fromEmail, autoStart)) {
      return "sender not in allowedSenders";
    }
    if (cfg.email.trustFromHeader) return null;
    if (cfg.imap.authservId && authservIdOf(mail.authResults) !== cfg.imap.authservId) {
      return `topmost Authentication-Results is not from ${cfg.imap.authservId}`;
    }
    const auth = checkSenderAuth(mail.authResults, mail.fromEmail);
    return auth.ok ? null : `sender not authenticated: ${auth.reason}`;
  }
}

/** A binding name as one safe path segment. */
function safeDirName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "binding";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
