import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createInterruptedTurns } from "../../runtime/interrupted-turns.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { summarizeSessionState } from "../../session/session-summary.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { ChatOrchestrator } from "../chat-orchestrator.js";
import { makeTuiEventBus } from "../make-event-bus.js";
import { handleEditorSubmit } from "../submit-handler.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";
import { resolveSlashCommand } from "./slash-commands.js";
import {
  describeThinkLevel,
  parseThinkCommand,
  reasoningOverrideFor,
  thinkReadoutLabel,
  THINK_USAGE,
} from "./think-command.js";

/** `/think` (ATO-490): the per-turn reasoning level from the terminal. */

function idleState(): TuiState {
  return createInitialTuiState({
    sessionId: "s1",
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured: false,
  });
}

function callbacks(overrides: Partial<TuiAppCallbacks> = {}): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

describe("parseThinkCommand", () => {
  it("shows the level with no argument", () => {
    expect(parseThinkCommand("")).toEqual({ kind: "show" });
    expect(parseThinkCommand("   ")).toEqual({ kind: "show" });
  });

  it("takes the four levels the chat API takes, in any case", () => {
    for (const level of ["auto", "low", "medium", "high"] as const) {
      expect(parseThinkCommand(level)).toEqual({ kind: "set", level });
      expect(parseThinkCommand(` ${level.toUpperCase()} `)).toEqual({ kind: "set", level });
    }
  });

  it("reads `off` as the lightest level and says so", () => {
    expect(parseThinkCommand("off")).toEqual({ kind: "set", level: "low", fromOff: true });
    expect(describeThinkLevel("low", true)).toMatch(/lightest level/);
    expect(parseThinkCommand("max")).toEqual({ kind: "set", level: "high" });
    expect(parseThinkCommand("default")).toEqual({ kind: "set", level: "auto" });
  });

  it("answers an unknown level with the usage line", () => {
    const result = parseThinkCommand("xhigh");
    expect(result.kind).toBe("error");
    expect(result.kind === "error" ? result.message : "").toContain(THINK_USAGE);
  });
});

describe("what a turn sends and what the bar shows", () => {
  it("sends nothing for auto, the level otherwise", () => {
    expect(reasoningOverrideFor("auto")).toBeUndefined();
    expect(reasoningOverrideFor("low")).toBe("low");
    expect(reasoningOverrideFor("high")).toBe("high");
  });

  it("takes no columns on auto", () => {
    expect(thinkReadoutLabel("auto")).toBeNull();
    expect(thinkReadoutLabel(undefined)).toBeNull();
    expect(thinkReadoutLabel("medium")).toBe(" · think medium");
  });
});

describe("/think dispatch", () => {
  it("is a registered command", () => {
    expect(resolveSlashCommand("think")?.name).toBe("think");
  });

  it("sets the level in state and hands it to the submit path", () => {
    const result = dispatchSlashCommand("/think high");
    expect(result.reasoningLevel).toBe("high");
    expect(result.actions).toEqual([{ type: "reasoning_level_set", level: "high" }]);
    expect(result.systemMessage).toMatch(/Reasoning: high/);
    expect(result.forwardAsMessage).toBe(false);
  });

  it("bare /think only asks to show the level", () => {
    const result = dispatchSlashCommand("/think");
    expect(result.thinkShow).toBe(true);
    expect(result.reasoningLevel).toBeUndefined();
    expect(result.actions).toEqual([]);
  });

  it("the reducer keeps the level for the readout, starting on auto", () => {
    const initial = idleState();
    expect(initial.reasoningLevel).toBe("auto");
    const next = reduceTuiState(initial, { type: "reasoning_level_set", level: "low" });
    expect(next.reasoningLevel).toBe("low");
    expect(reduceTuiState(next, { type: "reasoning_level_set", level: "low" })).toBe(next);
  });

  it("the submit path calls the host, and bare /think reports the level in force", () => {
    const onReasoningLevelChanged = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;
    handleEditorSubmit("/think medium", idleState(), dispatch, callbacks({ onReasoningLevelChanged }));
    expect(onReasoningLevelChanged).toHaveBeenCalledWith("medium");

    dispatched.length = 0;
    const state = { ...idleState(), reasoningLevel: "high" as const };
    handleEditorSubmit("/think", state, dispatch, callbacks({ onReasoningLevelChanged }));
    expect(onReasoningLevelChanged).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === "system_message" && /Reasoning: high/.test(a.text ?? ""))).toBe(true);
  });
});

describe("the orchestrator sends the level on the next turn", () => {
  function harness() {
    const stored = [createEmptySessionState({ id: "s-b", workingDir: "/tmp" })];
    const store = {
      load: (id: string) => stored.find((s) => s.id === id) ?? null,
      readTurnProgress: () => null,
    };
    const options: Array<Record<string, unknown>> = [];
    const runtime = {
      createSession: () => createEmptySessionState({ id: "s-new", workingDir: "/tmp" }),
      steer: () => false,
      runTurn: (_s: unknown, _text: string, opts: Record<string, unknown>) => {
        options.push(opts);
        return new Promise(() => undefined);
      },
      sessionStore: {
        listSummaryPage: ({ limit }: { limit: number }) =>
          stored.map(summarizeSessionState).slice(0, limit),
        countUnreadable: () => 0,
        listRecent: () => stored,
        load: store.load,
        delete: () => undefined,
      },
      approvals: {
        clearSessionGrants: vi.fn(),
        denyPendingForSession: vi.fn(() => 0),
        pendingRequestForSession: () => null,
      },
      turnController: { isBusy: () => false },
      config: {
        update: { checkOnStartup: false, repo: "x/y" },
        tracing: { trace: { dir: "/tmp", enabled: false } },
      },
      profileStore: { list: () => [] },
      skillCatalog: [],
      interruptedTurns: createInterruptedTurns(store),
    } as unknown as AgentRuntime;
    const orchestrator = new ChatOrchestrator(runtime, makeTuiEventBus(), {
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: () => ({
        activeProviderIsLocal: false,
        managedMode: false,
        modelId: null,
        modelDownloaded: true,
        fallbackChainLength: 1,
      }),
    });
    orchestrator.switchSession("s-b");
    return { orchestrator, options };
  }

  it("passes reasoningOverride for a picked level and nothing on auto", () => {
    const { orchestrator, options } = harness();
    orchestrator.setReasoningLevel("high");
    orchestrator.sendMessage("first");
    expect(options[0]?.reasoningOverride).toBe("high");
  });

  it("sends no override by default", () => {
    const { orchestrator, options } = harness();
    orchestrator.sendMessage("first");
    expect(options[0]).toBeDefined();
    expect("reasoningOverride" in (options[0] ?? {})).toBe(false);
  });
});
