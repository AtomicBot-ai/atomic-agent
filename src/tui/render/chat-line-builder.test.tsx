import { render } from "ink-testing-library";
import { Box } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { buildChatLines } from "./chat-line-builder.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "abc",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalRequired: false,
  maxSteps: 10,
  skillCount: 0,
};

function renderLines(state: TuiState, columns = 80): string {
  const lines = buildChatLines(state, {
    columns,
    toolsExpanded: state.toolsExpandedById,
  });
  const tree = createElement(Box, { flexDirection: "column" }, ...lines);
  const { lastFrame } = render(tree);
  return (lastFrame() ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("buildChatLines", () => {
  it("returns no lines when there is no history and no streaming", () => {
    const state = createInitialTuiState(SESSION);
    const lines = buildChatLines(state, {
      columns: 80,
      toolsExpanded: state.toolsExpandedById,
    });
    expect(lines).toHaveLength(0);
  });

  it("produces a separator + ribbon-padded body for a user message", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      messages: [
        { id: "u1", role: "user", text: "hello", timestamp: 1 },
      ],
    };
    const lines = buildChatLines(state, {
      columns: 80,
      toolsExpanded: state.toolsExpandedById,
    });
    // marginTop + paddingTop + 1 body line + paddingBottom
    expect(lines).toHaveLength(4);
    expect(renderLines(state)).toContain("hello");
  });

  it("strips simple markdown markers in finalised assistant text", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "hello **bold** there `code` end",
          toolSteps: 0,
          timestamp: 1,
        },
      ],
    };
    const txt = renderLines(state);
    expect(txt).toContain("hello bold there code end");
    expect(txt).not.toContain("**bold");
    expect(txt).not.toContain("`code`");
  });

  it("keeps streaming assistant text verbatim (no markdown lex)", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      streamingAssistantText: "hello **bold",
    };
    expect(renderLines(state)).toContain("**bold");
  });

  it("hides `reply` tool cards but renders other tools", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      streamingToolCards: [
        {
          id: "tc-real",
          stepIndex: 0,
          tool: "os.fs.read",
          args: { path: "src/index.ts" },
          status: "ok",
          summary: "read 42 lines",
          truncated: false,
          startedAt: 1,
          finishedAt: 1,
        },
        {
          id: "tc-reply",
          stepIndex: 0,
          tool: "reply",
          args: { text: "Done" },
          status: "ok",
          summary: 'text="Done"',
          truncated: false,
          startedAt: 1,
          finishedAt: 1,
        },
      ],
    };
    const txt = renderLines(state);
    expect(txt).toContain("os.fs.read");
    expect(txt).not.toContain('text="Done"');
  });

  it("wraps long body text into multiple physical rows", () => {
    const long = "a ".repeat(80).trim();
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      messages: [
        { id: "u1", role: "user", text: long, timestamp: 1 },
      ],
    };
    const lines = buildChatLines(state, {
      columns: 30,
      toolsExpanded: state.toolsExpandedById,
    });
    // marginTop(1) + paddingTop(1) + ≥3 body rows + paddingBottom(1)
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it("collapses long reasoning into a one-line summary when not expanded", () => {
    const longThink = "lorem ipsum ".repeat(60);
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      reasoning: [{ id: "r1", stepIndex: 0, text: longThink, timestamp: 1 }],
      streamingAssistantText: "Hi",
    };
    const txt = renderLines(state);
    expect(txt).toContain("reasoning");
    // Summary clipping ends with the ellipsis sentinel.
    expect(txt).toMatch(/…/);
  });

  it("expands reasoning while reply has not started streaming", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
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
    expect(renderLines(state)).toContain("first I will enumerate the options");
  });

  it("renders the assistant tool-step footer when toolSteps > 0", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: "done",
          toolSteps: 3,
          timestamp: 1,
        },
      ],
    };
    expect(renderLines(state)).toMatch(/3 tool steps/);
  });
});
