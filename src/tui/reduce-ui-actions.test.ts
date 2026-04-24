import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import type { TuiAction } from "./tui-action.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

function fakeSession(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalRequired: false,
    maxSteps: 10,
    skillCount: 0,
    ...overrides,
  };
}

function apply(state: TuiState, actions: TuiAction[]): TuiState {
  return actions.reduce(reduceTuiState, state);
}

describe("UI-mode and streaming reducers", () => {
  it("toggles ui mode between chat and debug", () => {
    const initial = createInitialTuiState(fakeSession());
    expect(initial.uiMode).toBe("chat");
    const toggled = reduceTuiState(initial, { type: "ui_mode_toggled" });
    expect(toggled.uiMode).toBe("debug");
    const back = reduceTuiState(toggled, { type: "ui_mode_toggled" });
    expect(back.uiMode).toBe("chat");
  });

  it("records user message in inputHistory", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = reduceTuiState(initial, {
      type: "agent_event",
      event: { type: "user_message", text: "first goal" },
    });
    expect(next.inputHistory).toEqual(["first goal"]);
  });

  it("navigates input history with Up/Down", () => {
    const initial = createInitialTuiState(fakeSession());
    const populated = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "one" } },
      { type: "agent_event", event: { type: "user_message", text: "two" } },
    ]);
    const up1 = reduceTuiState(populated, {
      type: "input_history_navigated",
      delta: -1,
    });
    expect(up1.inputValue).toBe("two");
    expect(up1.inputHistoryCursor).toBe(1);
    const up2 = reduceTuiState(up1, {
      type: "input_history_navigated",
      delta: -1,
    });
    expect(up2.inputValue).toBe("one");
    const down1 = reduceTuiState(up2, {
      type: "input_history_navigated",
      delta: 1,
    });
    expect(down1.inputValue).toBe("two");
    const down2 = reduceTuiState(down1, {
      type: "input_history_navigated",
      delta: 1,
    });
    expect(down2.inputValue).toBe("");
    expect(down2.inputHistoryCursor).toBeNull();
  });

  it("toggles tool expand state per id", () => {
    const initial = createInitialTuiState(fakeSession());
    const on = reduceTuiState(initial, {
      type: "tool_expand_toggled",
      toolCardId: "tc-1",
    });
    expect(on.toolsExpandedById["tc-1"]).toBe(true);
    const off = reduceTuiState(on, {
      type: "tool_expand_toggled",
      toolCardId: "tc-1",
    });
    expect(off.toolsExpandedById["tc-1"]).toBe(false);
  });

  it("accumulates streaming assistant text via assistant_delta", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "assistant_delta", text: "Hel" },
      { type: "assistant_delta", text: "lo" },
    ]);
    expect(next.streamingAssistantText).toBe("Hello");
  });

  it("converts streaming tool calls into tool cards on assistant_reply", () => {
    const initial = createInitialTuiState(fakeSession());
    const next = apply(initial, [
      { type: "message_submitted" },
      { type: "agent_event", event: { type: "turn_started", turnIndex: 0 } },
      { type: "agent_event", event: { type: "step_started", stepIndex: 0 } },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_parsed",
            call: { tool: "shell.exec", args: { cmd: "ls" } },
          },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: {
              tool: "shell.exec",
              status: "ok",
              summary: "README.md",
              truncated: false,
            },
          },
        },
      },
      {
        type: "agent_event",
        event: {
          type: "llm_event",
          event: { type: "assistant_reply", text: "done" },
        },
      },
    ]);
    const last = next.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.toolCards).toHaveLength(1);
    expect(last?.toolCards?.[0]?.tool).toBe("shell.exec");
    expect(last?.toolCards?.[0]?.status).toBe("ok");
    expect(next.streamingToolCards).toEqual([]);
    expect(next.streamingToolCalls).toEqual([]);
  });

  it("clears transcript on chat_cleared", () => {
    const initial = createInitialTuiState(fakeSession());
    const seeded = apply(initial, [
      { type: "agent_event", event: { type: "user_message", text: "x" } },
      { type: "assistant_delta", text: "partial" },
    ]);
    const cleared = reduceTuiState(seeded, { type: "chat_cleared" });
    expect(cleared.messages).toHaveLength(0);
    expect(cleared.streamingAssistantText).toBeNull();
    expect(cleared.feed).toHaveLength(0);
  });

  it("opens and closes the slash palette", () => {
    const initial = createInitialTuiState(fakeSession());
    const opened = reduceTuiState(initial, {
      type: "slash_palette_opened",
      query: "cl",
    });
    expect(opened.slashPaletteOpen).toBe(true);
    expect(opened.slashQuery).toBe("cl");
    const closed = reduceTuiState(opened, { type: "slash_palette_closed" });
    expect(closed.slashPaletteOpen).toBe(false);
    expect(closed.slashQuery).toBe("");
  });
});
