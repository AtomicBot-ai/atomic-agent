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

import { LinkStore } from "./link-store.js";
import { createLinkGeneratorRunner } from "./link-generator-runner.js";

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
  linkStore: LinkStore;
  metrics: AgentMetrics;
  metricEvents: Array<{
    name: string;
    value: number;
    tags?: Record<string, string>;
  }>;
  dispose(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "link-gen-"));
  const db = new DatabaseCtor(join(dir, "memory.sqlite"));
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  // Pre-create three memories so any (1,2,3) link references valid FKs.
  const ins = db.prepare(
    "INSERT INTO memories (content, created_at, updated_at, source) VALUES (?, 1, 1, 'agent') RETURNING id",
  );
  ins.get("alpha");
  ins.get("beta");
  ins.get("gamma");
  const linkStore = new LinkStore({ db });
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
    linkStore,
    metrics,
    metricEvents,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("createLinkGeneratorRunner", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("skips the LLM call when candidates < minCandidates", async () => {
    let called = false;
    const runner = createLinkGeneratorRunner({
      llmComplete: async () => {
        called = true;
        return completion("NONE");
      },
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      minCandidates: 2,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [{ id: 1, body: "alpha" }],
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
    const skipped = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.link_generator" &&
        e.tags?.outcome === "skipped",
    );
    expect(skipped).toBeDefined();
  });

  it("persists links the LLM emits", async () => {
    const runner = createLinkGeneratorRunner({
      llmComplete: async () =>
        completion(
          [
            "LINK 1 2 [kind=RELATES_TO]",
            "LINK 2 3 [kind=CAUSED_BY]",
          ].join("\n") + "\n",
        ),
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { id: 1, body: "alpha" },
        { id: 2, body: "beta" },
        { id: 3, body: "gamma" },
      ],
    });
    expect(n).toBe(2);
    expect(h.linkStore.count()).toBe(2);
    const ok = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.link_generator" && e.tags?.outcome === "ok",
    );
    expect(ok).toBeDefined();
  });

  it("records `none` when the LLM emits NONE", async () => {
    const runner = createLinkGeneratorRunner({
      llmComplete: async () => completion("NONE\n"),
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { id: 1, body: "a" },
        { id: 2, body: "b" },
      ],
    });
    expect(n).toBe(0);
    const none = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.link_generator" && e.tags?.outcome === "none",
    );
    expect(none).toBeDefined();
  });

  it("drops links whose ids are outside the allowlist", async () => {
    const runner = createLinkGeneratorRunner({
      llmComplete: async () =>
        completion("LINK 1 99 [kind=RELATES_TO]\n"),
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { id: 1, body: "a" },
        { id: 2, body: "b" },
      ],
    });
    expect(n).toBe(0);
    expect(h.linkStore.count()).toBe(0);
  });

  it("swallows LLM errors as `failed`, never throws", async () => {
    const runner = createLinkGeneratorRunner({
      llmComplete: async () => {
        throw new Error("boom");
      },
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 1_000,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { id: 1, body: "a" },
        { id: 2, body: "b" },
      ],
    });
    expect(n).toBe(0);
    const failed = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.link_generator" &&
        e.tags?.outcome === "failed",
    );
    expect(failed).toBeDefined();
  });

  it("respects timeoutMs", async () => {
    const runner = createLinkGeneratorRunner({
      llmComplete: (params) =>
        new Promise<CompletionResult>((_, reject) => {
          params.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      linkStore: h.linkStore,
      reflectionSlotId: 7,
      timeoutMs: 25,
      metrics: h.metrics,
    });
    const n = await runner.generate({
      sessionId: "s1",
      userMessage: "u",
      assistantReply: "a",
      candidates: [
        { id: 1, body: "a" },
        { id: 2, body: "b" },
      ],
    });
    expect(n).toBe(0);
    const timeout = h.metricEvents.find(
      (e) =>
        e.name === "agent.memory.link_generator" &&
        e.tags?.outcome === "timeout",
    );
    expect(timeout).toBeDefined();
  });
});
