import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import { compactionBoundaryHash } from "../../session/session-compaction.js";
import type { SessionState } from "../../session/session-state.js";
import {
  CONVERSATION_HISTORY_TOOL,
  WINDOW_MAX_CHARS,
  buildConversationHistoryTool,
  type ConversationHistorySource,
} from "./conversation-history.js";

function makeCtx(sessionId = "current"): ToolContext {
  return { workingDir: "/w", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

const TURNS: ConversationTurn[] = [
  { kind: "user", text: "Check the invoice total for ACME", at: 1 },
  { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "invoice.csv" }, at: 2 },
  { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "total,4817.25 EUR", at: 3 },
  { kind: "assistant_reply", text: "The total is in the file.", at: 4 },
  { kind: "user", text: "Now draft the reply mail", at: 5 },
  { kind: "assistant_reply", text: "Drafted a reply about the ACME invoice.", at: 6 },
];

/** A session whose first `covered` records a compaction replaced. */
function sessionWith(turns: ConversationTurn[], covered: number | null): Pick<SessionState, "turns" | "compaction"> {
  if (covered === null) return { turns };
  return {
    turns,
    compaction: {
      version: 1,
      summary: "Checked an invoice.",
      coveredThrough: covered,
      boundaryHash: compactionBoundaryHash(turns[covered - 1]!),
      createdAt: 1,
      reason: "threshold",
      model: null,
      tokensBefore: 1000,
      tokensAfter: 100,
    },
  };
}

function sourceOf(sessions: Record<string, Pick<SessionState, "turns" | "compaction">>): ConversationHistorySource {
  return { load: (id) => sessions[id] ?? null };
}

// ATO-2261: the agent finds an exact detail its compaction summary dropped.
describe("conversation.history", () => {
  it("is a read-only tool with the catalog name", () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({}) });
    expect(tool.name).toBe(CONVERSATION_HISTORY_TOOL);
    expect(tool.name).toBe("conversation.history");
    expect(tool.readonly).toBe(true);
  });

  it("finds an exact number from tool output in the compacted part", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ query: "4817" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("#2 result os.fs.read (ok): total,4817.25 EUR");
    expect((result.details.hits as Array<{ index: number }>).map((h) => h.index)).toEqual([2]);
  });

  it("never searches records after the compaction boundary", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ query: "drafted" }, makeCtx());
    expect(result.details.count).toBe(0);
    expect(result.summary).not.toContain("Drafted a reply");
  });

  it("reads only the calling session, whatever the args say", async () => {
    const other = sessionWith([{ kind: "user", text: "secret 4817", at: 1 }, { kind: "assistant_reply", text: "ok", at: 2 }], 2);
    const tool = buildConversationHistoryTool({ source: sourceOf({ other, current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ query: "secret", sessionId: "other" }, makeCtx("current"));
    expect(result.details.count).toBe(0);
    expect(result.summary).not.toContain("secret 4817");
  });

  it("says there is nothing to look up before the first compaction", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, null) }) });
    const result = await tool.run({ query: "4817" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("nothing in this chat has been compacted yet");
    expect(result.summary).not.toContain("4817");
  });

  it("reads a range of compacted records and stops at the boundary", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ from: 1, count: 40 }, makeCtx());
    expect(result.summary).toContain('#1 call os.fs.read {"path":"invoice.csv"}');
    expect(result.summary).toContain("#3 agent: The total is in the file.");
    expect(result.summary).not.toContain("#4");
    expect(result.details).toMatchObject({ from: 1, to: 4, compacted: 4 });
  });

  it("refuses a read past the compacted part", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ from: 4 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("from");
  });

  it("keeps a read inside its character budget", async () => {
    const long: ConversationTurn[] = [];
    for (let i = 0; i < 20; i += 1) {
      long.push({ kind: "user", text: `q${i} ${"x".repeat(3000)}`, at: i * 2 });
      long.push({ kind: "assistant_reply", text: `a${i}`, at: i * 2 + 1 });
    }
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(long, 40) }) });
    const result = await tool.run({ from: 0, count: 40 }, makeCtx());
    const to = result.details.to as number;
    expect(to).toBeLessThan(40);
    expect(result.summary.length).toBeLessThan(WINDOW_MAX_CHARS + 1000);
    expect(result.summary).toContain(`{"from":${to}}`);
  });

  it("rejects an empty query", async () => {
    const tool = buildConversationHistoryTool({ source: sourceOf({ current: sessionWith(TURNS, 4) }) });
    const result = await tool.run({ query: "  " }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("query");
  });
});
