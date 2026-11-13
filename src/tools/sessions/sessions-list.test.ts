import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../../session/index.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSessionsListTool } from "./sessions-list.js";

function ctx(sessionId = "s-me"): ToolContext {
  return { workingDir: "/work", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

function row(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workingDir: "/work",
    status: "completed",
    createdAt: 0,
    updatedAt: Date.UTC(2026, 10, 12, 9, 30),
    turnCount: 1,
    stepCount: 1,
    firstPrompt: `prompt of ${id}`,
    title: null,
    importedFrom: null,
    ...overrides,
  };
}

describe("sessions.list", () => {
  it("lists chats newest first with names only and marks this chat", async () => {
    const listSummaryPage = vi.fn(() => [
      row("s-me", { title: "This one" }),
      row("s-2", { title: "API naming" }),
    ]);
    const tool = buildSessionsListTool({ sessionStore: { listSummaryPage } });
    const result = await tool.run({}, ctx());
    expect(result.status).toBe("ok");
    expect(listSummaryPage).toHaveBeenCalledWith({ limit: 20 });
    expect(result.summary).toContain("s-me · completed · 2026-11-12 09:30 · This one (this chat)");
    expect(result.summary).toContain("s-2 · completed · 2026-11-12 09:30 · API naming");
    expect(result.details.count).toBe(2);
    expect(tool.readonly).toBe(true);
  });

  it("caps the limit at 50", async () => {
    const listSummaryPage = vi.fn(() => []);
    const tool = buildSessionsListTool({ sessionStore: { listSummaryPage } });
    const result = await tool.run({ limit: 999 }, ctx());
    expect(listSummaryPage).toHaveBeenCalledWith({ limit: 50 });
    expect(result.summary).toContain("(no chats)");
  });

  it("filters by name across pages with a cursor", async () => {
    const first = Array.from({ length: 100 }, (_, i) => row(`s-a${i}`, { updatedAt: 1000 - i }));
    const second = [row("s-hit", { title: "Release Notes draft", updatedAt: 1 })];
    const listSummaryPage = vi
      .fn<(options: { limit: number; after?: { updatedAt: number; id: string } }) => SessionSummary[]>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const tool = buildSessionsListTool({ sessionStore: { listSummaryPage } });
    const result = await tool.run({ query: "release notes" }, ctx());
    expect(listSummaryPage).toHaveBeenNthCalledWith(2, {
      limit: 100,
      after: { updatedAt: 901, id: "s-a99" },
    });
    expect(result.details.count).toBe(1);
    expect(result.summary).toContain("s-hit");
  });
});
