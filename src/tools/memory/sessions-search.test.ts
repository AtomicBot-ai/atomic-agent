import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { SessionStore } from "../../session/session-store.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import { SessionSearchUnavailableError } from "../../session/session-search.js";
import {
  READ_LINE_MAX_CHARS,
  SESSIONS_SEARCH_TOOL,
  buildSessionsSearchTool,
} from "./sessions-search.js";

function makeCtx(sessionId = "current", workingDir = "/w"): ToolContext {
  return {
    workingDir,
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

// ATO-1151: the agent searches its past chats, then reads around a hit.
describe("memory.sessions.search", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tool-sessions-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function save(id: string, texts: string[], workingDir = "/w"): void {
    const turns: ConversationTurn[] = texts.map((text, i) => ({
      kind: i % 2 === 0 ? ("user" as const) : ("assistant_reply" as const),
      text,
      at: i + 1,
    }));
    store.save({ ...createEmptySessionState({ id, workingDir }), turns });
  }

  it("finds past chats by words and leaves the current session out", async () => {
    save("past", ["we picked Hetzner for hosting", "Noted: Hetzner, the CX22 plan."]);
    save("current", ["where do we host? Hetzner?"]);
    const tool = buildSessionsSearchTool({ source: store });
    expect(tool.name).toBe(SESSIONS_SEARCH_TOOL);
    expect(tool.readonly).toBe(true);
    const result = await tool.run({ query: "hetzner" }, makeCtx());
    expect(result.status).toBe("ok");
    const hits = result.details.hits as Array<{ sessionId: string; line: number }>;
    expect(hits.map((h) => h.sessionId)).toEqual(["past", "past"]);
    expect(result.summary).toContain("sessionId=past");
    expect(result.summary).toContain('{"sessionId":"<id>","line":<n>}');
  });

  it("scopes to the current folder with scope: project", async () => {
    save("here", ["redis cache"], "/w");
    save("elsewhere", ["redis cache"], "/x");
    const tool = buildSessionsSearchTool({ source: store });
    const all = await tool.run({ query: "redis" }, makeCtx());
    expect((all.details.hits as Array<{ sessionId: string }>).map((h) => h.sessionId).sort()).toEqual([
      "elsewhere",
      "here",
    ]);
    const project = await tool.run({ query: "redis", scope: "project" }, makeCtx());
    expect((project.details.hits as Array<{ sessionId: string }>).map((h) => h.sessionId)).toEqual(["here"]);
  });

  it("says so when nothing matched", async () => {
    const tool = buildSessionsSearchTool({ source: store });
    const result = await tool.run({ query: "nothing here" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.summary).toContain("no past chat matched");
  });

  it("reads the lines around a hit, each cut to a bounded length", async () => {
    const texts = Array.from({ length: 30 }, (_, i) => (i === 15 ? "x".repeat(5000) : `line ${i}`));
    save("long", texts);
    const tool = buildSessionsSearchTool({ source: store });
    const result = await tool.run({ sessionId: "long", line: 15, radius: 2 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ sessionId: "long", from: 13, to: 18, total: 30 });
    expect(result.summary).toContain("#13 ");
    expect(result.summary).toContain("#17 ");
    expect(result.summary).not.toContain("#18 ");
    expect(result.summary).not.toContain("x".repeat(READ_LINE_MAX_CHARS + 1));
  });

  it("reads from the start without a line, and reports an unknown session", async () => {
    save("short", ["hello", "hi there"]);
    const tool = buildSessionsSearchTool({ source: store });
    const start = await tool.run({ sessionId: "short" }, makeCtx());
    expect(start.summary).toContain("#0 user: hello");
    expect(start.summary).toContain("#1 agent: hi there");
    const unknown = await tool.run({ sessionId: "nope" }, makeCtx());
    expect(unknown.status).toBe("ok");
    expect(unknown.summary).toContain("no chat lines in session nope");
  });

  it("refuses bad arguments as validation errors", async () => {
    const tool = buildSessionsSearchTool({ source: store });
    for (const args of [
      {},
      { query: "  " },
      { query: "a".repeat(501) },
      { query: "x", scope: "everywhere" },
      { query: "x", limit: 0 },
      { sessionId: "" },
      { sessionId: "s", line: -1 },
      { sessionId: "s", radius: "many" },
    ]) {
      const result = await tool.run(args, makeCtx());
      expect(result.status, JSON.stringify(args)).toBe("error");
      expect(result.summary, JSON.stringify(args)).toContain("validation:");
    }
  });

  it("reports an index it cannot create as an error, not a throw", async () => {
    const tool = buildSessionsSearchTool({
      source: {
        searchTranscripts: () => {
          throw new SessionSearchUnavailableError("read-only file");
        },
        listChatLines: () => [],
      },
    });
    const result = await tool.run({ query: "x" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("session search is unavailable");
  });
});
