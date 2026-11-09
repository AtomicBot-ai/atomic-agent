import { describe, expect, it } from "vitest";

import {
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { createEmptySessionState } from "../../session/session-state.js";
import {
  HANDOFF_FROM_METADATA_KEY,
  HANDOFF_SOURCE_SESSION_METADATA_KEY,
  buildHandoffSession,
  handoffPrompt,
} from "./handoff-session.js";
import type { HandoffTranscript } from "./handoff-source.js";

function transcript(turns: ConversationTurn[]): HandoffTranscript {
  return {
    candidate: {
      agent: "claude-code",
      id: "cc-1",
      mtimeMs: 1,
      cwd: "/work/repo",
      title: "Fix the build",
      messageCount: turns.length,
    },
    mapped: {
      ...createEmptySessionState({ id: "claude-code:cc-1", workingDir: "/work/repo" }),
      turns,
      status: "completed",
      metadata: {
        importedFrom: "claude-code",
        claudeCodeSessionId: "cc-1",
        title: "Fix the build",
      },
    },
  };
}

describe("buildHandoffSession", () => {
  it("makes a new native session with handoff metadata, not the import row", () => {
    const built = buildHandoffSession({
      transcript: transcript([userTurn("fix the build", 1)]),
      now: 100,
      newId: () => "s-new",
    });
    expect(built.session.id).toBe("s-new");
    expect(built.session.workingDir).toBe("/work/repo");
    expect(built.session.updatedAt).toBe(100);
    expect(built.session.metadata).toEqual({
      title: "Fix the build (from Claude Code)",
      [HANDOFF_FROM_METADATA_KEY]: "claude-code",
      [HANDOFF_SOURCE_SESSION_METADATA_KEY]: "cc-1",
    });
    expect(built.closedCalls).toBe(0);
  });

  it("closes trailing tool calls that never got a result", () => {
    const built = buildHandoffSession({
      transcript: transcript([
        userTurn("fix it", 1),
        assistantToolCallTurn({ tool: "Bash", args: { command: "make" }, at: 2 }),
        toolResultTurn({ tool: "Bash", status: "ok", summary: "ok", at: 3 }),
        assistantToolCallTurn({ tool: "Edit", args: {}, at: 4 }),
        assistantToolCallTurn({ tool: "Bash", args: {}, at: 4 }),
      ]),
      now: 9,
      newId: () => "s-x",
    });
    expect(built.closedCalls).toBe(2);
    const tail = built.session.turns.slice(-2);
    expect(tail).toEqual([
      expect.objectContaining({ kind: "tool_result", tool: "Edit", status: "error", at: 9 }),
      expect.objectContaining({ kind: "tool_result", tool: "Bash", status: "error", at: 9 }),
    ]);
    expect(built.session.turns).toHaveLength(7);
  });

  it("uses the folder it is given over the transcript's", () => {
    const built = buildHandoffSession({
      transcript: transcript([userTurn("x", 1)]),
      workingDir: "/elsewhere",
      newId: () => "s-y",
    });
    expect(built.session.workingDir).toBe("/elsewhere");
    expect(built.prompt).toContain("/elsewhere");
  });
});

describe("handoffPrompt", () => {
  it("names the agent and the folder, and appends the operator's note", () => {
    const prompt = handoffPrompt("codex", "/w", "  run the tests first ");
    expect(prompt).toContain("from Codex");
    expect(prompt).toContain("/w");
    expect(prompt.endsWith("Also: run the tests first")).toBe(true);
  });

  it("adds nothing for a blank note", () => {
    expect(handoffPrompt("claude-code", "/w", "   ")).not.toContain("Also:");
  });
});
