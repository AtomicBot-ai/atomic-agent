import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { LessonStore } from "../../memory/lessons/lesson-store.js";
import { buildLessonsRecallTool } from "./lessons-recall.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("memory.lessons.recall", () => {
  let tmp: string;
  let store: LessonStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tool-lessons-"));
    store = new LessonStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a 'no lesson' marker for an unknown id", async () => {
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ id: 9999 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.details.lessons).toEqual([]);
  });

  it("reads the full principle body via { id } (gating the only path)", async () => {
    const lesson = store.create({
      activation: "When asked about pnpm packages",
      principle:
        "Always use pnpm install over npm install for this repo. The lockfile lives in pnpm-lock.yaml.",
      tags: ["tool"],
      parentIds: [1, 2, 3],
    });
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ id: lesson.id }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(1);
    expect(result.summary).toContain("pnpm install over npm install");
    const arr = result.details.lessons as Array<{ id: number; principle: string }>;
    expect(arr[0]?.id).toBe(lesson.id);
    expect(arr[0]?.principle).toContain("pnpm");
  });

  it("returns deprecated lessons via { id } (cross-phase invariant 9)", async () => {
    const lesson = store.create({
      activation: "a",
      principle: "p",
      parentIds: [1],
    });
    store.markDeprecated(lesson.id);
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ id: lesson.id }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(1);
    const arr = result.details.lessons as Array<{ status: string }>;
    expect(arr[0]?.status).toBe("deprecated");
    expect(result.summary).toContain("(deprecated)");
  });

  it("BM25 { query } ranks the relevant lesson first", async () => {
    store.create({
      activation: "When asked about pnpm packages",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    store.create({
      activation: "When debugging flaky Playwright tests",
      principle: "Run with `headless: false`.",
      parentIds: [2],
    });
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ query: "pnpm", k: 2 }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBeGreaterThanOrEqual(1);
    const first = (result.details.lessons as Array<{ activation: string }>)[0];
    expect(first?.activation.toLowerCase()).toContain("pnpm");
  });

  it("returns 'no active lessons matched' when BM25 finds nothing", async () => {
    store.create({
      activation: "When asked about pnpm packages",
      principle: "Use pnpm install.",
      parentIds: [1],
    });
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ query: "kubernetes" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
  });

  it("rejects calls missing both id and query", async () => {
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("query");
  });

  it("rejects invalid ids with a validation error envelope", async () => {
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ id: -1 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("id");
  });

  it("clamps `k` to the hard maximum", async () => {
    for (let i = 0; i < 12; i += 1) {
      store.create({
        activation: `pnpm rule ${i}`,
        principle: `Use pnpm install (variant ${i}).`,
        parentIds: [i + 1],
      });
    }
    const tool = buildLessonsRecallTool({ store });
    const result = await tool.run({ query: "pnpm", k: 999 }, makeCtx());
    expect(result.status).toBe("ok");
    // LESSON_RECALL_MAX_K = 10.
    expect(result.details.count).toBeLessThanOrEqual(10);
  });
});
