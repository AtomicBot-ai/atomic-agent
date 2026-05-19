import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { ProcedureStore } from "../../memory/procedures/procedure-store.js";
import { buildProceduresRecallTool } from "./procedures-recall.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.procedures.recall", () => {
  let tmp: string;
  let store: ProcedureStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tool-procedures-"));
    store = new ProcedureStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'no procedure' marker for unknown id", async () => {
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ id: 9999 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.details.procedures).toEqual([]);
  });

  it("reads full steps body via { id } (the only path exposing steps[])", async () => {
    const created = store.create({
      activation: "extract function signatures from a TypeScript file",
      steps: [
        { description: "glob TS files", toolHint: "os.fs.glob" },
        { description: "grep export prefix", toolHint: "os.fs.grep" },
        { description: "reply with file:line list", toolHint: "reply" },
      ],
      tags: ["typescript", "code-search"],
      parentLessonIds: [10],
      parentMemoryIds: [1, 2, 3, 4],
    });
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ id: created.id }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(1);
    expect(result.summary).toContain("glob TS files");
    expect(result.summary).toContain("os.fs.grep");
    const arr = result.details.procedures as Array<{
      id: number;
      steps: Array<{ description: string }>;
    }>;
    expect(arr[0]?.id).toBe(created.id);
    expect(arr[0]?.steps.length).toBe(3);
  });

  it("returns deprecated procedures via { id }", async () => {
    const created = store.create({
      activation: "x",
      steps: [
        { description: "a", toolHint: null },
        { description: "b", toolHint: null },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    store.markDeprecated(created.id, "test");
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ id: created.id }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(1);
    expect(result.summary).toContain("(deprecated)");
  });

  it("BM25 query returns matching active rows", async () => {
    store.create({
      activation: "extract typescript signatures",
      steps: [
        { description: "glob TS files", toolHint: "os.fs.glob" },
        { description: "grep export", toolHint: "os.fs.grep" },
      ],
      parentLessonIds: [1],
      parentMemoryIds: [1],
    });
    store.create({
      activation: "summarise python module",
      steps: [
        { description: "read python file", toolHint: "os.fs.read" },
        { description: "summarise", toolHint: null },
      ],
      parentLessonIds: [2],
      parentMemoryIds: [2],
    });
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ query: "typescript", k: 5 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(1);
  });

  it("rejects empty query and missing id", async () => {
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ query: "" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("query");
  });

  it("rejects invalid id", async () => {
    const tool = buildProceduresRecallTool({ store });
    const result = await tool.run({ id: -1 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.field).toBe("id");
  });
});
