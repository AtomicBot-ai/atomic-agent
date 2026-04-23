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
  it("renders the splash banner when no messages and no streaming", () => {
    const state = createInitialTuiState(BASE_SESSION);
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("local operator agent");
    expect(text).toContain("/help");
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

  it("skips markdown during streaming so partial `**` does not flicker", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      streamingAssistantText: "hello **bold",
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    // Literal asterisks must survive while the reply is still coming in —
    // we only lex markdown once the turn finalises.
    expect(text).toContain("**bold");
  });

  it("applies markdown to the finalised assistant message", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "hello **bold** there",
          toolSteps: 0,
          timestamp: 1,
        },
      ],
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("hello");
    expect(text).toContain("bold");
    expect(text).toContain("there");
    expect(text).not.toMatch(/\*\*bold/);
  });

  it("expands the live reasoning bubble before any reply text arrives", () => {
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      reasoning: [
        {
          id: "r1",
          stepIndex: 0,
          text: "first I will enumerate the options",
          timestamp: 1,
        },
      ],
      streamingAssistantText: null,
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("first I will enumerate the options");
  });

  it("collapses the live reasoning bubble once reply text starts streaming", () => {
    const longThink =
      "paragraph one is quite long and detailed so the summary has to clip it with an ellipsis and still fit on one line, and then paragraph two follows with even more extra detail that must not appear verbatim in the collapsed summary";
    const state: TuiState = {
      ...createInitialTuiState(BASE_SESSION),
      reasoning: [
        { id: "r1", stepIndex: 0, text: longThink, timestamp: 1 },
      ],
      streamingAssistantText: "Hi",
    };
    const { lastFrame } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    // Collapsed summary clips at the SUMMARY_LIMIT, so a specific tail of
    // the full reasoning text must not be present.
    expect(text).not.toContain("appear verbatim in the collapsed summary");
    // Reply is streaming below the collapsed reasoning.
    expect(text).toContain("Hi");
    expect(text).toMatch(/reasoning/);
  });
});
