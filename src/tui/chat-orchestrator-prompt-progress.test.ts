import { describe, expect, it } from "vitest";

import { turnProgressWanted } from "../agent/step/turn-progress-opt-in.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { createEmptySessionState } from "../session/session-state.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import { makeTuiEventBus } from "./make-event-bus.js";

// ATO-1001: the TUI asks for prompt reading progress for the turn it
// runs, and gives the claim back when the turn ends.

const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

function session(id = "s1") {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

function stubRuntime(runTurn: (sessionId: string) => Promise<unknown>): AgentRuntime {
  return {
    createSession: () => session(),
    capabilities: { workingDir: "/tmp" },
    getSessionWorkspace: () => null,
    skillRegistry: { listAll: () => [] },
    skillCatalogDropped: 0,
    steer: () => false,
    runTurn: (s: { id: string }) => runTurn(s.id),
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
  } as unknown as AgentRuntime;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("ChatOrchestrator prompt progress claim (ATO-1001)", () => {
  it("wants progress while the turn runs and not after it ends", async () => {
    let finish!: () => void;
    const wantedDuringTurn: boolean[] = [];
    const runTurn = (sessionId: string) => {
      wantedDuringTurn.push(turnProgressWanted(sessionId));
      return new Promise((resolve) => {
        finish = () => resolve({ session: session(sessionId), reason: "reply", stepCount: 1 });
      });
    };
    const orchestrator = new ChatOrchestrator(stubRuntime(runTurn), makeTuiEventBus(), {
      maxSteps: 5,
      llamaUrl: "http://127.0.0.1:8080",
      readGateFacts: cloudGateFacts,
    });

    orchestrator.sendMessage("hello");
    await settle();
    expect(wantedDuringTurn).toEqual([true]);

    finish();
    await settle();
    expect(turnProgressWanted("s1")).toBe(false);
  });

  it("gives the claim back when the turn fails", async () => {
    const orchestrator = new ChatOrchestrator(
      stubRuntime(() => Promise.reject(new Error("boom"))),
      makeTuiEventBus(),
      { maxSteps: 5, llamaUrl: "http://127.0.0.1:8080", readGateFacts: cloudGateFacts },
    );
    orchestrator.sendMessage("hello");
    await settle();
    expect(turnProgressWanted("s1")).toBe(false);
  });
});
