import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResponsePayload,
  SendMessageResult,
} from "./protocol.js";
import type { SidecarConnection } from "./transport.js";

/**
 * What to answer an `approval_request` with. `true` / `false` approve or
 * deny once; the object form carries the sidecar's `approval_response`
 * fields (a remembered `grant`, a deny `reason`, an `ask_user` `answer`).
 */
export type ApprovalDecision =
  | boolean
  | Omit<ApprovalResponsePayload, "approvalId">;

export type ApprovalHandler = (
  request: ApprovalRequestPayload,
) => ApprovalDecision | Promise<ApprovalDecision>;

export interface RunOptions {
  /** Ceiling on agent steps for this turn (`send_message.maxSteps`). */
  maxSteps?: number;
  /** Aborting sends `cancel` for this thread. */
  signal?: AbortSignal;
}

export interface RunResult {
  /** The turn's answer: the last `assistant_reply` that was not a progress note. */
  finalResponse: string;
  /** Why the turn ended: `reply`, `finish`, `max_steps`, `cancelled`, `failed`. */
  reason: string;
  turnCount: number;
  stepCount: number;
  /** Every event the turn produced, in order. */
  events: AgentEvent[];
}

export interface StreamedRun {
  /** The turn's events as they arrive; ends when the turn is over. */
  events: AsyncIterable<AgentEvent>;
  /** Settles once the turn is over, with the same data `run()` returns. */
  result: Promise<RunResult>;
}

/** @internal Wiring the agent hands each thread. */
export interface ThreadContext {
  connection: SidecarConnection;
  onApprovalRequest: ApprovalHandler | undefined;
  isCurrent: (thread: Thread) => boolean;
  ensureOpen: () => void;
}

/**
 * One agent session in the sidecar. Turns on a thread run one after the
 * other: the sidecar queues a second `send_message` behind the first.
 */
export class Thread {
  constructor(
    /** The sidecar's session id. */
    readonly id: string,
    /** The working directory the session was started in. */
    readonly workingDir: string,
    private readonly ctx: ThreadContext,
  ) {}

  /** Run one turn and resolve with its final answer and events. */
  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const streamed = this.runStreamed(prompt, options);
    // Drain the stream so its buffer does not grow; the result has the events.
    const iterator = streamed.events[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      // nothing: the result collects the events
    }
    return streamed.result;
  }

  /** Run one turn and stream its events as they arrive. */
  runStreamed(prompt: string, options: RunOptions = {}): StreamedRun {
    const channel = new EventChannel<AgentEvent>();
    const result = this.execute(prompt, options, channel);
    // Callers often only iterate `events`; the failure reaches them
    // there, so an unobserved `result` must not crash the process.
    result.catch(() => {});
    return { events: channel, result };
  }

  /**
   * Fold a message into the turn that is running now (`steer_message`).
   * Resolves `false` when nothing is running; send it with `run()` then.
   */
  async steer(text: string): Promise<boolean> {
    this.assertUsable();
    const res = await this.ctx.connection.request<{ steered: boolean }>(
      "steer_message",
      { sessionId: this.id, text },
    );
    return res.steered;
  }

  /** Cancel the turn that is running on this thread. */
  async cancel(): Promise<boolean> {
    this.assertUsable();
    const res = await this.ctx.connection.request<{ cancelled: boolean }>(
      "cancel",
      { sessionId: this.id },
    );
    return res.cancelled;
  }

  /** The persisted session state (`get_session`); its shape is the agent's `SessionState`. */
  async getSession(): Promise<unknown> {
    this.assertUsable();
    return this.ctx.connection.request("get_session", { sessionId: this.id });
  }

  private assertUsable(): void {
    this.ctx.ensureOpen();
    if (!this.ctx.isCurrent(this)) {
      throw new Error(
        `thread ${this.id} was replaced by a newer startThread(); the sidecar hosts one session at a time`,
      );
    }
  }

  private async execute(
    prompt: string,
    options: RunOptions,
    channel: EventChannel<AgentEvent>,
  ): Promise<RunResult> {
    const events: AgentEvent[] = [];
    let finalResponse = "";
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    try {
      this.assertUsable();
      if (options.signal?.aborted) throw abortError(options.signal);
      const { connection } = this.ctx;

      unsubscribe = connection.onEvent((event) => {
        const sessionId = (event.payload as { sessionId?: unknown } | null)
          ?.sessionId;
        if (typeof sessionId === "string" && sessionId !== this.id) return;
        events.push(event);
        if (event.type === "assistant_reply" && !event.payload.progressNote) {
          finalResponse = event.payload.text;
        }
        if (event.type === "approval_request") {
          void this.answerApproval(event.payload);
        }
        channel.push(event);
      });

      if (options.signal) {
        onAbort = () => {
          this.cancel().catch(() => {});
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      const res = await connection.request<SendMessageResult>("send_message", {
        sessionId: this.id,
        text: prompt,
        ...(typeof options.maxSteps === "number"
          ? { maxSteps: options.maxSteps }
          : {}),
      });
      const result: RunResult = {
        finalResponse,
        reason: res.reason,
        turnCount: res.turnCount,
        stepCount: res.stepCount,
        events,
      };
      channel.end();
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      channel.end(error);
      throw error;
    } finally {
      unsubscribe?.();
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async answerApproval(request: ApprovalRequestPayload): Promise<void> {
    let decision: ApprovalDecision = false;
    const handler = this.ctx.onApprovalRequest;
    if (handler) {
      try {
        decision = await handler(request);
      } catch {
        decision = false;
      }
    }
    const fields =
      typeof decision === "boolean" ? { approved: decision } : decision;
    try {
      await this.ctx.connection.request("approval_response", {
        ...fields,
        approvalId: request.approvalId,
      });
    } catch {
      // The sidecar exited or refused the answer (a grant the request
      // cannot take); the running turn reports that on its own.
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("run aborted");
}

/** A small push-to-pull queue: producers `push`, one consumer iterates. */
class EventChannel<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private waitingReject: ((error: Error) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.waitingReject = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(error?: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = error ?? null;
    if (this.waiting) {
      const resolve = this.waiting;
      const reject = this.waitingReject;
      this.waiting = null;
      this.waitingReject = null;
      if (error && reject) reject(error);
      else resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.done) {
          if (this.error) {
            const error = this.error;
            this.error = null;
            return Promise.reject(error);
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = resolve;
          this.waitingReject = reject;
        });
      },
    };
  }
}
