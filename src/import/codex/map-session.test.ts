import { describe, expect, it } from "vitest";

import { CODEX_SESSION_ID_PREFIX, mapCodexSession } from "./map-session.js";
import type { CodexSessionData } from "./codex-source.js";

const T0 = Date.parse("2026-08-02T10:00:00Z");

function session(partial: Partial<CodexSessionData>): CodexSessionData {
  return {
    id: "sess-1",
    cwd: "/work",
    startedAtMs: T0,
    messages: [],
    ...partial,
  };
}

describe("mapCodexSession", () => {
  it("maps the full user → reasoning → call → result → reply chain", () => {
    const mapped = mapCodexSession(
      session({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "list files" }], atMs: T0 },
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "an ls will do" }],
            atMs: T0 + 1,
          },
          {
            role: "assistant",
            blocks: [
              { type: "toolCall", id: "c1", name: "shell", args: { command: ["ls"] } },
            ],
            atMs: T0 + 2,
          },
          {
            role: "tool",
            blocks: [{ type: "toolResult", callId: "c1", text: "README.md" }],
            atMs: T0 + 3,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "just README.md" }],
            atMs: T0 + 4,
          },
        ],
      }),
      "/fallback",
    );

    expect(mapped.id).toBe(`${CODEX_SESSION_ID_PREFIX}sess-1`);
    expect(mapped.workingDir).toBe("/work");
    expect(mapped.createdAt).toBe(T0);
    expect(mapped.turns).toEqual([
      { kind: "user", text: "list files", at: T0 },
      {
        kind: "assistant_tool_call",
        tool: "shell",
        args: { command: ["ls"] },
        at: T0 + 2,
        // The reasoning row rode forward onto the call that followed it.
        reasoning: "an ls will do",
      },
      {
        kind: "tool_result",
        tool: "shell",
        status: "ok",
        summary: "README.md",
        at: T0 + 3,
      },
      { kind: "assistant_reply", text: "just README.md", at: T0 + 4 },
    ]);
    expect(mapped.turnCount).toBe(1);
    expect(mapped.metadata).toMatchObject({
      importedFrom: "codex",
      codexSessionId: "sess-1",
    });
  });

  it("attaches pending reasoning to a reply when no call intervenes", () => {
    const mapped = mapCodexSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "short answer" }],
            atMs: T0,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "42" }],
            atMs: T0 + 1,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toEqual([
      { kind: "assistant_reply", text: "42", at: T0 + 1, reasoning: "short answer" },
    ]);
  });

  it("falls back to the provided working dir", () => {
    expect(mapCodexSession(session({ cwd: null }), "/fb").workingDir).toBe("/fb");
  });
});
