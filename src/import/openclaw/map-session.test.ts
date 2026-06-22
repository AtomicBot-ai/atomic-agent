import { describe, expect, it } from "vitest";
import { mapOpenclawSession } from "./map-session.js";
import type {
  OpenclawBlock,
  OpenclawMessage,
  OpenclawSessionMeta,
} from "./openclaw-source.js";

function meta(overrides: Partial<OpenclawSessionMeta> = {}): OpenclawSessionMeta {
  return {
    id: "gaia-123",
    file: "/x/gaia-123.jsonl",
    cwd: "/work/proj",
    model: "qwen-3.6-35b-a3b",
    startedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function msg(
  role: OpenclawMessage["role"],
  blocks: OpenclawBlock[],
  overrides: Partial<OpenclawMessage> = {},
): OpenclawMessage {
  return {
    role,
    blocks,
    toolCallId: null,
    toolName: null,
    isError: false,
    atMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("mapOpenclawSession", () => {
  it("prefixes the id and carries metadata", () => {
    const state = mapOpenclawSession(meta(), [], "/fallback");
    expect(state.id).toBe("openclaw:gaia-123");
    expect(state.status).toBe("completed");
    expect(state.metadata).toMatchObject({
      importedFrom: "openclaw",
      openclawSessionId: "gaia-123",
      openclawModel: "qwen-3.6-35b-a3b",
    });
  });

  it("falls back to the provided working dir when cwd is null", () => {
    const state = mapOpenclawSession(meta({ cwd: null }), [], "/fallback");
    expect(state.workingDir).toBe("/fallback");
  });

  it("maps a user text message to a user turn", () => {
    const state = mapOpenclawSession(
      meta(),
      [msg("user", [{ type: "text", text: "read budget.txt" }], { atMs: 42 })],
      "/fallback",
    );
    expect(state.turns).toEqual([
      { kind: "user", text: "read budget.txt", at: 42 },
    ]);
  });

  it("maps an assistant message without tool calls to a reply with reasoning", () => {
    const state = mapOpenclawSession(
      meta(),
      [
        msg("assistant", [
          { type: "thinking", thinking: "let me reason" },
          { type: "text", text: "Budget is $1,250" },
        ]),
      ],
      "/fallback",
    );
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      kind: "assistant_reply",
      text: "Budget is $1,250",
      reasoning: "let me reason",
    });
    expect(state.turnCount).toBe(1);
  });

  it("maps assistant toolCall blocks to assistant_tool_call turns (reasoning on first)", () => {
    const state = mapOpenclawSession(
      meta(),
      [
        msg("assistant", [
          { type: "thinking", thinking: "r" },
          { type: "toolCall", id: "c1", name: "read", args: { path: "a.txt" } },
          { type: "toolCall", id: "c2", name: "grep", args: { q: "x" } },
        ]),
      ],
      "/fallback",
    );
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({
      kind: "assistant_tool_call",
      tool: "read",
      args: { path: "a.txt" },
      reasoning: "r",
    });
    expect(state.turns[1]).toMatchObject({ tool: "grep", args: { q: "x" } });
    expect((state.turns[1] as { reasoning?: string }).reasoning).toBeUndefined();
    expect(state.turnCount).toBe(0);
  });

  it("maps toolResult to a tool_result turn; isError -> error status", () => {
    const state = mapOpenclawSession(
      meta(),
      [
        msg("toolResult", [{ type: "text", text: "ok output" }], {
          toolName: "read",
        }),
        msg("toolResult", [{ type: "text", text: "boom" }], {
          toolName: "shell",
          isError: true,
        }),
      ],
      "/fallback",
    );
    expect(state.turns[0]).toMatchObject({
      kind: "tool_result",
      tool: "read",
      status: "ok",
      summary: "ok output",
    });
    expect(state.turns[1]).toMatchObject({
      kind: "tool_result",
      tool: "shell",
      status: "error",
      summary: "boom",
    });
  });

  it("uses the last message timestamp for updatedAt", () => {
    const state = mapOpenclawSession(
      meta({ startedAtMs: 1000 }),
      [
        msg("user", [{ type: "text", text: "hi" }], { atMs: 1000 }),
        msg("assistant", [{ type: "text", text: "bye" }], { atMs: 2000 }),
      ],
      "/fallback",
    );
    expect(state.createdAt).toBe(1000);
    expect(state.updatedAt).toBe(2000);
  });
});
