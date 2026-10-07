import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../../config/index.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { ModelProfileManager } from "../../llm/model-profile-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { ResolvedTurnLlmSlice, RunTurnOptions } from "../agent-contract.js";
import {
  prepareAgentTurn,
  prepareTurnPolicies,
  prepareTurnBudgets,
  createTurnLoopTracker,
  type TurnPreparationDependencies,
  type TurnPolicyDependencies,
} from "./turn-preparation.js";

import { refreshMemoryContext, type TurnMemoryDependencies } from "./turn-memory-context.js";

const options = (): RunTurnOptions => ({
  maxSteps: 4,
  signal: new AbortController().signal,
  userMessage: "continue",
});
const session = () => createEmptySessionState({ id: "turn", workingDir: "/work" });
function manager() {
  return new ModelProfileManager({
    llama: new LlamaServerClient({ baseUrl: "http://127.0.0.1:1" }),
    initialProfile: PLAIN_INSTRUCT_PROFILE,
    initialGrammar: 'root ::= "ok"',
    initialModelId: null,
  });
}
afterEach(() => vi.restoreAllMocks());

describe("turn preparation ownership", () => {
  it("starts local sync beside recall, waits for both, and skips duplicate refresh after warm probe", async () => {
    const events: string[] = [];
    let resolveProbe: (value: boolean) => void = () => {};
    let resolveRecall: () => void = () => {};
    const profileManager = manager();
    const refresh = vi.spyOn(profileManager, "refresh");
    const deps: TurnPreparationDependencies & TurnMemoryDependencies = {
      toolDescriptors: [],
      profileManager,
      localBackend: {
        isActive: () => true,
        takeLinkServed: () => { events.push("take"); return false; },
        ensureProbed: () => { events.push("probe"); return new Promise((resolve) => { resolveProbe = resolve; }); },
      },
      memoryContextProvider: {
        buildMemoryContext: async () => {
          events.push("recall");
          await new Promise<void>((resolve) => { resolveRecall = resolve; });
          return { recalled: [], index: [] };
        },
      },
      onEvent: (event) => events.push(event.type),
    };
    let settled = false;
    const input = options();
    const value = prepareAgentTurn(session(), input, deps);
    const pending = (async () => {
      const state = await refreshMemoryContext(deps, value.state, input);
      await value.profileSynced;
      settled = true;
      return { ...value, state };
    })();
    expect(events).toEqual(["user_message", "turn_started", "take", "probe", "recall"]);
    resolveRecall();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveProbe(true);
    const prepared = await pending;
    expect(refresh).not.toHaveBeenCalled();
    expect(prepared.state.turns[0]).toMatchObject({ kind: "user", text: "continue" });
  });

  it.each([false, true])("cloud boot refreshes only a prior served local link (%s)", async (served) => {
    const profileManager = manager();
    const refresh = vi.spyOn(profileManager, "refresh").mockResolvedValue({ profileChanged: false, profileId: "plain-instruct", modelId: null });
    const ensureProbed = vi.fn(async () => false);
    const prepared = prepareAgentTurn(session(), options(), {
      toolDescriptors: [], profileManager,
      localBackend: { isActive: () => false, ensureProbed, takeLinkServed: () => served },
    });
    await prepared.profileSynced;
    expect(refresh).toHaveBeenCalledTimes(served ? 1 : 0);
    expect(ensureProbed).not.toHaveBeenCalled();
  });

  it("keeps pin identity fixed while reading descriptor and filter replacements live", async () => {
    const first: ToolDescriptor = { name: "first", summary: "first", argsSchema: "{}" };
    const second: ToolDescriptor = { name: "second", summary: "second", argsSchema: "{}" };
    const slice: ResolvedTurnLlmSlice = { toolTransport: "grammar", toolCallAdapter: null, supportsSlotAffinity: true, supportsParallelTools: true, strictTools: false };
    const resolveLlmSlice = vi.fn(() => slice);
    const input: RunTurnOptions = { ...options(), providerId: "pinned" };
    const deps: TurnPreparationDependencies = { toolDescriptors: [first], resolveLlmSlice };
    const prepared = await prepareAgentTurn(session(), input, deps);
    expect(prepared.pinnedSlice).toBe(slice);
    expect(resolveLlmSlice).toHaveBeenCalledTimes(1);
    expect(resolveLlmSlice).toHaveBeenCalledWith("pinned");
    expect(prepared.visibleToolDescriptors()).toBe(deps.toolDescriptors);
    deps.toolDescriptors = [first, second];
    input.toolFilter = (name: string) => name === "second";
    expect(prepared.visibleToolDescriptors()).toEqual([second]);
    expect(resolveLlmSlice).toHaveBeenCalledTimes(1);
  });

  it("creates per-turn evidence/notices and grants while ephemeral workers retain their role", async () => {
    const clear = vi.fn();
    const deps: TurnPolicyDependencies = { isFusionMode: () => true, clearFanoutTurnGrant: clear };
    const first = prepareTurnPolicies("turn", options(), deps);
    first.claimEvidence.markNoticed();
    first.linkEvidence.markNoticed();
    const second = prepareTurnPolicies("turn", { ...options(), ephemeral: true, toolRole: "builder" }, deps);
    expect(first.toolRole).toBe("orchestrator");
    expect(second.toolRole).toBe("builder");
    expect(second.reviewStall).toBeNull();
    expect(second.fusionOrchestratorTurn).toBe(false);
    expect(second.claimEvidence.noticed()).toBe(false);
    expect(second.linkEvidence.noticed()).toBe(false);
    expect(second.progressNotes).not.toBe(first.progressNotes);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith("turn");
  });

  it("reads task defaults at its own phase and preserves one-leg override behavior", () => {
    const config = getConfig();
    const original = config.agent.task;
    try {
      config.agent.task = { ...original, autoContinue: true, maxSteps: 18, maxDurationMs: 100 };
      const first = prepareTurnBudgets(options());
      config.agent.task = { ...original, autoContinue: false, maxSteps: 31, maxDurationMs: 200 };
      const second = prepareTurnBudgets({ ...options(), maxSteps: 0, taskMaxSteps: 900 });
      expect(first).toMatchObject({ legSteps: 4, autoContinue: true, stepCeiling: 18, durationCeilingMs: 100 });
      expect(second).toMatchObject({ legSteps: 1, autoContinue: false, stepCeiling: 1, durationCeilingMs: 200 });
    } finally { config.agent.task = original; }
  });


  it("keeps policy callbacks and the next budget read in one synchronous phase", async () => {
    const config = getConfig();
    const original = config.agent.task;
    const phases: string[] = [];
    try {
      config.agent.task = { ...original, autoContinue: true, maxSteps: 11 };
      prepareTurnPolicies("turn", options(), {
        isFusionMode: () => {
          phases.push("policy");
          queueMicrotask(() => {
            config.agent.task = { ...original, autoContinue: true, maxSteps: 29 };
            phases.push("queued");
          });
          return false;
        },
      });
      expect(prepareTurnBudgets(options()).stepCeiling).toBe(11);
      expect(phases).toEqual(["policy"]);
      await Promise.resolve();
      expect(prepareTurnBudgets(options()).stepCeiling).toBe(29);
      expect(phases).toEqual(["policy", "queued"]);
    } finally { config.agent.task = original; }
  });

  it("allocates independent progress tracker state at the tracker phase", () => {
    const first = createTurnLoopTracker();
    const second = createTurnLoopTracker();
    for (let i = 0; i <= getConfig().agent.loopCriticalThreshold; i += 1) first.recordCall("os.fs.read", { path: "file" });
    expect(first.check("os.fs.read", { path: "file" }).count).toBeGreaterThan(second.check("os.fs.read", { path: "file" }).count);
  });
});
