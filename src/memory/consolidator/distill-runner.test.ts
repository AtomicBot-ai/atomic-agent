import { describe, expect, it } from "vitest";

import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { MemoryEntry } from "../memory-store.js";

import {
  DistillRunner,
  type DistillTraceEvent,
} from "./distill-runner.js";

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {} as never,
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
  } as CompletionResult;
}

function episode(id: number, content: string): MemoryEntry {
  return {
    id,
    content,
    createdAt: 0,
    updatedAt: 0,
    source: "reflection",
    sessionId: null,
    workingDir: null,
    tags: [],
    recallCount: 0,
    lastRecalledAt: null,
  };
}

const CLUSTER: readonly MemoryEntry[] = [
  episode(1, "always use pnpm"),
  episode(2, "pnpm install is faster"),
  episode(3, "pnpm in CI too"),
];

describe("DistillRunner trace emission", () => {
  it("emits an `ok` trace event with clusterSize on a well-formed LESSON", async () => {
    const traced: DistillTraceEvent[] = [];
    const runner = new DistillRunner({
      llmComplete: async () =>
        completion(
          `LESSON activation="When asked about pnpm"; principle="Always use pnpm install."; tags=tool,pnpm\n`,
        ),
      slotId: -1,
      timeoutMs: 1_000,
      emitTrace: (event) => traced.push(event),
    });
    const out = await runner.distill({
      sessionId: "consolidator",
      episodes: CLUSTER,
      sharedTags: ["pnpm"],
      signal: new AbortController().signal,
    });
    expect(out.kind).toBe("ok");
    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({
      sessionId: "consolidator",
      outcome: "ok",
      clusterSize: 3,
      hasProcedure: false,
    });
  });

  it("emits a `none` trace event on the abstain sentinel", async () => {
    const traced: DistillTraceEvent[] = [];
    const runner = new DistillRunner({
      llmComplete: async () =>
        completion(
          `LESSON activation="(no consensus)"; principle="(no durable advice)"\n`,
        ),
      slotId: -1,
      timeoutMs: 1_000,
      emitTrace: (event) => traced.push(event),
    });
    const out = await runner.distill({
      sessionId: "consolidator",
      episodes: CLUSTER,
      sharedTags: [],
      signal: new AbortController().signal,
    });
    expect(out.kind).toBe("none");
    expect(traced).toEqual([
      { sessionId: "consolidator", outcome: "none", clusterSize: 3 },
    ]);
  });

  it("emits a `failed` trace event when the LLM throws", async () => {
    const traced: DistillTraceEvent[] = [];
    const runner = new DistillRunner({
      llmComplete: async () => {
        throw new Error("server down");
      },
      slotId: -1,
      timeoutMs: 1_000,
      emitTrace: (event) => traced.push(event),
    });
    const out = await runner.distill({
      sessionId: "consolidator",
      episodes: CLUSTER,
      sharedTags: [],
      signal: new AbortController().signal,
    });
    expect(out.kind).toBe("failed");
    expect(traced[0]).toMatchObject({
      sessionId: "consolidator",
      outcome: "failed",
      clusterSize: 3,
      reason: "server down",
    });
  });

  it("never throws when the trace sink throws", async () => {
    const runner = new DistillRunner({
      llmComplete: async () =>
        completion(
          `LESSON activation="x"; principle="y"\n`,
        ),
      slotId: -1,
      timeoutMs: 1_000,
      emitTrace: () => {
        throw new Error("sink down");
      },
    });
    await expect(
      runner.distill({
        sessionId: "consolidator",
        episodes: CLUSTER,
        sharedTags: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: "ok" });
  });
});
