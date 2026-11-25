import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { SideQuestionResult } from "../runtime/side-question.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";

/** Hermetic gate facts: never read the developer's real config/disk. */
const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

type Ask = NonNullable<AgentRuntime["askSideQuestion"]>;

function stubRuntime(askSideQuestion: Ask | undefined): AgentRuntime {
  const session = () => createEmptySessionState({ id: "s1", workingDir: "/tmp" });
  return {
    createSession: session,
    capabilities: { workingDir: "/tmp" },
    getSessionWorkspace: () => null,
    skillRegistry: { listAll: () => [] },
    skillCatalogDropped: 0,
    steer: () => false,
    // A turn that runs until aborted, so a session exists while it does.
    runTurn: (_s: unknown, _text: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    turnController: { isBusy: () => false },
    sessionStore: {
      listSummaryPage: () => [],
      countUnreadable: () => 0,
      listRecent: () => [],
      load: () => null,
    },
    approvals: { clearSessionGrants: () => undefined },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
    ...(askSideQuestion ? { askSideQuestion } : {}),
  } as unknown as AgentRuntime;
}

function setup(askSideQuestion: Ask | undefined) {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  const orchestrator = new ChatOrchestrator(stubRuntime(askSideQuestion), bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: cloudGateFacts,
  });
  return { orchestrator, actions };
}

function systemLines(actions: readonly TuiAction[]): string[] {
  return actions.flatMap((a) => (a.type === "system_message" ? [a.text] : []));
}

/** A side question that only settles when its signal aborts. */
function hangingAsk(): Ask {
  return (_question, options) =>
    new Promise<SideQuestionResult>((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true });
    });
}

describe("ChatOrchestrator /btw (ATO-1152)", () => {
  it("shows the answer as a chat notice and writes no turn", async () => {
    const ask = vi.fn<Ask>(async () => ({ ok: true, text: "auth.ts" }));
    const { orchestrator, actions } = setup(ask);
    await orchestrator.askSideQuestion("which file?");
    expect(systemLines(actions)).toContain("btw › auth.ts");
    expect(ask.mock.calls[0]?.[0]).toBe("which file?");
    expect(ask.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the open session's id, and keeps running beside a busy turn", async () => {
    let signal: AbortSignal | undefined;
    const hanging = hangingAsk();
    const ask = vi.fn<Ask>((question, options) => {
      signal = options?.signal;
      return hanging(question, options);
    });
    const { orchestrator } = setup(ask);
    orchestrator.sendMessage("open a session");
    const pending = orchestrator.askSideQuestion("status?");
    expect(ask.mock.calls[0]?.[1]?.sessionId).toBe("s1");
    orchestrator.sendMessage("another message");
    expect(signal?.aborted).toBe(false);
    orchestrator.cancelSideQuestion();
    await pending;
    orchestrator.abortCurrentTurn();
  });

  it("refuses a second side question while one is running", async () => {
    const { orchestrator, actions } = setup(hangingAsk());
    const first = orchestrator.askSideQuestion("one");
    await orchestrator.askSideQuestion("two");
    expect(systemLines(actions)).toContain("Already answering a side question; wait for it to finish.");
    orchestrator.cancelSideQuestion();
    await first;
  });

  it("drops the answer quietly when a new chat starts meanwhile", async () => {
    let signal: AbortSignal | undefined;
    const hanging = hangingAsk();
    const { orchestrator, actions } = setup((question, options) => {
      signal = options?.signal;
      return hanging(question, options);
    });
    const pending = orchestrator.askSideQuestion("q");
    orchestrator.newSession();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(systemLines(actions).some((l) => l.startsWith("Could not answer"))).toBe(false);
  });

  it("says why on a failure", async () => {
    const { orchestrator, actions } = setup(async () => ({ ok: false, reason: "timed out" }));
    await orchestrator.askSideQuestion("q");
    expect(systemLines(actions)).toContain("Could not answer the side question (timed out).");
  });

  it("says so when the runtime does not offer side questions", async () => {
    const { orchestrator, actions } = setup(undefined);
    await orchestrator.askSideQuestion("q");
    expect(systemLines(actions)).toContain("Side questions are not available here.");
  });
});
