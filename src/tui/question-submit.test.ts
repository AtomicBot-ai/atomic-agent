import { describe, expect, it, vi } from "vitest";

import { approvalHotkey } from "./app-key-bindings.js";
import { questionHint } from "./question-prompt.js";
import { handleEditorSubmit } from "./submit-handler.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";
import type { TuiAppCallbacks } from "./tui-app.js";
import type { UserQuestion } from "../approval/user-question.js";

const QUESTION: UserQuestion = {
  prompt: "Which database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "MySQL" }],
  multiSelect: false,
  allowOther: true,
};

function questionState(question: UserQuestion = QUESTION): TuiState {
  return {
    ...createInitialTuiState({
      sessionId: "s1",
      workingDir: "/tmp",
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chrome",
      browserHeadless: false,
      approvalLevel: 5,
      maxSteps: 10,
      completionMaxTokens: 2048,
      skillCount: 0,
    }),
    pendingApproval: {
      approvalId: "q-1",
      sessionId: "s1",
      tool: "ask_user",
      category: "user_question",
      reason: question.prompt,
      question,
    },
  };
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

function submit(text: string, state: TuiState, cb: TuiAppCallbacks): Array<{ type: string }> {
  const dispatched: Array<{ type: string }> = [];
  handleEditorSubmit(text, state, ((a: { type: string }) => dispatched.push(a)) as never, cb);
  return dispatched;
}

describe("answering an ask_user question in the TUI (ATO-489)", () => {
  it("reads a number as the pick and closes the card", () => {
    const onQuestionAnswer = vi.fn();
    const onApprovalReply = vi.fn();
    const dispatched = submit("2", questionState(), callbacks({ onQuestionAnswer, onApprovalReply }));
    expect(onQuestionAnswer).toHaveBeenCalledWith("q-1", { selected: ["Postgres"] });
    expect(onApprovalReply).not.toHaveBeenCalled();
    expect(dispatched.map((a) => a.type)).toContain("approval_resolved");
  });

  it("reads prose as the person's own answer, not as a deny", () => {
    const onQuestionAnswer = vi.fn();
    const onApprovalReply = vi.fn();
    submit("whichever is simplest", questionState(), callbacks({ onQuestionAnswer, onApprovalReply }));
    expect(onQuestionAnswer).toHaveBeenCalledWith("q-1", {
      selected: [],
      other: "whichever is simplest",
    });
    expect(onApprovalReply).not.toHaveBeenCalled();
  });

  it("keeps the card open and says why on an answer that does not fit", () => {
    const onQuestionAnswer = vi.fn();
    const dispatched = submit("1,2", questionState(), callbacks({ onQuestionAnswer }));
    expect(onQuestionAnswer).not.toHaveBeenCalled();
    expect(dispatched.map((a) => a.type)).toEqual(["system_message"]);
  });

  it("does not take ctrl+y as an answer; ctrl+d still skips", () => {
    const state = questionState();
    expect(approvalHotkey(state, "y", { ctrl: true, meta: false } as never)).toBeNull();
    expect(approvalHotkey(state, "d", { ctrl: true, meta: false } as never)).toBe("deny");
  });

  it("explains how to answer, by the question's kind", () => {
    expect(questionHint(QUESTION)).toBe(
      "type the number of your pick or your own answer in the composer, then enter",
    );
    expect(questionHint({ ...QUESTION, multiSelect: true, allowOther: false })).toBe(
      "type the numbers of your picks (1,3) in the composer, then enter",
    );
  });
});
