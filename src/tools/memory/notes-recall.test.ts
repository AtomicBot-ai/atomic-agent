import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { buildNotesRecallTool } from "./notes-recall.js";

function makeCtx(workingDir = "/work"): ToolContext {
  return {
    workingDir,
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.notes.recall", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-recall-tool-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ranked matches and exposes them in details", async () => {
    store.store({ content: "the cat sat on the mat" }, 1);
    store.store({ content: "unrelated trivia" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "cat" }, makeCtx());
    expect(result.status).toBe("ok");
    const entries = result.details.entries as Array<{ content: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.content).toMatch(/cat/);
  });

  it("defaults scope to 'all' (cross-project)", async () => {
    store.store({ content: "alpha from a", workingDir: "/repos/a" }, 1);
    store.store({ content: "alpha from b", workingDir: "/repos/b" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "alpha" }, makeCtx("/repos/a"));
    expect(result.details.scope).toBe("all");
    expect(result.details.count).toBe(2);
  });

  it("scope='project' uses the ctx workingDir", async () => {
    store.store({ content: "alpha from a", workingDir: "/repos/a" }, 1);
    store.store({ content: "alpha from b", workingDir: "/repos/b" }, 2);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run(
      { query: "alpha", scope: "project" },
      makeCtx("/repos/a"),
    );
    const entries = result.details.entries as Array<{ workingDir: string }>;
    expect(entries.map((e) => e.workingDir)).toEqual(["/repos/a"]);
  });

  it("empty query yields an ok tool-result with zero entries", async () => {
    store.store({ content: "something" }, 1);
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: "" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
  });

  it("returns validation error for non-string query", async () => {
    const tool = buildNotesRecallTool({ store, defaultK: 5 });
    const result = await tool.run({ query: 42 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("query");
  });
});
