import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../runtime/bootstrap.js";
import { createInterruptedTurns } from "../runtime/interrupted-turns.js";
import { createEmptySessionState } from "../session/session-state.js";
import { summarizeSessionState } from "../session/session-summary.js";
import type { TurnProgress } from "../session/turn-progress.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { NOTHING_TO_RESUME } from "./interrupted-turn-notice.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import { dispatchSlashCommand } from "./commands/slash-command-handler.js";
import { resolveSlashCommand } from "./commands/slash-commands.js";
import { handleEditorSubmit } from "./submit-handler.js";
import type { TuiAppCallbacks } from "./tui-app.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";

/** `/resume`: continue a reply a restart cut off, once (ATO-448). */

function idleState(sessionId: string | null = "s1"): TuiState {
  return createInitialTuiState({
    sessionId,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
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

function systemTexts(dispatched: Array<{ type: string; text?: string }>): string[] {
  return dispatched.flatMap((a) =>
    a.type === "system_message" && a.text !== undefined ? [a.text] : [],
  );
}

describe("/resume", () => {
  it("is a registered command", () => {
    expect(resolveSlashCommand("resume")?.name).toBe("resume");
    expect(dispatchSlashCommand("/resume").resumeInterruptedTurn).toBe(true);
  });

  it("takes no arguments", () => {
    const result = dispatchSlashCommand("/resume now");
    expect(result.resumeInterruptedTurn).toBeUndefined();
    expect(result.systemMessage).toContain("usage: /resume");
  });

  it("sends the continuing message as the person's turn", () => {
    const onMessageSubmitted = vi.fn();
    const prepareInterruptedTurnResume = vi.fn(() => "[Resumed] continue");
    const dispatched: Array<{ type: string; text?: string }> = [];
    handleEditorSubmit(
      "/resume",
      idleState(),
      ((a: { type: string }) => dispatched.push(a)) as never,
      callbacks({ onMessageSubmitted, prepareInterruptedTurnResume }),
    );
    expect(prepareInterruptedTurnResume).toHaveBeenCalledWith("s1");
    expect(onMessageSubmitted).toHaveBeenCalledWith("[Resumed] continue");
    expect(dispatched.map((a) => a.type)).toContain("message_submitted");
  });

  it("says there is nothing to resume the second time", () => {
    // The runtime records the turn as resumed when it hands the message out.
    let taken = false;
    const prepareInterruptedTurnResume = vi.fn(() => {
      if (taken) return null;
      taken = true;
      return "[Resumed] continue";
    });
    const onMessageSubmitted = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;
    const cbs = callbacks({ onMessageSubmitted, prepareInterruptedTurnResume });
    handleEditorSubmit("/resume", idleState(), dispatch, cbs);
    handleEditorSubmit("/resume", idleState(), dispatch, cbs);
    expect(onMessageSubmitted).toHaveBeenCalledTimes(1);
    expect(systemTexts(dispatched)).toContain(NOTHING_TO_RESUME);
  });

  it("says there is nothing to resume without a session or a runtime that offers it", () => {
    const onMessageSubmitted = vi.fn();
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;
    handleEditorSubmit("/resume", idleState(null), dispatch, callbacks({ onMessageSubmitted }));
    handleEditorSubmit("/resume", idleState(), dispatch, callbacks({ onMessageSubmitted }));
    expect(onMessageSubmitted).not.toHaveBeenCalled();
    expect(systemTexts(dispatched)).toEqual([NOTHING_TO_RESUME, NOTHING_TO_RESUME]);
  });
});

/**
 * The whole TUI path with a real orchestrator and the runtime's own
 * `interruptedTurns` (review F05-10): a `/resume` parked behind a busy
 * turn and then dropped must not lose the cut-off turn.
 */
describe("/resume while another turn is busy", () => {
  const cutOff = {
    status: "cancelled" as const,
    lastError: "turn interrupted: the agent stopped before it finished",
  };

  function harness() {
    const stored = [
      { ...createEmptySessionState({ id: "s-b", workingDir: "/tmp" }), ...cutOff },
    ];
    const marker: TurnProgress = {
      stepsDone: 1,
      lastStepIndex: 0,
      request: "push the branch",
      options: { interactive: true },
      resumes: 0,
      startedAt: 1_000,
      updatedAt: 2_000,
    };
    const store = {
      load: (id: string) => stored.find((s) => s.id === id) ?? null,
      readTurnProgress: (id: string) => (id === "s-b" ? marker : null),
    };
    const interruptedTurns = createInterruptedTurns(store);
    const turns: string[] = [];
    const runtime = {
      createSession: () => createEmptySessionState({ id: "s-new", workingDir: "/tmp" }),
      steer: () => false,
      // Never settles: the first turn keeps the session busy.
      runTurn: (_s: unknown, text: string) => {
        turns.push(text);
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
      interruptedTurns,
    } as unknown as AgentRuntime;
    const orchestrator = new ChatOrchestrator(runtime, makeTuiEventBus(), {
      maxSteps: 5,
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
    const cbs = callbacks({
      onMessageSubmitted: (text) => orchestrator.sendMessage(text),
      onQueueClearRequested: () => orchestrator.clearQueue(),
      prepareInterruptedTurnResume: (id) => interruptedTurns.resumeMessage(id),
    });
    return { orchestrator, cbs, turns };
  }

  it("offers the turn again after the queued /resume is cleared", () => {
    const { orchestrator, cbs, turns } = harness();
    orchestrator.sendMessage("something else");
    expect(turns).toEqual(["something else"]);
    const busy: TuiState = { ...idleState("s-b"), status: "running" };
    const dispatched: Array<{ type: string; text?: string }> = [];
    const dispatch = ((a: { type: string }) => dispatched.push(a)) as never;

    handleEditorSubmit("/resume", busy, dispatch, cbs);
    expect(dispatched.map((a) => a.type)).toContain("message_queued");
    // Queued, not started: a second /resume has nothing to offer.
    handleEditorSubmit("/resume", busy, dispatch, cbs);
    expect(systemTexts(dispatched)).toContain(NOTHING_TO_RESUME);

    handleEditorSubmit("/queue clear", busy, dispatch, cbs);
    dispatched.length = 0;
    handleEditorSubmit("/resume", busy, dispatch, cbs);
    expect(systemTexts(dispatched)).not.toContain(NOTHING_TO_RESUME);
    expect(dispatched.map((a) => a.type)).toContain("message_queued");
    // Nothing ran on its own meanwhile.
    expect(turns).toEqual(["something else"]);
  });
});
