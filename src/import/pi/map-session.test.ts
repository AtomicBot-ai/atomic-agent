import { describe, expect, it } from "vitest";

import { mapPiSession, PI_SESSION_ID_PREFIX } from "./map-session.js";
import type { PiSessionData } from "./pi-session-format.js";

const T0 = Date.parse("2026-08-02T10:00:00Z");

function session(partial: Partial<PiSessionData>): PiSessionData {
  return { id: "sess-1", cwd: "/work", title: null, messages: [], ...partial };
}

describe("mapPiSession", () => {
  it("maps user, assistant and toolResult rows onto the turn kinds", () => {
    const mapped = mapPiSession(
      session({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "hi" }], atMs: T0 },
          {
            role: "assistant",
            blocks: [
              { type: "thinking", thinking: "plan" },
              { type: "text", text: "on it" },
              { type: "toolCall", id: "tc-1", name: "bash", args: { c: 1 } },
            ],
            atMs: T0 + 1,
          },
          {
            role: "toolResult",
            blocks: [
              {
                type: "toolResult",
                toolCallId: "tc-1",
                toolName: "bash",
                text: "ok",
                isError: false,
              },
            ],
            atMs: T0 + 2,
          },
        ],
      }),
      "/fallback",
    );

    expect(mapped.id).toBe(`${PI_SESSION_ID_PREFIX}sess-1`);
    expect(mapped.workingDir).toBe("/work");
    expect(mapped.turns).toEqual([
      { kind: "user", text: "hi", at: T0 },
      {
        kind: "assistant_reply",
        text: "on it",
        reasoning: "plan",
        at: T0 + 1,
      },
      {
        kind: "assistant_tool_call",
        tool: "bash",
        args: { c: 1 },
        at: T0 + 1,
      },
      {
        kind: "tool_result",
        tool: "bash",
        status: "ok",
        summary: "ok",
        at: T0 + 2,
      },
    ]);
    expect(mapped.metadata).toEqual({
      importedFrom: "pi",
      piSessionId: "sess-1",
    });
    expect(mapped.turnCount).toBe(1);
  });

  it("names a result through the call-id map when toolName is missing", () => {
    const mapped = mapPiSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "toolCall", id: "tc-9", name: "web", args: {} }],
            atMs: T0,
          },
          {
            role: "toolResult",
            blocks: [
              {
                type: "toolResult",
                toolCallId: "tc-9",
                toolName: null,
                text: "hit",
                isError: true,
              },
            ],
            atMs: T0 + 1,
          },
          {
            role: "toolResult",
            blocks: [
              {
                type: "toolResult",
                toolCallId: null,
                toolName: null,
                text: "orphan",
                isError: false,
              },
            ],
            atMs: T0 + 2,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toMatchObject([
      { kind: "assistant_tool_call", tool: "web" },
      { kind: "tool_result", tool: "web", status: "error" },
      { kind: "tool_result", tool: "unknown", status: "ok" },
    ]);
  });

  it("surfaces an interrupted thought before the user message that cut it off", () => {
    const mapped = mapPiSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "half a plan" }],
            atMs: T0,
          },
          { role: "user", blocks: [{ type: "text", text: "stop" }], atMs: T0 + 1 },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toEqual([
      { kind: "assistant_reply", text: "", reasoning: "half a plan", at: T0 },
      { kind: "user", text: "stop", at: T0 + 1 },
    ]);
  });

  it("keeps the session title in metadata", () => {
    const mapped = mapPiSession(session({ title: "Renamed" }), "/fallback");
    expect(mapped.metadata).toEqual({
      importedFrom: "pi",
      piSessionId: "sess-1",
      title: "Renamed",
    });
  });

  it("carries a thinking-only row into the next assistant row", () => {
    const mapped = mapPiSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "first" }],
            atMs: T0,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "done" }],
            atMs: T0 + 1,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toEqual([
      { kind: "assistant_reply", text: "done", reasoning: "first", at: T0 + 1 },
    ]);
  });

  it("surfaces trailing held reasoning as a reasoning-only reply", () => {
    const mapped = mapPiSession(
      session({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "thinking", thinking: "cut off" }],
            atMs: T0,
          },
        ],
      }),
      "/fallback",
    );
    expect(mapped.turns).toEqual([
      { kind: "assistant_reply", text: "", reasoning: "cut off", at: T0 },
    ]);
  });

  it("falls back to the provided working dir when the header had no cwd", () => {
    const mapped = mapPiSession(session({ cwd: null }), "/fallback");
    expect(mapped.workingDir).toBe("/fallback");
    expect(mapped.status).toBe("completed");
  });
});
