import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { buildHistorySearchTool } from "./history-search.js";

function makeCtx(): ToolContext {
  return {
    workingDir: "/work",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function writeTrace(dir: string, sessionId: string, events: unknown[]) {
  const path = join(dir, `${sessionId}.ndjson`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("memory.history.search tool", () => {
  let tmp: string;
  let tracesDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-hist-tool-"));
    tracesDir = join(tmp, "traces");
    mkdirSync(tracesDir);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an ok result with a note when traces dir is empty", async () => {
    const tool = buildHistorySearchTool({
      tracesDir,
      maxResults: 50,
      tracingEnabled: true,
    });
    const result = await tool.run({}, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(0);
    expect(result.details.note).toBeDefined();
  });

  it("filters by tool and pattern", async () => {
    writeTrace(tracesDir, "s", [
      {
        type: "tool_invocation",
        seq: 1,
        sessionId: "s",
        ts: 100,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: { path: "/a/budget.xlsx" },
        status: "ok",
        summary: "read 4KB",
      },
      {
        type: "tool_invocation",
        seq: 2,
        sessionId: "s",
        ts: 200,
        turnIndex: 0,
        stepIndex: 1,
        tool: "browser.navigate",
        args: { url: "https://x.com" },
        status: "ok",
        summary: "loaded x.com",
      },
    ]);
    const tool = buildHistorySearchTool({
      tracesDir,
      maxResults: 50,
      tracingEnabled: true,
    });
    const byTool = await tool.run({ tool: "os.fs.read" }, makeCtx());
    expect(byTool.details.count).toBe(1);
    const byPattern = await tool.run({ pattern: "budget" }, makeCtx());
    expect(byPattern.details.count).toBe(1);
  });

  it("respects limit clamped by maxResults", async () => {
    writeTrace(
      tracesDir,
      "s",
      Array.from({ length: 20 }).map((_, idx) => ({
        type: "tool_invocation",
        seq: idx + 1,
        sessionId: "s",
        ts: idx,
        turnIndex: 0,
        stepIndex: idx,
        tool: "x",
        args: {},
        status: "ok",
        summary: "",
      })),
    );
    const tool = buildHistorySearchTool({
      tracesDir,
      maxResults: 5,
      tracingEnabled: true,
    });
    const result = await tool.run({ limit: 100 }, makeCtx());
    expect(result.details.count).toBe(5);
  });

  it("formats matches with ISO timestamps in the summary", async () => {
    writeTrace(tracesDir, "s", [
      {
        type: "tool_invocation",
        seq: 1,
        sessionId: "s",
        ts: 1_700_000_000_000,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: {},
        status: "ok",
        summary: "read ok",
      },
    ]);
    const tool = buildHistorySearchTool({
      tracesDir,
      maxResults: 50,
      tracingEnabled: true,
    });
    const result = await tool.run({}, makeCtx());
    expect(result.summary).toContain("os.fs.read");
    expect(result.summary).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
