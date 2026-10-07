import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { createAgentRuntime } from "../../runtime/bootstrap.js";
import { FakeBrowserBackend } from "../../http/test-harness.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import { assistantToolCallTurn, recordTurn, toolResultTurn, userTurn } from "../../session/index.js";
import { ChatOrchestrator } from "../chat-orchestrator.js";
import { TuiApp, makeTuiEventBus } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";
import { makeMouseSource } from "../mouse/mouse-source.js";

afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); });

const SUMMARY = "Goal: preserve the green button. Constraints: do not deploy. Done: read files. Pending: implement and test.";
function completion(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 },
    cacheHitTokens: 0, slotId: 0, modelId: "test-model",
  };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each([
  { queued: false, cancel: false },
  { queued: true, cancel: false },
  { queued: false, cancel: true },
])("renders compaction through real TUI and runtime (queued: $queued, cancel: $cancel)", async ({ queued, cancel }) => {
  const dir = mkdtempSync(join(tmpdir(), "tui-compaction-live-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  vi.stubEnv("ATOMIC_AGENT_GRAMMARS_DIR", join(process.cwd(), "grammars"));
  resetConfigCache();
  const config = getConfig();
  config.agent.compaction.auto = false;
  config.agent.compaction.summaryMaxTokens = 250;
  config.agent.conversationMaxTokens = 4000;
  config.agent.nameSessions = false;
  config.memory.reflection.enabled = false;
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const main = latch(), summary = latch();
  let mainEntered = false, summaryCalls = 0;
  const runtime = await createAgentRuntime({ workingDir: dir, approvalLevel: 5,
    handlers: { onAgentEvent: (event, sessionId) => bus.emitAgentEvent(event, sessionId) },
    overrides: { browserBackend: new FakeBrowserBackend(), skipLlamaHealthCheck: true,
      llamaComplete: async (p) => {
        if (p.sessionId.startsWith("compaction:")) {
          summaryCalls++;
          await summary.promise;
          return completion(SUMMARY);
        }
        mainEntered = true;
        if (queued) await main.promise;
        return completion('[{"tool":"reply","args":{"text":"done"}}]');
      },
    },
  });
  let state = recordTurn(runtime.createSession(), userTurn("preserve the green button; do not deploy"));
  for (let i = 0; i < 20; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}: ${"important detail ".repeat(130)}` }));
  }
  runtime.sessionStore.save(state);
  const orchestrator = new ChatOrchestrator(runtime, bus, { llamaUrl: "http://127.0.0.1:8080" });
  let operation: Promise<void> | undefined;
  let abortCalls = 0;
  const app = render(<TuiApp session={fakeSession({ sessionId: state.id, workingDir: dir })} bus={bus} mouse={mouse} callbacks={{
    onApprovalDecision: () => {}, onAbort: () => { abortCalls++; orchestrator.abortCurrentTurn(); }, onQuit: () => {}, onMessageSubmitted: () => {},
    onCompactionRequested: (verb) => { operation = orchestrator.compactContext(verb); },
  }} />);
  const frame = () => (app.lastFrame() ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  let turn: ReturnType<typeof runtime.runTurn> | undefined;
  try {
    // Let the actual Ink input and bus subscriptions mount before typing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    orchestrator.switchSession(state.id);
    if (queued) {
      turn = runtime.runTurn(state, "continue", { signal: new AbortController().signal, maxSteps: 2 });
      await vi.waitFor(() => expect(mainEntered).toBe(true));
    }
    app.stdin.write("/compact");
    await vi.waitFor(() => expect(frame()).toContain("/compact"));
    app.stdin.write("\r");
    if (queued) {
      await vi.waitFor(() => expect(frame()).toContain("context compaction waiting for the current step"));
      expect(summaryCalls).toBe(0);
      main.release();
    }
    await vi.waitFor(() => expect(frame()).toContain("compacting context"));
    expect(frame()).toMatch(/part 1\/\d+/);
    expect(frame()).toContain("source tokens");
    expect(frame()).toContain("■ stop");
    expect(frame()).not.toContain(SUMMARY);
    if (cancel) {
      const lines = frame().split("\n");
      const y = lines.findIndex((line) => line.includes("■ stop"));
      const x = lines[y]!.indexOf("■ stop") + 1;
      // Hit targets register after paint; retry until the actual stop callback lands.
      await vi.waitFor(() => {
        mouse.emit({ kind: "press", button: "left", wheel: null, x, y, shift: false, alt: false, ctrl: false });
        expect(abortCalls).toBeGreaterThan(0);
      });
      await operation;
      await vi.waitFor(() => expect(frame()).toContain("Context compaction cancelled."));
      expect(frame()).not.toContain("compacting context");
      expect(frame()).not.toContain("■ stop");
      expect(runtime.getSessionCompaction(state.id)).toBeNull();
      expect(runtime.sessionStore.load(state.id)?.turns).toEqual(state.turns);
      return;
    }
    summary.release();
    await operation;
    await turn;
    await vi.waitFor(() => expect(frame()).toContain("Context compacted:"));
    expect(frame()).not.toContain("compacting context");
    expect(frame()).not.toContain("■ stop");
    expect(runtime.getSessionCompaction(state.id)?.summary).toBe(SUMMARY);
    expect(runtime.sessionStore.load(state.id)?.turns.slice(0, state.turns.length)).toEqual(state.turns);
    const calls = summaryCalls;
    app.stdin.write("/compact show");
    await vi.waitFor(() => expect(frame()).toContain("/compact show"));
    app.stdin.write("\r");
    await vi.waitFor(() => expect(frame()).toContain("Goal: preserve the green button."));
    expect(summaryCalls).toBe(calls);
  } finally {
    main.release(); summary.release();
    await operation; await turn;
    app.unmount();
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
