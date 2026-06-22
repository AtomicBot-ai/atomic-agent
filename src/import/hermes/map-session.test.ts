import { describe, expect, it } from "vitest";
import { mapHermesSession } from "./map-session.js";
import type { HermesMessage, HermesSession } from "./hermes-source.js";

function session(overrides: Partial<HermesSession> = {}): HermesSession {
  return {
    id: "s-1",
    cwd: "/work/proj",
    title: "Budget review",
    model: "qwen-3.6-35b-a3b",
    startedAtSeconds: 1_700_000_000,
    archived: false,
    ...overrides,
  };
}

function msg(overrides: Partial<HermesMessage>): HermesMessage {
  return {
    id: 1,
    sessionId: "s-1",
    role: "user",
    content: null,
    toolCalls: null,
    toolName: null,
    timestampSeconds: 1_700_000_000,
    reasoning: null,
    ...overrides,
  };
}

describe("mapHermesSession", () => {
  it("prefixes the id and carries metadata", () => {
    const state = mapHermesSession(session(), [], "/fallback");
    expect(state.id).toBe("hermes:s-1");
    expect(state.status).toBe("completed");
    expect(state.metadata).toMatchObject({
      importedFrom: "hermes",
      hermesSessionId: "s-1",
      title: "Budget review",
      hermesModel: "qwen-3.6-35b-a3b",
    });
  });

  it("falls back to the provided working dir when cwd is null", () => {
    const state = mapHermesSession(session({ cwd: null }), [], "/fallback");
    expect(state.workingDir).toBe("/fallback");
  });

  it("converts REAL second timestamps to integer milliseconds", () => {
    const state = mapHermesSession(
      session({ startedAtSeconds: 1_700_000_000.5 }),
      [msg({ id: 1, role: "user", content: "hi", timestampSeconds: 1_700_000_123.4 })],
      "/fallback",
    );
    expect(state.createdAt).toBe(1_700_000_000_500);
    expect(state.turns[0]?.at).toBe(1_700_000_123_400);
    expect(state.updatedAt).toBe(1_700_000_123_400);
  });

  it("maps user / assistant-reply / tool roles to turns", () => {
    const state = mapHermesSession(
      session(),
      [
        msg({ id: 1, role: "user", content: "read budget.txt" }),
        msg({
          id: 2,
          role: "assistant",
          content: "Budget is $1,250",
          reasoning: "thinking...",
        }),
        msg({ id: 3, role: "tool", toolName: "read_file", content: "{...}" }),
      ],
      "/fallback",
    );
    expect(state.turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_reply",
      "tool_result",
    ]);
    const reply = state.turns[1];
    expect(reply).toMatchObject({
      kind: "assistant_reply",
      text: "Budget is $1,250",
      reasoning: "thinking...",
    });
    expect(state.turns[2]).toMatchObject({
      kind: "tool_result",
      tool: "read_file",
      status: "ok",
    });
    expect(state.turnCount).toBe(1);
  });

  it("parses tool_calls into assistant_tool_call turns with parsed args", () => {
    const toolCalls = JSON.stringify([
      {
        id: "c1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"budget.txt"}' },
      },
    ]);
    const state = mapHermesSession(
      session(),
      [
        msg({
          id: 1,
          role: "assistant",
          content: "",
          toolCalls,
          reasoning: "let me read it",
        }),
      ],
      "/fallback",
    );
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      kind: "assistant_tool_call",
      tool: "read_file",
      args: { path: "budget.txt" },
      reasoning: "let me read it",
    });
    // tool calls are not replies
    expect(state.turnCount).toBe(0);
  });

  it("attaches reasoning only to the first call in a multi-call message", () => {
    const toolCalls = JSON.stringify([
      { function: { name: "a", arguments: "{}" } },
      { function: { name: "b", arguments: "{}" } },
    ]);
    const state = mapHermesSession(
      session(),
      [msg({ id: 1, role: "assistant", toolCalls, reasoning: "r" })],
      "/fallback",
    );
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ tool: "a", reasoning: "r" });
    expect(state.turns[1]).toMatchObject({ tool: "b" });
    expect((state.turns[1] as { reasoning?: string }).reasoning).toBeUndefined();
  });

  it("wraps malformed tool-call arguments in a _raw field", () => {
    const toolCalls = JSON.stringify([
      { function: { name: "x", arguments: "not-json" } },
    ]);
    const state = mapHermesSession(
      session(),
      [msg({ id: 1, role: "assistant", toolCalls })],
      "/fallback",
    );
    expect(state.turns[0]).toMatchObject({
      kind: "assistant_tool_call",
      tool: "x",
      args: { _raw: "not-json" },
    });
  });

  it("drops unknown roles", () => {
    const state = mapHermesSession(
      session(),
      [
        msg({ id: 1, role: "system", content: "you are..." }),
        msg({ id: 2, role: "user", content: "hi" }),
      ],
      "/fallback",
    );
    expect(state.turns.map((t) => t.kind)).toEqual(["user"]);
  });
});
