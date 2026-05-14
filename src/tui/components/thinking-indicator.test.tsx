import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";
import { ThinkingIndicator } from "./thinking-indicator.js";

const BASE_SESSION: TuiSessionInfo = {
  sessionId: "abc",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalRequired: false,
  maxSteps: 10,
  skillCount: 0,
};

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

function makeState(overrides: Partial<TuiState>): TuiState {
  return {
    ...createInitialTuiState(BASE_SESSION),
    status: "running",
    runStartedAt: Date.now() - 12_000,
    ...overrides,
  };
}

describe("ThinkingIndicator", () => {
  it("renders nothing when the agent is idle", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      status: "idle",
    };
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text.trim()).toBe("");
  });

  it("shows 'thinking · Ns' when no streaming content has arrived yet", () => {
    const state = makeState({});
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toMatch(/thinking · \d+s/);
  });

  it("shows the active tool name + identifying arg when a tool is in flight", () => {
    const state = makeState({
      streamingToolCalls: [
        {
          id: "tc-1",
          stepIndex: 0,
          tool: "os.fs.read",
          args: { path: "src/agent/loop.ts" },
          startedAt: Date.now(),
        },
      ],
    });
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("os.fs.read");
    expect(text).toContain("src/agent/loop.ts");
    expect(text).toMatch(/\d+s/);
  });

  it("collapses to 'writing reply · Ns' once assistant text starts streaming", () => {
    const state = makeState({
      streamingAssistantText: "Hi there",
    });
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toMatch(/writing reply · \d+s/);
  });

  it("falls back to 'thinking' when the only live tool call is `reply`", () => {
    const state = makeState({
      streamingToolCalls: [
        {
          id: "tc-1",
          stepIndex: 0,
          tool: "reply",
          args: { text: "Done." },
          startedAt: Date.now(),
        },
      ],
    });
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toMatch(/thinking · \d+s/);
    expect(text).not.toContain("reply");
  });

  it("formats minutes for elapsed durations over 60s", () => {
    const state = makeState({
      runStartedAt: Date.now() - 75_000,
    });
    const { lastFrame } = render(<ThinkingIndicator state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toMatch(/1m\d\ds/);
  });
});
