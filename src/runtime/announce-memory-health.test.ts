import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type {
  VoteRunner,
  VoteRunnerResult,
} from "../memory/voting/vote-runner.js";
import type { TraceRecorder } from "../tracing/trace/trace-recorder.js";

import {
  createMemoryHealthAnnouncer,
  createVoteTraceSink,
  observeVoteRunnerHealth,
  type MemoryHealthAnnouncer,
} from "./announce-memory-health.js";

function harness() {
  const emitted: { sessionId: string; event: AgentLoopEvent }[] = [];
  const warn = vi.fn();
  const announcer = createMemoryHealthAnnouncer({
    emit: (sessionId, event) => emitted.push({ sessionId, event }),
    logger: { warn },
  });
  return { announcer, emitted, warn };
}

describe("createMemoryHealthAnnouncer", () => {
  it("emits one event and one warn log for a streak, on the session it belongs to", () => {
    const { announcer, emitted, warn } = harness();
    for (let i = 0; i < 5; i += 1) {
      announcer.observe("s-7", "reflection", "timeout");
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.sessionId).toBe("s-7");
    expect(emitted[0]?.event).toMatchObject({
      type: "memory_health_warning",
      kind: "reflection",
      outcome: "timeout",
      consecutive: 3,
      setting: "memory.reflection.timeoutMs",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "memory.health.warning",
      expect.objectContaining({
        sessionId: "s-7",
        kind: "reflection",
        setting: "memory.reflection.timeoutMs",
      }),
    );
  });

  it("stays silent for healthy and aborted outcomes", () => {
    const { announcer, emitted, warn } = harness();
    for (const outcome of ["ok", "none", "aborted", "skipped"] as const) {
      for (let i = 0; i < 4; i += 1) announcer.observe("s", "link_generator", outcome);
    }
    expect(emitted).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("carries the summarised failure reason into the event and the log", () => {
    const { announcer, emitted, warn } = harness();
    for (let i = 0; i < 3; i += 1) {
      announcer.observe("s", "rewriter", "failed", "400\nschema refused");
    }
    expect(emitted[0]?.event).toMatchObject({
      setting: "memory.retrieve.rewriter.enabled",
      reason: "400 schema refused",
    });
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: "400 schema refused" });
  });

  it("never throws, even when the sink does", () => {
    const announcer = createMemoryHealthAnnouncer({
      emit: () => {
        throw new Error("sink down");
      },
    });
    expect(() => {
      for (let i = 0; i < 3; i += 1) announcer.observe("s", "vote", "failed");
    }).not.toThrow();
  });
});

/**
 * The sink is the whole of what makes a vote turn observable, and the
 * split between its two branches is what keeps the health fold honest:
 * the runner's outcomes are already folded by `observeVoteRunnerHealth`
 * from `run()`'s result, the decorator's are not folded anywhere else.
 */
describe("createVoteTraceSink", () => {
  function sinkHarness(opts?: { traced?: boolean }) {
    const recordVote = vi.fn();
    const recordVoteApplied = vi.fn();
    const recordVoteRejected = vi.fn();
    const observe = vi.fn();
    const recorder = {
      recordVote,
      recordVoteApplied,
      recordVoteRejected,
    } as unknown as TraceRecorder;
    const health: MemoryHealthAnnouncer = { observe };
    const sink = createVoteTraceSink({
      resolveRecorder: () => (opts?.traced === false ? undefined : recorder),
      health,
    });
    return { sink, recordVote, recordVoteApplied, recordVoteRejected, observe };
  }

  it("writes the run row and folds its outcome into health", () => {
    const h = sinkHarness();
    h.sink({
      type: "run",
      sessionId: "s-run",
      outcome: "failed",
      reason: "candidate hydration failed: boom",
    });
    expect(h.recordVote).toHaveBeenCalledWith({
      outcome: "failed",
      reason: "candidate hydration failed: boom",
    });
    expect(h.observe).toHaveBeenCalledWith(
      "s-run",
      "vote",
      "failed",
      "candidate hydration failed: boom",
    );
    expect(h.recordVoteApplied).not.toHaveBeenCalled();
  });

  it("carries the candidate count when the row has one", () => {
    const h = sinkHarness();
    h.sink({
      type: "run",
      sessionId: "s-skip",
      outcome: "skipped",
      candidates: 0,
      reason: "no candidates surfaced",
    });
    expect(h.recordVote).toHaveBeenCalledWith({
      outcome: "skipped",
      candidates: 0,
      reason: "no candidates surfaced",
    });
  });

  it("does not fold per-vote rows into health — the runner's result already did", () => {
    const h = sinkHarness();
    h.sink({
      type: "applied",
      sessionId: "s-vote",
      kind: "memory",
      targetId: 4,
      direction: 1,
      score: 2,
      clampHit: false,
    });
    h.sink({
      type: "rejected",
      sessionId: "s-vote",
      kind: "lesson",
      targetId: null,
      direction: -1,
      reason: "not in allowlist",
    });
    expect(h.recordVoteApplied).toHaveBeenCalledWith({
      kind: "memory",
      targetId: 4,
      direction: 1,
      score: 2,
      clampHit: false,
    });
    expect(h.recordVoteRejected).toHaveBeenCalledWith({
      kind: "lesson",
      targetId: null,
      direction: -1,
      reason: "not in allowlist",
    });
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.recordVote).not.toHaveBeenCalled();
  });

  it("still folds health for a session with tracing off", () => {
    const h = sinkHarness({ traced: false });
    h.sink({
      type: "run",
      sessionId: "s-untraced",
      outcome: "failed",
      reason: "candidate hydration failed: boom",
    });
    expect(h.recordVote).not.toHaveBeenCalled();
    expect(h.observe).toHaveBeenCalledWith(
      "s-untraced",
      "vote",
      "failed",
      "candidate hydration failed: boom",
    );
  });
});

describe("observeVoteRunnerHealth", () => {
  const input = {
    sessionId: "s-vote",
    userMessage: "u",
    assistantReply: "a",
    candidates: [],
  };

  it("reads the outcome from run()'s result and returns the result unchanged", async () => {
    const result: VoteRunnerResult = {
      outcome: "failed",
      applied: 0,
      rejected: 0,
      reason: "Invalid schema for response_format",
    };
    const abortPending = vi.fn();
    const inner: VoteRunner = { run: async () => result, abortPending };
    const { announcer, emitted } = harness();
    const wrapped = observeVoteRunnerHealth(inner, announcer);

    for (let i = 0; i < 3; i += 1) {
      await expect(wrapped.run(input)).resolves.toBe(result);
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      sessionId: "s-vote",
      event: {
        kind: "vote",
        setting: "memory.voting.enabled",
        reason: "Invalid schema for response_format",
      },
    });

    wrapped.abortPending({ sessionId: "s-vote" });
    expect(abortPending).toHaveBeenCalledWith({ sessionId: "s-vote" });
  });
});
