import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import type Database from "better-sqlite3";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";

import { applyMigrations } from "../memory-schema.js";

import { VoteStore } from "./vote-store.js";
import { createVoteRunner } from "./vote-runner.js";

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 0,
      predictedTokens: 0,
    },
    cacheHitTokens: 0,
    slotId: 7,
    modelId: null,
  };
}

interface Harness {
  dir: string;
  db: Database.Database;
  voteStore: VoteStore;
  metrics: AgentMetrics;
  metricEvents: Array<{
    name: string;
    value: number;
    tags?: Record<string, string>;
  }>;
  // Seeded ids for test scaffolding.
  memoryId: number;
  lessonId: number;
  profileId: number;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "vote-run-"));
  const db = new DatabaseCtor(join(dir, "memory.sqlite"));
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  const memoryId = (
    db
      .prepare(
        "INSERT INTO memories (content, created_at, updated_at, source) VALUES ('m', 1, 1, 'agent') RETURNING id",
      )
      .get() as { id: number }
  ).id;
  const lessonId = (
    db
      .prepare(
        "INSERT INTO lessons (activation, principle, parent_ids, created_at, updated_at) VALUES ('a', 'p', '[1]', 1, 1) RETURNING id",
      )
      .get() as { id: number }
  ).id;
  const profileId = (
    db
      .prepare(
        "INSERT INTO profile_facts (key, value, valid_from, created_at, updated_at) VALUES ('language', 'ru', 1, 1, 1) RETURNING id",
      )
      .get() as { id: number }
  ).id;
  const voteStore = new VoteStore({ db });
  const metricEvents: Array<{
    name: string;
    value: number;
    tags?: Record<string, string>;
  }> = [];
  const collector = new MetricsCollector({
    sinks: [
      (e) =>
        metricEvents.push({
          name: e.name,
          value: e.value,
          tags: e.tags as Record<string, string> | undefined,
        }),
    ],
  });
  const metrics = new AgentMetrics(collector);
  return {
    dir,
    db,
    voteStore,
    metrics,
    metricEvents,
    memoryId,
    lessonId,
    profileId,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("createVoteRunner", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("skips the LLM call when no candidates surfaced", async () => {
    let called = false;
    const runner = createVoteRunner({
      llmComplete: async () => {
        called = true;
        return completion("NONE");
      },
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      minCandidates: 1,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [],
    });
    expect(result.outcome).toBe("skipped");
    expect(called).toBe(false);
  });

  it("applies UPVOTE / DOWNVOTE and bumps vote_score (scorecard 7a happy path)", async () => {
    const runner = createVoteRunner({
      llmComplete: async () =>
        completion(
          [
            `UPVOTE memory:${h.memoryId}`,
            `DOWNVOTE lesson:${h.lessonId}`,
          ].join("\n") + "\n",
        ),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      turnIndex: 3,
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
        { kind: "lesson", id: h.lessonId, preview: "l" },
      ],
    });
    expect(result.outcome).toBe("ok");
    expect(result.applied).toBe(2);
    expect(result.rejected).toBe(0);
    expect(h.voteStore.getScore("memory", h.memoryId)).toBe(1);
    expect(h.voteStore.getScore("lesson", h.lessonId)).toBe(-1);
    // Audit log carries the turn index we passed in.
    const [last] = h.voteStore.listEvents();
    expect(last?.turnIndex).toBe(3);
  });

  it("emits `none` when the LLM returns NONE", async () => {
    const runner = createVoteRunner({
      llmComplete: async () => completion("NONE\n"),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
      ],
    });
    expect(result.outcome).toBe("none");
    expect(h.voteStore.getScore("memory", h.memoryId)).toBe(0);
    const none = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.voting.runner" && e.tags?.outcome === "none",
    );
    expect(none).toBeDefined();
  });

  // Scorecard 7a.B / invariant 18. The allowlist guard sits in the parser;
  // the runner exercises it through the round-trip path.
  it("rejects votes against ids outside the surfaced allowlist (scorecard 7a.B)", async () => {
    const runner = createVoteRunner({
      llmComplete: async () =>
        completion(`UPVOTE lesson:9999\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "lesson", id: h.lessonId, preview: "L" },
      ],
    });
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(h.voteStore.getScore("lesson", h.lessonId)).toBe(0);
    const notSurfaced = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.voting.rejected" &&
        e.tags?.reason === "not_surfaced",
    );
    expect(notSurfaced).toBeDefined();
  });

  it("emits clamp_hit and does not write the audit row when at clamp (scorecard 7a.C.2)", async () => {
    // Pre-fill the lesson score to the clamp.
    for (let i = 0; i < 3; i++) {
      h.voteStore.applyVote({
        kind: "lesson",
        targetId: h.lessonId,
        direction: 1,
        maxVotePerItem: 3,
      });
    }
    expect(h.voteStore.getScore("lesson", h.lessonId)).toBe(3);
    const runner = createVoteRunner({
      llmComplete: async () =>
        completion(`UPVOTE lesson:${h.lessonId}\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 3,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "lesson", id: h.lessonId, preview: "L" },
      ],
    });
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(h.voteStore.getScore("lesson", h.lessonId)).toBe(3);
    const clampHit = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.voting.rejected" &&
        e.tags?.reason === "clamp_hit",
    );
    expect(clampHit).toBeDefined();
  });

  it("times out when the LLM hangs past `timeoutMs`", async () => {
    const runner = createVoteRunner({
      llmComplete: async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 1_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        return completion("NONE");
      },
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 5,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
      ],
    });
    expect(result.outcome).toBe("timeout");
  });

  it("swallows LLM errors and reports `failed`", async () => {
    const runner = createVoteRunner({
      llmComplete: async () => {
        throw new Error("llm exploded");
      },
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const result = await runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
      ],
    });
    expect(result.outcome).toBe("failed");
    expect(result.applied).toBe(0);
  });

  it("aborts on second concurrent call for the same session", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createVoteRunner({
      llmComplete: async ({ signal }) => {
        await blocker;
        if (signal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return completion("NONE");
      },
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 5_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 0,
      metrics: h.metrics,
    });
    const first = runner.run({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
      ],
    });
    // Second call must abort the first.
    const second = runner.run({
      sessionId: "s1",
      userMessage: "u2",
      assistantReply: "a2",
      candidates: [
        { kind: "memory", id: h.memoryId, preview: "m" },
      ],
    });
    release?.();
    const [r1] = await Promise.all([first, second]);
    expect(r1.outcome).toBe("aborted");
  });

  it("propagates eventLogMaxRows into VoteStore FIFO eviction", async () => {
    const runner = createVoteRunner({
      llmComplete: async () =>
        completion(`UPVOTE memory:${h.memoryId}\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 50,
      eventLogMaxRows: 2,
      metrics: h.metrics,
    });
    // Five sequential calls; cap at 2.
    for (let i = 0; i < 5; i++) {
      await runner.run({
        sessionId: "s1",
        userMessage: "u",
        assistantReply: "a",
        candidates: [
          { kind: "memory", id: h.memoryId, preview: "m" },
        ],
      });
    }
    expect(h.voteStore.getEventCount()).toBe(2);
  });

  // Memory-v2 phase 7a — trace emission. The runner forwards each
  // applied / rejected vote into the optional `emitTrace` sink so
  // the per-session recorder can land them in the NDJSON trace.
  it("emits vote_applied via emitTrace for each successful write", async () => {
    const traced: Array<{ type: string; targetId: number | null }> = [];
    const runner = createVoteRunner({
      llmComplete: async () =>
        completion(
          `UPVOTE lesson:${h.lessonId}\nDOWNVOTE memory:${h.memoryId}\n`,
        ),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 5,
      eventLogMaxRows: 0,
      metrics: h.metrics,
      emitTrace: (event) => {
        traced.push({ type: event.type, targetId: event.targetId });
      },
    });

    const result = await runner.run({
      sessionId: "trace-sess",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { kind: "lesson", id: h.lessonId, preview: "L" },
        { kind: "memory", id: h.memoryId, preview: "M" },
      ],
    });

    expect(result.applied).toBe(2);
    expect(traced).toEqual([
      { type: "applied", targetId: h.lessonId },
      { type: "applied", targetId: h.memoryId },
    ]);
  });

  it("emits vote_rejected via emitTrace when the parser drops out-of-allowlist lines", async () => {
    const traced: Array<{
      type: string;
      reason?: string;
      targetId: number | null;
    }> = [];
    const runner = createVoteRunner({
      llmComplete: async () =>
        // The model votes on a lesson id that is NOT in the
        // allowlist; the parser tags it `not_surfaced`.
        completion(`UPVOTE lesson:9999\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 5,
      eventLogMaxRows: 0,
      metrics: h.metrics,
      emitTrace: (event) => {
        traced.push({
          type: event.type,
          targetId: event.targetId,
          ...(event.type === "rejected" ? { reason: event.reason } : {}),
        });
      },
    });

    await runner.run({
      sessionId: "trace-sess",
      userMessage: "u",
      assistantReply: "a",
      candidates: [{ kind: "lesson", id: h.lessonId, preview: "L" }],
    });

    expect(traced).toEqual([
      { type: "rejected", targetId: 9999, reason: "not_surfaced" },
    ]);
  });

  it("emits vote_applied with clampHit=true when the score saturates", async () => {
    // Pre-saturate the lesson to +5.
    for (let i = 0; i < 5; i++) {
      h.voteStore.applyVote({
        kind: "lesson",
        targetId: h.lessonId,
        direction: 1,
        sessionId: "seed",
        turnIndex: i,
        maxVotePerItem: 5,
      });
    }
    const traced: Array<{
      type: string;
      clampHit?: boolean;
      score?: number;
    }> = [];
    const runner = createVoteRunner({
      llmComplete: async () => completion(`UPVOTE lesson:${h.lessonId}\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 5,
      eventLogMaxRows: 0,
      metrics: h.metrics,
      emitTrace: (event) => {
        traced.push({
          type: event.type,
          ...(event.type === "applied"
            ? { clampHit: event.clampHit, score: event.score }
            : {}),
        });
      },
    });

    await runner.run({
      sessionId: "trace-sess",
      userMessage: "u",
      assistantReply: "a",
      candidates: [{ kind: "lesson", id: h.lessonId, preview: "L" }],
    });

    expect(traced).toEqual([
      { type: "applied", clampHit: true, score: 5 },
    ]);
  });

  it("swallows emitTrace failures without aborting vote application", async () => {
    let attempts = 0;
    const runner = createVoteRunner({
      llmComplete: async () => completion(`UPVOTE lesson:${h.lessonId}\n`),
      voteStore: h.voteStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      maxVotePerItem: 5,
      eventLogMaxRows: 0,
      metrics: h.metrics,
      emitTrace: () => {
        attempts += 1;
        throw new Error("recorder unavailable");
      },
    });

    const result = await runner.run({
      sessionId: "trace-sess",
      userMessage: "u",
      assistantReply: "a",
      candidates: [{ kind: "lesson", id: h.lessonId, preview: "L" }],
    });

    expect(attempts).toBe(1);
    expect(result.applied).toBe(1);
    expect(h.voteStore.getScore("lesson", h.lessonId)).toBe(1);
  });
});
