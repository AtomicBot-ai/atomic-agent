import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type {
  CompletionResult,
  LlamaServerClient,
} from "../llm/llama-server-client.js";
import { ModelProfileManager } from "../llm/model-profile-manager.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import { QWEN_THINK_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { DeferredLocalBackendProbes } from "../llm/local-backend-gate.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * Issue #112 — the loop's two `ModelProfileManager` probes are
 * llama-server traffic, and a cloud turn must produce none of it.
 *
 * `fetchProps` is the counted local request: it IS the `/props` call,
 * one layer below the HTTP client. Counts are exact — the pre-fix
 * behaviour was one probe per turn plus one per stale step, so a
 * `not.toHaveBeenCalled()` would not catch a regression that merely
 * moved the probe.
 */

function makeCompletion(
  content: string,
  modelId: string = "mock",
): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId,
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

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

describe("AgentLoop — local profile probes are gated on the active route", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-loop-gate-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const buildLoop = async (
    localBackend: ConstructorParameters<typeof AgentLoop>[0]["localBackend"],
  ) => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    const fetchProps = vi.fn<[], Promise<Record<string, unknown>>>();
    fetchProps.mockResolvedValue(GEMMA4_PROPS);
    const profileManager = new ModelProfileManager({
      llama: { fetchProps } as unknown as LlamaServerClient,
      initialProfile: QWEN_THINK_PROFILE,
      initialGrammar: grammar,
      initialModelId: "qwen3-30b-a3b-instruct-2507",
    });
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar,
      profile: QWEN_THINK_PROFILE,
      profileManager,
      ...(localBackend ? { localBackend } : {}),
      // Pre-closed reasoning channel so the reply parses under either
      // profile — what is under test is the probe count, not parsing.
      // The completion echoes the model the manager already believes is
      // loaded, so nothing here marks it stale: staleness has its own
      // reactive-refresh tests, and letting it leak in would add probes
      // that the gate is not responsible for.
      llmComplete: async () =>
        makeCompletion(
          `</think><channel|>${JSON.stringify({
            tool: "finish",
            args: { summary: "done" },
          })}`,
          "qwen3-30b-a3b-instruct-2507",
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    return { loop, fetchProps, profileManager };
  };

  const runTurn = async (loop: AgentLoop, id: string) =>
    loop.runTurn(createEmptySessionState({ id, workingDir }), {
      userMessage: "go",
      maxSteps: 2,
      signal: new AbortController().signal,
    });

  it("makes zero /props requests on a cloud turn", async () => {
    const { loop, fetchProps, profileManager } = await buildLoop({
      isActive: () => false,
      ensureProbed: async () => false,
    });

    const result = await runTurn(loop, "s-cloud");

    expect(result.reason).toBe("finish");
    expect(fetchProps).toHaveBeenCalledTimes(0);
    // ...and the turn ran on the plain/non-local profile it started on,
    // rather than one detected from a llama-server that is not serving.
    expect(profileManager.getProfile().id).toBe(QWEN_THINK_PROFILE.id);
  });

  it("probes exactly once per local turn", async () => {
    const { loop, fetchProps, profileManager } = await buildLoop({
      isActive: () => true,
      ensureProbed: async () => false,
    });

    await runTurn(loop, "s-local");

    // One turn-start refresh. The between-steps `refreshIfStale` is a
    // no-op on a manager that is not stale, exactly as before #112.
    expect(fetchProps).toHaveBeenCalledTimes(1);
    expect(profileManager.getProfile().id).toBe("gemma4-think");
  });

  it("behaves as before the gate when no gate is wired (legacy deps)", async () => {
    const { loop, fetchProps } = await buildLoop(undefined);
    await runTurn(loop, "s-legacy");
    expect(fetchProps).toHaveBeenCalledTimes(1);
  });

  it("lazily restores local state on the first turn after a switch back to local", async () => {
    // Boot was cloud, so the probes were deferred; the operator has
    // since switched the active provider to a llama-server link.
    let active = false;
    const restore = vi.fn(async () => {});
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => active, restore },
      /* probedAtBoot */ false,
    );
    const { loop, fetchProps } = await buildLoop(gate);

    await runTurn(loop, "s-still-cloud");
    expect(restore).toHaveBeenCalledTimes(0);
    expect(fetchProps).toHaveBeenCalledTimes(0);

    active = true;
    await runTurn(loop, "s-switched");
    // The restore ran instead of the loop's own refresh — it already
    // carries a fresh `/props`, so the turn does not probe twice.
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetchProps).toHaveBeenCalledTimes(0);

    // Every later local turn is back on the ordinary refresh.
    await runTurn(loop, "s-local-again");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fetchProps).toHaveBeenCalledTimes(1);
  });
});
