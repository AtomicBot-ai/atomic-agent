import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { buildNotesStoreTool } from "./notes-store.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.notes.store", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-store-tool-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists a note and tags it with the runtime context", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run(
      { content: "remember this", tags: ["example"] },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.stored).toBe(true);
    const saved = store.get(result.details.id as number);
    expect(saved?.content).toBe("remember this");
    expect(saved?.workingDir).toBe("/work");
    expect(saved?.sessionId).toBe("s1");
    expect(saved?.source).toBe("agent");
    expect(saved?.tags).toEqual(["example"]);
  });

  it("returns an error tool-result for empty content", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run({ content: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("content");
  });

  it("rejects content over the per-call cap without persisting", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 10 });
    const result = await tool.run(
      { content: "x".repeat(50) },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("content");
    expect(store.count()).toBe(0);
  });

  it("surfaces tag validation errors as tool-result errors", async () => {
    const tool = buildNotesStoreTool({ store, maxContentChars: 4_000 });
    const result = await tool.run(
      { content: "ok", tags: [""] },
      makeCtx(),
    );
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("tags");
  });
});
