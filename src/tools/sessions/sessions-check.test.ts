import { describe, expect, it, vi } from "vitest";

import type { SessionChatLine } from "../../session/index.js";
import type { TaskRecord } from "../../tasks/index.js";
import type { ToolContext } from "../tool-registry.js";
import { frameCrossSessionMessage } from "./session-access.js";
import { buildSessionsCheckTool, replyTo } from "./sessions-check.js";

function ctx(sessionId = "s-me"): ToolContext {
  return { workingDir: "/work", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

const SENT = frameCrossSessionMessage("s-me", "what did we decide?");

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t-1",
    sessionId: "s-2",
    userMessage: SENT,
    status: "completed",
    origin: "agent",
    triggerSource: "agent",
    attempts: 1,
    maxAttempts: 2,
    maxSteps: null,
    lastError: null,
    lastErrorCategory: null,
    schedule: null,
    scheduledFor: null,
    recurring: false,
    lastScheduledAt: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    notify: null,
    maxCostUsd: null,
    maxDurationMs: null,
    spentUsd: null,
    elapsedMs: null,
    stopCause: null,
    ...overrides,
  };
}

function tool(record: TaskRecord | null, lines: SessionChatLine[] = []) {
  const listChatLines = vi.fn(() => lines);
  return {
    listChatLines,
    tool: buildSessionsCheckTool({
      taskStore: { get: () => record },
      sessionStore: { listChatLines },
    }),
  };
}

describe("sessions.check", () => {
  it("returns the other agent's reply to exactly this message", async () => {
    const { tool: check } = tool(task(), [
      { kind: "user", text: "older question" },
      { kind: "assistant_reply", text: "older answer" },
      { kind: "user", text: SENT },
      { kind: "assistant_reply", text: "we picked /v2/items" },
      { kind: "user", text: "the person later" },
      { kind: "assistant_reply", text: "later answer" },
    ]);
    const result = await check.run({ taskId: "t-1" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ answered: true, taskStatus: "completed" });
    expect(result.summary).toContain("we picked /v2/items");
    expect(result.summary).not.toContain("older answer");
    expect(result.summary).not.toContain("later answer");
    expect(check.untrustedOutput).toBe("another chat");
  });

  it("reports a queued, running or failed message without reading the chat", async () => {
    for (const [status, text] of [
      ["pending", "queued"],
      ["running", "working on"],
      ["failed", "boom"],
    ] as const) {
      const { tool: check, listChatLines } = tool(task({ status, lastError: "boom" }));
      const result = await check.run({ taskId: "t-1" }, ctx());
      expect(result.details.answered, status).toBe(false);
      expect(result.summary, status).toContain(text);
      expect(listChatLines).not.toHaveBeenCalled();
    }
  });

  it("only shows messages this chat sent", async () => {
    const { tool: check } = tool(task({ userMessage: frameCrossSessionMessage("s-other", "x") }));
    expect((await check.run({ taskId: "t-1" }, ctx())).status).toBe("error");
    const { tool: plain } = tool(task({ userMessage: "an ordinary task" }));
    expect((await plain.run({ taskId: "t-1" }, ctx())).status).toBe("error");
    const { tool: missing } = tool(null);
    expect((await missing.run({ taskId: "t-9" }, ctx())).status).toBe("error");
    expect((await missing.run({}, ctx())).status).toBe("error");
  });
});

describe("replyTo", () => {
  it("is null when the message is missing or the person spoke before any reply", () => {
    expect(replyTo([], SENT)).toBeNull();
    expect(
      replyTo(
        [
          { kind: "user", text: SENT },
          { kind: "user", text: "interrupting" },
          { kind: "assistant_reply", text: "answer to the interruption" },
        ],
        SENT,
      ),
    ).toBeNull();
  });
});
