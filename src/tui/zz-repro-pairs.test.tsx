import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";

const persisted: number[] = [];
vi.mock("./persist-conversation-max-pairs.js", () => ({
  persistConversationMaxPairs: (pairs: number) => {
    persisted.push(pairs);
  },
}));

const { makeTuiEventBus, TuiApp } = await import("./tui-app.js");
type TuiAppCallbacks = import("./tui-app.js").TuiAppCallbacks;
import type { TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/repro",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function builtPrompt(): BuiltPrompt {
  return {
    text: "",
    stablePrefix: "",
    tail: "",
    tokens: {
      stablePrefix: 5240,
      loadedSkills: 0,
      sessionFacts: 610,
      loadedTools: 0,
      profile: 0,
      worldSnapshot: 1020,
      conversation: 31_880,
      recalled: 2150,
      memoryIndex: 0,
      taskPolicy: 0,
      total: 40_900,
    },
    limits: {
      total: 40_000,
      stablePrefix: 14_000,
      session: 6000,
      worldSnapshot: 6000,
      conversation: 14_000,
    },
    truncated: false,
    truncation: {
      loadedSkills: false,
      sessionFacts: false,
      loadedTools: false,
      profile: false,
      worldSnapshot: false,
      conversation: false,
      recalled: false,
      memoryIndex: false,
    },
    contextWindow: 131_072,
    conversationCapEffective: 14_000,
    conversationCapAuto: false,
    droppedTurns: 0,
    conversationPairs: 3,
    droppedPairs: 0,
    conversationPairsCap: 20,
    conversationBoundBy: null,
    pairCosts: [10_000, 11_000, 10_880],
  };
}

function strip(value: string): string {
  return value
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

let restoreIsTty: (() => void) | null = null;
beforeEach(() => {
  persisted.length = 0;
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  restoreIsTty = () => {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
});
afterEach(() => {
  restoreIsTty?.();
  restoreIsTty = null;
});

function selectorValue(frame: string): string {
  const line = strip(frame)
    .split("\n")
    .find((l) => l.includes("tasks per turn"));
  if (!line) throw new Error(`no selector row:\n${strip(frame)}`);
  return line;
}

describe("repro: key repeat on the pairs selector", () => {
  it("one stdin chunk of three '-' presses", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 60));
    bus.emitAgentEvent({ type: "llm_event", event: { type: "prompt_built", prompt: builtPrompt(), slotId: 1 } });
    bus.emit({ type: "context_panel_toggled" });
    await new Promise((r) => setTimeout(r, 60));
    console.log("BEFORE:", selectorValue(lastFrame() ?? ""));

    // A single readable chunk carrying three key-repeat presses.
    stdin.write("---");
    await new Promise((r) => setTimeout(r, 100));
    console.log("AFTER :", selectorValue(lastFrame() ?? ""));
    console.log("PERSISTED:", JSON.stringify(persisted));
    unmount();
    expect(true).toBe(true);
  });

  it("separate chunks, three '-' presses", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 60));
    bus.emitAgentEvent({ type: "llm_event", event: { type: "prompt_built", prompt: builtPrompt(), slotId: 1 } });
    bus.emit({ type: "context_panel_toggled" });
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 60));
    console.log("AFTER-SEPARATE:", selectorValue(lastFrame() ?? ""));
    console.log("PERSISTED-SEPARATE:", JSON.stringify(persisted));
    unmount();
    expect(true).toBe(true);
  });

  it("close and reopen after stepping", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 60));
    bus.emitAgentEvent({ type: "llm_event", event: { type: "prompt_built", prompt: builtPrompt(), slotId: 1 } });
    bus.emit({ type: "context_panel_toggled" });
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 60));
    console.log("STEPPED:", selectorValue(lastFrame() ?? ""));
    console.log("PERSISTED-2:", JSON.stringify(persisted));
    // close
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 60));
    bus.emit({ type: "context_panel_toggled" });
    await new Promise((r) => setTimeout(r, 60));
    console.log("REOPENED:", selectorValue(lastFrame() ?? ""));
    // one more step from the reopened panel
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 60));
    console.log("AFTER-REOPEN-STEP:", selectorValue(lastFrame() ?? ""));
    console.log("PERSISTED-3:", JSON.stringify(persisted));
    unmount();
    expect(true).toBe(true);
  });
});
