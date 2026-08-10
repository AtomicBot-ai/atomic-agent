import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CancelledError,
  GrammarError,
  TransportError,
} from "../llm/index.js";
import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";
import type { RunTurnResult } from "../agent/agent-loop.js";

import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import type { TaskReport } from "./task-report.js";
import { TaskStore } from "./task-store.js";

interface RuntimeCall {
  sessionId: string;
  userMessage: string;
  origin: string | undefined;
}

interface FakeRuntimeOptions {
  /**
   * Per-call behaviour. Returning a `RunTurnResult` resolves; throwing
   * propagates verbatim. Sequence is consumed in order; once exhausted
   * the runtime defaults to a clean `reply`.
   */
  scripts?: Array<(call: RuntimeCall) => RunTurnResult | Promise<RunTurnResult> | never>;
}

function fakeRuntime(opts: FakeRuntimeOptions = {}): {
  runtime: TaskRunnerRuntime;
  calls: RuntimeCall[];
} {
  const calls: RuntimeCall[] = [];
  let cursor = 0;
  const runtime: TaskRunnerRuntime = {
    runTurn: async (session, userMessage, options) => {
      const call: RuntimeCall = {
        sessionId: session.id,
        userMessage,
        origin: options?.origin,
      };
      calls.push(call);
      const script = opts.scripts?.[cursor++];
      if (script) return await script(call);
      return defaultReply(session);
    },
  };
  return { runtime, calls };
}

function defaultReply(session: SessionState): RunTurnResult {
  return { session, reason: "reply", stepCount: 1 };
}

function fakeSessionLoader(session: SessionState | null) {
  return {
    load: (_id: string) => session,
  };
}

describe("TaskRunner", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-runner-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({
      id: "s-1",
      workingDir: "/tmp/work",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs a pending task to completion via runtime.runTurn(origin=scheduler)", async () => {
    const { runtime, calls } = fakeRuntime();
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hello",
      origin: "cli",
      maxAttempts: 1,
    });
    const final = await runner.runOne(t.id);
    expect(final?.status).toBe("completed");
    expect(calls).toEqual([
      { sessionId: session.id, userMessage: "hello", origin: "scheduler" },
    ]);
  });

  it("retries transport failures until under maxAttempts and eventually completes", async () => {
    const { runtime, calls } = fakeRuntime({
      scripts: [
        () => {
          throw new TransportError("boom", 503, "http://llama");
        },
        (call) => defaultReply({ ...session, id: call.sessionId }),
      ],
    });
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 3,
    });
    const outcome = await runner.drainPending();
    expect(outcome).toMatchObject({
      drained: 2,
      completed: 1,
      retried: 1,
      failed: 0,
    });
    expect(store.get(t.id)?.status).toBe("completed");
    expect(calls).toHaveLength(2);
  });

  it("marks failed once maxAttempts reached on retryable failures", async () => {
    const { runtime } = fakeRuntime({
      scripts: [
        () => {
          throw new TransportError("boom", 502, "http://llama");
        },
        () => {
          throw new TransportError("boom", 502, "http://llama");
        },
      ],
    });
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 2,
    });
    await runner.drainPending();
    const final = store.get(t.id);
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(2);
    expect(final?.lastErrorCategory).toBe("transport");
  });

  it("blocks immediately on grammar failures (no retry, even under maxAttempts)", async () => {
    const { runtime, calls } = fakeRuntime({
      scripts: [
        () => {
          throw new GrammarError("bad json", "raw");
        },
      ],
    });
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 5,
    });
    await runner.runOne(t.id);
    expect(store.get(t.id)?.status).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("propagates cancellation to the cancelled status", async () => {
    const { runtime } = fakeRuntime({
      scripts: [
        () => {
          throw new CancelledError();
        },
      ],
    });
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 3,
    });
    await runner.runOne(t.id);
    expect(store.get(t.id)?.status).toBe("cancelled");
  });

  it("blocks when the session is missing from the loader", async () => {
    const { runtime, calls } = fakeRuntime();
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(null),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: "missing-session",
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 3,
    });
    await runner.runOne(t.id);
    expect(store.get(t.id)?.status).toBe("blocked");
    expect(store.get(t.id)?.lastError).toContain("session_not_found");
    expect(calls).toHaveLength(0);
  });

  it("drainPending is a no-op when disabled", async () => {
    const { runtime } = fakeRuntime();
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: false,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 1,
    });
    const outcome = await runner.drainPending();
    expect(outcome.drained).toBe(0);
    expect(store.list()[0]?.status).toBe("pending");
  });

  it("drains tasks from different sessions in parallel", async () => {
    const sessionA: SessionState = createEmptySessionState({
      id: "s-a",
      workingDir: "/tmp",
    });
    const sessionB: SessionState = createEmptySessionState({
      id: "s-b",
      workingDir: "/tmp",
    });
    const sessions = new Map([
      [sessionA.id, sessionA],
      [sessionB.id, sessionB],
    ]);
    let inFlight = 0;
    let peakInFlight = 0;
    const runtime: TaskRunnerRuntime = {
      runTurn: async (session, _msg, _opts) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return defaultReply(session);
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: { load: (id) => sessions.get(id) ?? null },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    store.create({
      sessionId: sessionA.id,
      userMessage: "a1",
      origin: "cli",
      maxAttempts: 1,
    });
    store.create({
      sessionId: sessionB.id,
      userMessage: "b1",
      origin: "cli",
      maxAttempts: 1,
    });
    const outcome = await runner.drainPending();
    expect(outcome.completed).toBe(2);
    expect(peakInFlight).toBe(2);
  });

  it("drains same-session tasks sequentially (FIFO)", async () => {
    const observed: string[] = [];
    const runtime: TaskRunnerRuntime = {
      runTurn: async (session, msg, _opts) => {
        observed.push(msg);
        await new Promise((r) => setTimeout(r, 2));
        return defaultReply(session);
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    store.create(
      { sessionId: session.id, userMessage: "first", origin: "cli", maxAttempts: 1 },
      1_000,
    );
    store.create(
      { sessionId: session.id, userMessage: "second", origin: "cli", maxAttempts: 1 },
      2_000,
    );
    store.create(
      { sessionId: session.id, userMessage: "third", origin: "cli", maxAttempts: 1 },
      3_000,
    );
    await runner.drainPending();
    expect(observed).toEqual(["first", "second", "third"]);
  });

  it("create with runOnCreate=true persists and auto-drains the new task", async () => {
    const { runtime, calls } = fakeRuntime();
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: true,
      sleep: async () => undefined,
    });
    const created = runner.create({
      sessionId: session.id,
      userMessage: "auto",
      origin: "http",
      maxAttempts: 1,
    });
    expect(created.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(store.get(created.id)?.status).toBe("completed");
  });

  it("stamps wakeReason on session.metadata before runTurn", async () => {
    let observed: unknown = undefined;
    const runtime: TaskRunnerRuntime = {
      runTurn: async (session, _msg, _opts) => {
        observed = session.metadata?.wakeReason;
        return defaultReply(session);
      },
    };
    const saved: SessionState[] = [];
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      sessionFactory: {
        create: () => session,
        save: (state) => {
          saved.push({ ...state });
        },
      },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "http",
      triggerSource: "webhook",
      maxAttempts: 1,
    });
    await runner.runOne(t.id);
    expect(observed).toMatchObject({ source: "webhook", taskId: t.id });
    expect(saved.length).toBeGreaterThan(0);
  });

  it("carries webhookName from session metadata into wakeReason", async () => {
    session.metadata = { ...session.metadata, webhookName: "slack-ping" };
    let observed: unknown = undefined;
    const runtime: TaskRunnerRuntime = {
      runTurn: async (session, _msg, _opts) => {
        observed = session.metadata?.wakeReason;
        return defaultReply(session);
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      sessionFactory: {
        create: () => session,
        save: () => undefined,
      },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "http",
      triggerSource: "webhook",
      maxAttempts: 1,
    });
    await runner.runOne(t.id);
    expect(observed).toMatchObject({
      source: "webhook",
      webhookName: "slack-ping",
    });
  });

  it("treats a runTurn result of reason=failed as a retryable transport class", async () => {
    let calls = 0;
    const runtime: TaskRunnerRuntime = {
      runTurn: async (session, _msg, _opts) => {
        calls += 1;
        if (calls === 1) {
          return { session, reason: "failed" as const, stepCount: 1 };
        }
        return defaultReply(session);
      },
    };
    const runner = new TaskRunner({
      store,
      runtime,
      sessionLoader: fakeSessionLoader(session),
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
    });
    const t = store.create({
      sessionId: session.id,
      userMessage: "hi",
      origin: "cli",
      maxAttempts: 3,
    });
    await runner.drainPending();
    expect(store.get(t.id)?.status).toBe("completed");
    expect(calls).toBe(2);
  });

  describe("terminal reports (notify)", () => {
    /**
     * Runtime whose reply turn also fires the `assistant_reply` event
     * through the provided eventHook — the channel the runner uses to
     * capture the final reply text for completed reports. Records
     * whether a hook was passed at all so the "no hook without
     * notify" contract can be pinned.
     */
    function replyingRuntime(replyText: string): {
      runtime: TaskRunnerRuntime;
      hooksSeen: boolean[];
    } {
      const hooksSeen: boolean[] = [];
      const runtime: TaskRunnerRuntime = {
        runTurn: async (sess, _msg, options) => {
          hooksSeen.push(options?.eventHook !== undefined);
          options?.eventHook?.({
            type: "llm_event",
            event: { type: "assistant_reply", text: replyText },
          });
          return { session: sess, reason: "reply", stepCount: 1 };
        },
      };
      return { runtime, hooksSeen };
    }

    function makeRunner(
      runtime: TaskRunnerRuntime,
      reportSink: (report: TaskReport) => void | Promise<void>,
      loader: SessionState | null = session,
    ): TaskRunner {
      return new TaskRunner({
        store,
        runtime,
        sessionLoader: fakeSessionLoader(loader),
        defaultMaxSteps: 5,
        backoff: { initialMs: 1, maxMs: 10 },
        enabled: true,
        runOnCreate: false,
        sleep: async () => undefined,
        reportSink,
      });
    }

    it("reports a completed run with the captured reply text", async () => {
      const reports: TaskReport[] = [];
      const { runtime, hooksSeen } = replyingRuntime("42 files scanned");
      const runner = makeRunner(runtime, (r) => {
        reports.push(r);
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "scan files",
        origin: "cli",
        maxAttempts: 3,
        notify: "telegram",
      });
      await runner.runOne(t.id);
      expect(hooksSeen).toEqual([true]);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        taskId: t.id,
        status: "completed",
        userMessage: "scan files",
        scheduleKind: null,
        attempts: 1,
        maxAttempts: 3,
        replyText: "42 files scanned",
        errorMessage: null,
        errorCategory: null,
      });
      expect(reports[0]!.durationMs).not.toBeNull();
    });

    it("reports off the completed row before a recurring requeue flips it back to pending", async () => {
      const reports: TaskReport[] = [];
      const { runtime } = replyingRuntime("digest sent");
      const runner = makeRunner(runtime, (r) => {
        reports.push(r);
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "digest",
        origin: "cli",
        maxAttempts: 1,
        notify: "telegram",
        schedule: { kind: "interval", everyMs: 60_000 },
        scheduledFor: Date.now() - 1,
      });
      const after = await runner.runOne(t.id);
      // the row is already requeued for the next firing...
      expect(after?.status).toBe("pending");
      // ...but the report reflects the terminal outcome that just happened
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        status: "completed",
        scheduleKind: "interval",
        replyText: "digest sent",
      });
    });

    it("does NOT pass an eventHook and does NOT report when the task never opted in", async () => {
      const reports: TaskReport[] = [];
      const { runtime, hooksSeen } = replyingRuntime("silent result");
      const runner = makeRunner(runtime, (r) => {
        reports.push(r);
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "quiet job",
        origin: "cli",
        maxAttempts: 3,
      });
      await runner.runOne(t.id);
      expect(store.get(t.id)?.status).toBe("completed");
      expect(hooksSeen).toEqual([false]);
      expect(reports).toHaveLength(0);
    });

    it("reports a terminal failure with the error, and stays silent on the retry before it", async () => {
      const reports: TaskReport[] = [];
      let calls = 0;
      const runtime: TaskRunnerRuntime = {
        runTurn: async () => {
          calls += 1;
          throw new TransportError("llama down", 503, "http://llama");
        },
      };
      const runner = makeRunner(runtime, (r) => {
        reports.push(r);
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "flaky job",
        origin: "cli",
        maxAttempts: 2,
        notify: "telegram",
      });
      await runner.drainPending();
      expect(calls).toBe(2);
      expect(store.get(t.id)?.status).toBe("failed");
      // exactly one report — for the terminal attempt, not the retry
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        status: "failed",
        attempts: 2,
        replyText: null,
        errorMessage: "llama down",
        errorCategory: "transport",
      });
    });

    it("reports a blocked task when its session is missing", async () => {
      const reports: TaskReport[] = [];
      const { runtime } = replyingRuntime("unused");
      const runner = makeRunner(
        runtime,
        (r) => {
          reports.push(r);
        },
        null,
      );
      const t = store.create({
        sessionId: "gone-session",
        userMessage: "orphan job",
        origin: "cli",
        maxAttempts: 3,
        notify: "telegram",
      });
      await runner.runOne(t.id);
      expect(store.get(t.id)?.status).toBe("blocked");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        status: "blocked",
        errorCategory: "tool",
      });
      expect(reports[0]!.errorMessage).toContain("session_not_found");
    });

    it("does NOT report a cancelled task", async () => {
      const reports: TaskReport[] = [];
      const runtime: TaskRunnerRuntime = {
        runTurn: async () => {
          throw new CancelledError();
        },
      };
      const runner = makeRunner(runtime, (r) => {
        reports.push(r);
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "aborted job",
        origin: "cli",
        maxAttempts: 3,
        notify: "telegram",
      });
      await runner.runOne(t.id);
      expect(store.get(t.id)?.status).toBe("cancelled");
      expect(reports).toHaveLength(0);
    });

    it("a rejecting sink never affects the task outcome", async () => {
      const { runtime } = replyingRuntime("ok");
      const runner = makeRunner(runtime, async () => {
        throw new Error("telegram exploded");
      });
      const t = store.create({
        sessionId: session.id,
        userMessage: "hardy job",
        origin: "cli",
        maxAttempts: 3,
        notify: "telegram",
      });
      const after = await runner.runOne(t.id);
      expect(after?.status).toBe("completed");
      // let the fire-and-forget rejection settle (it is caught + logged)
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.get(t.id)?.status).toBe("completed");
    });
  });
});
