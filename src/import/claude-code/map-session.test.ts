import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_SESSION_ID_PREFIX,
  mapClaudeCodeSession,
} from "./map-session.js";
import type { ClaudeCodeSessionData } from "./claude-code-source.js";

const T0 = Date.parse("2026-08-02T10:00:00Z");

function session(partial: Partial<ClaudeCodeSessionData>): ClaudeCodeSessionData {
  return {
    id: "abc",
    cwd: "/work",
    title: null,
    messages: [],
    ...partial,
  };
}

describe("mapClaudeCodeSession", () => {
  it("maps text rows onto user and assistant turns", () => {
    const mapped = mapClaudeCodeSession(
      session({
        title: "Build fix",
        messages: [
          { role: "user", blocks: [{ type: "text", text: "hi" }], atMs: T0 },
          {
            role: "assistant",
            blocks: [
              { type: "thinking", thinking: "ponder" },
              { type: "text", text: "hello" },
            ],
            atMs: T0 + 1000,
          },
        ],
      }),
      "/fallback",
    );

    expect(mapped.id).toBe(`${CLAUDE_CODE_SESSION_ID_PREFIX}abc`);
    expect(mapped.workingDir).toBe("/work");
    expect(mapped.createdAt).toBe(T0);
    expect(mapped.updatedAt).toBe(T0 + 1000);
    expect(mapped.turnCount).toBe(1);
    expect(mapped.metadata).toMatchObject({
      importedFrom: "claude-code",
      claudeCodeSessionId: "abc",
      title: "Build fix",
    });
    expect(mapped.turns).toEqual([
      { kind: "user", text: "hi", at: T0 },
      {
        kind: "assistant_reply",
        text: "hello",
        at: T0 + 1000,
        reasoning: "ponder",
      },
    ]);
  });

  it("names tool results through the tool_use id seen earlier", () => {
    const mapped = mapClaudeCodeSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [
              { type: "toolUse", id: "t1", name: "Bash", args: { command: "ls" } },
            ],
            atMs: T0,
          },
          {
            role: "user",
            blocks: [
              { type: "toolResult", toolUseId: "t1", text: "ok", isError: false },
              { type: "toolResult", toolUseId: "t9", text: "?", isError: true },
            ],
            atMs: T0 + 1,
          },
        ],
      }),
      "/fallback",
    );

    expect(mapped.turns).toEqual([
      { kind: "assistant_tool_call", tool: "Bash", args: { command: "ls" }, at: T0 },
      { kind: "tool_result", tool: "Bash", status: "ok", summary: "ok", at: T0 + 1 },
      { kind: "tool_result", tool: "unknown", status: "error", summary: "?", at: T0 + 1 },
    ]);
  });

  it("emits the reply before the calls when a row carries both", () => {
    const mapped = mapClaudeCodeSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [
              { type: "text", text: "running it" },
              { type: "toolUse", id: "t1", name: "Bash", args: {} },
            ],
            atMs: T0,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns.map((t) => t.kind)).toEqual([
      "assistant_reply",
      "assistant_tool_call",
    ]);
  });

  it("keeps a thinking-only row as an empty reply with reasoning", () => {
    const mapped = mapClaudeCodeSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "interrupted" }],
            atMs: T0,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toEqual([
      { kind: "assistant_reply", text: "", at: T0, reasoning: "interrupted" },
    ]);
  });

  it("falls back to the provided working dir", () => {
    const mapped = mapClaudeCodeSession(session({ cwd: null }), "/fallback");
    expect(mapped.workingDir).toBe("/fallback");
  });
});
