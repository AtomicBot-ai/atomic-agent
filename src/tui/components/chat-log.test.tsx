import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";
import { ChatLog } from "./chat-log.js";

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

describe("ChatLog", () => {
  it("renders the empty placeholder when no messages and no streaming", () => {
    const state = createInitialTuiState(BASE_SESSION);
    const { lastFrame } = render(<ChatLog state={state} />);
    expect(strip(lastFrame() ?? "")).toContain("no messages yet");
  });

  it("renders a user and assistant bubble", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      messages: [
        {
          id: "m1",
          role: "user",
          text: "hello",
          timestamp: 1,
        },
        {
          id: "m2",
          role: "assistant",
          text: "hi there",
          toolSteps: 0,
          timestamp: 2,
        },
      ],
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("you");
    expect(text).toContain("hello");
    expect(text).toContain("assistant");
    expect(text).toContain("hi there");
  });

  it("renders the streaming assistant tail when streamingAssistantText is set", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      streamingAssistantText: "partial reply…",
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("partial reply…");
  });
});
