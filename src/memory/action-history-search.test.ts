import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchActionHistory } from "./action-history-search.js";

interface Invocation {
  ts: number;
  turnIndex: number;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  summary: string;
}

function writeTraceFile(
  dir: string,
  sessionId: string,
  mtime: number,
  invocations: Invocation[],
): string {
  const path = join(dir, `${sessionId}.ndjson`);
  const lines = invocations.map((inv, idx) =>
    JSON.stringify({
      type: "tool_invocation",
      seq: idx + 1,
      sessionId,
      ts: inv.ts,
      turnIndex: inv.turnIndex,
      stepIndex: inv.stepIndex,
      tool: inv.tool,
      args: inv.args,
      status: inv.status,
      summary: inv.summary,
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

describe("searchActionHistory", () => {
  let tmp: string;
  let tracesDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-hist-"));
    tracesDir = join(tmp, "traces");
    mkdirSync(tracesDir);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty result with a note when the dir is empty", () => {
    const result = searchActionHistory({
      tracesDir,
      filters: {},
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    expect(result.note).toBeDefined();
  });

  it("returns invocations newest-first by ts", () => {
    writeTraceFile(tracesDir, "s-old", 1_000, [
      {
        ts: 100,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: { path: "a" },
        status: "ok",
        summary: "old read",
      },
    ]);
    writeTraceFile(tracesDir, "s-new", 2_000, [
      {
        ts: 200,
        turnIndex: 0,
        stepIndex: 0,
        tool: "browser.navigate",
        args: { url: "x" },
        status: "ok",
        summary: "new nav",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: {},
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches.map((m) => m.tool)).toEqual([
      "browser.navigate",
      "os.fs.read",
    ]);
  });

  it("filters by exact tool name", () => {
    writeTraceFile(tracesDir, "s", 1_000, [
      {
        ts: 1,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: {},
        status: "ok",
        summary: "",
      },
      {
        ts: 2,
        turnIndex: 0,
        stepIndex: 1,
        tool: "browser.navigate",
        args: {},
        status: "ok",
        summary: "",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: { tool: "os.fs.read" },
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches.map((m) => m.tool)).toEqual(["os.fs.read"]);
  });

  it("matches a case-insensitive substring across tool, args, summary", () => {
    writeTraceFile(tracesDir, "s", 1_000, [
      {
        ts: 1,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: { path: "/Users/a/Documents/budget.xlsx" },
        status: "ok",
        summary: "read file",
      },
      {
        ts: 2,
        turnIndex: 0,
        stepIndex: 1,
        tool: "reply",
        args: { text: "done" },
        status: "ok",
        summary: "answered user",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: { pattern: "BUDGET" },
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.tool).toBe("os.fs.read");
  });

  it("honours since/until ranges", () => {
    writeTraceFile(tracesDir, "s", 1_000, [
      {
        ts: 100,
        turnIndex: 0,
        stepIndex: 0,
        tool: "a",
        args: {},
        status: "ok",
        summary: "",
      },
      {
        ts: 200,
        turnIndex: 0,
        stepIndex: 1,
        tool: "b",
        args: {},
        status: "ok",
        summary: "",
      },
      {
        ts: 300,
        turnIndex: 0,
        stepIndex: 2,
        tool: "c",
        args: {},
        status: "ok",
        summary: "",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: { since: 150, until: 250 },
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches.map((m) => m.tool)).toEqual(["b"]);
  });

  it("caps results at limit and reports truncated=true", () => {
    writeTraceFile(
      tracesDir,
      "s",
      1_000,
      Array.from({ length: 30 }).map((_, idx) => ({
        ts: 1_000 + idx,
        turnIndex: 0,
        stepIndex: idx,
        tool: "x",
        args: {},
        status: "ok" as const,
        summary: "",
      })),
    );
    const result = searchActionHistory({
      tracesDir,
      filters: { limit: 5 },
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("clamps limit to maxResults", () => {
    writeTraceFile(
      tracesDir,
      "s",
      1_000,
      Array.from({ length: 30 }).map((_, idx) => ({
        ts: 1_000 + idx,
        turnIndex: 0,
        stepIndex: idx,
        tool: "x",
        args: {},
        status: "ok" as const,
        summary: "",
      })),
    );
    const result = searchActionHistory({
      tracesDir,
      filters: { limit: 100 },
      maxResults: 10,
      tracingEnabled: true,
    });
    expect(result.matches).toHaveLength(10);
  });

  it("marks note when tracing is disabled but historical data exists", () => {
    writeTraceFile(tracesDir, "s", 1_000, [
      {
        ts: 1,
        turnIndex: 0,
        stepIndex: 0,
        tool: "x",
        args: {},
        status: "ok",
        summary: "",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: {},
      maxResults: 10,
      tracingEnabled: false,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.note).toContain("tracing is disabled");
  });

  it("narrows to a single session when sessionId is provided", () => {
    writeTraceFile(tracesDir, "s-a", 1_000, [
      {
        ts: 1,
        turnIndex: 0,
        stepIndex: 0,
        tool: "a-tool",
        args: {},
        status: "ok",
        summary: "",
      },
    ]);
    writeTraceFile(tracesDir, "s-b", 2_000, [
      {
        ts: 2,
        turnIndex: 0,
        stepIndex: 0,
        tool: "b-tool",
        args: {},
        status: "ok",
        summary: "",
      },
    ]);
    const result = searchActionHistory({
      tracesDir,
      filters: { sessionId: "s-a" },
      maxResults: 50,
      tracingEnabled: true,
    });
    expect(result.matches.map((m) => m.tool)).toEqual(["a-tool"]);
  });
});
