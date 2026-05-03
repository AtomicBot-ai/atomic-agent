import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";

import { executeStep } from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
} from "../prompt/stable-prefix.js";

/**
 * Integration test for the parallel-tool-calls path.
 *
 * Wires executeStep against a fake llmComplete that emits a 4-call
 * batch and a registry whose `os.fs.read` simulates ~80ms of latency
 * (typical disk + decode work). With sequential execution this would
 * take >= 4 * 80 = 320ms; with the parallel batch executor it should
 * complete in roughly one call's worth of wall time.
 */
const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];
const PER_CALL_LATENCY_MS = 80;
const BATCH_SIZE = 4;

describe("parallel tool calls — wall-time speedup", () => {
  let grammarsDir: string;

  beforeEach(() => {
    grammarsDir = join(process.cwd(), "grammars");
  });

  it("executes a 4-read batch in roughly one call's wall time", async () => {
    const registry = new ToolRegistry();
    let inFlight = 0;
    let peakInFlight = 0;
    registry.register({
      name: "os.fs.read",
      description: "simulated disk read",
      readonly: true,
      run: async (args) => {
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        try {
          await new Promise((r) => setTimeout(r, PER_CALL_LATENCY_MS));
          return compressToolResult({
            tool: "os.fs.read",
            status: "ok",
            output: `read ${args.path}`,
          });
        } finally {
          inFlight -= 1;
        }
      },
    });

    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-parallel",
      workingDir: "/w",
    });

    const completionBody = JSON.stringify(
      Array.from({ length: BATCH_SIZE }, (_, i) => ({
        tool: "os.fs.read",
        args: { path: `f${i}.csv` },
      })),
    );

    const startedAt = Date.now();
    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "scan four files for PII",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: completionBody,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.toolCalls).toHaveLength(BATCH_SIZE);
    expect(outcome.toolResults).toHaveLength(BATCH_SIZE);
    expect(outcome.toolResults.every((r) => r.status === "ok")).toBe(true);
    expect(outcome.toolResults.map((r) => r.summary)).toEqual([
      "read f0.csv",
      "read f1.csv",
      "read f2.csv",
      "read f3.csv",
    ]);

    // Concrete proof of parallelism: peakInFlight must be > 1.
    expect(peakInFlight).toBeGreaterThan(1);
    // Soft wall-time bound: a sequential run would take BATCH_SIZE *
    // PER_CALL_LATENCY_MS ≥ 320ms. Parallel pure_read fan-out should
    // come in well under that. We use 2x the per-call latency as a
    // generous CI-friendly threshold (real measured walls are ~85–110ms
    // for BATCH_SIZE=4).
    const sequentialWall = BATCH_SIZE * PER_CALL_LATENCY_MS;
    expect(elapsedMs).toBeLessThan(sequentialWall / 2);
  });

  it("appends N tool_result turns in batch-index order", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "os.fs.read",
      description: "r",
      readonly: true,
      run: async (args) =>
        compressToolResult({
          tool: "os.fs.read",
          status: "ok",
          output: `read ${args.path}`,
        }),
    });
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, grammarsDir);
    const session = createEmptySessionState({
      id: "s-order",
      workingDir: "/w",
    });
    const completionBody = JSON.stringify([
      { tool: "os.fs.read", args: { path: "a" } },
      { tool: "os.fs.read", args: { path: "b" } },
      { tool: "os.fs.read", args: { path: "c" } },
    ]);

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "x",
      },
      {
        registry,
        slotManager: new SlotManager(2),
        llmComplete: async () => ({
          content: completionBody,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: {
            promptMs: 1,
            predictedMs: 1,
            promptTokens: 20,
            predictedTokens: 5,
          },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        }),
        grammar,
        profile: PLAIN_INSTRUCT_PROFILE,
      },
    );

    const tail = outcome.nextSession.turns.slice(-6);
    expect(tail.map((t) => t.kind)).toEqual([
      "assistant_tool_call",
      "tool_result",
      "assistant_tool_call",
      "tool_result",
      "assistant_tool_call",
      "tool_result",
    ]);
    expect((tail[1] as { summary: string }).summary).toBe("read a");
    expect((tail[3] as { summary: string }).summary).toBe("read b");
    expect((tail[5] as { summary: string }).summary).toBe("read c");
  });
});
