import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { buildNotesForgetTool } from "./notes-forget.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.notes.forget", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-forget-tool-"));
    store = new MemoryStore({
      dbFile: join(tmp, "memory.sqlite"),
      maxEntries: 1000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes an existing entry by id", async () => {
    const entry = store.store({ content: "ephemeral" }, 1);
    const tool = buildNotesForgetTool({ store });
    const result = await tool.run({ id: entry.id }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.removed).toBe(true);
    expect(store.get(entry.id)).toBeNull();
  });

  it("reports removed=false for an unknown id (not an error)", async () => {
    const tool = buildNotesForgetTool({ store });
    const result = await tool.run({ id: 99999 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.removed).toBe(false);
  });

  it("surfaces validation error for non-numeric id", async () => {
    const tool = buildNotesForgetTool({ store });
    const result = await tool.run({ id: "abc" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("id");
  });
});
