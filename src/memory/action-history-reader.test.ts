import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listTraceFiles,
  readToolInvocationsFromFile,
} from "./action-history-reader.js";

describe("action-history reader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-hist-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when the traces dir does not exist", () => {
    const missing = join(tmp, "does-not-exist");
    expect(listTraceFiles(missing)).toEqual([]);
  });

  it("ignores non-ndjson files and sidecar artefacts", () => {
    const tracesDir = join(tmp, "traces");
    mkdirSync(tracesDir);
    writeFileSync(join(tracesDir, "s-1.ndjson"), "");
    writeFileSync(join(tracesDir, "README.md"), "hi");
    writeFileSync(join(tracesDir, "s-2.ndjson.bak"), "");
    const files = listTraceFiles(tracesDir);
    expect(files.map((f) => f.sessionId)).toEqual(["s-1"]);
  });

  it("parses tool_invocation events and skips other event types", () => {
    const path = join(tmp, "s.ndjson");
    const lines = [
      { type: "session_started", seq: 0, sessionId: "s", ts: 1, workingDir: "/w" },
      {
        type: "tool_invocation",
        seq: 1,
        sessionId: "s",
        ts: 10,
        turnIndex: 0,
        stepIndex: 0,
        tool: "os.fs.read",
        args: { path: "a.txt" },
        status: "ok",
        summary: "read 120 bytes",
      },
      {
        type: "tool_invocation",
        seq: 2,
        sessionId: "s",
        ts: 20,
        turnIndex: 0,
        stepIndex: 1,
        tool: "browser.navigate",
        args: { url: "https://example.com" },
        status: "ok",
        summary: "loaded example.com",
      },
      { type: "turn_finished", seq: 3, sessionId: "s", ts: 21, turnIndex: 0, reason: "reply", stepCount: 2, durationMs: 50 },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const invocations = readToolInvocationsFromFile(path);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.tool).toBe("os.fs.read");
    expect(invocations[1]?.tool).toBe("browser.navigate");
  });

  it("tolerates malformed lines gracefully", () => {
    const path = join(tmp, "garbage.ndjson");
    writeFileSync(
      path,
      [
        "not json",
        JSON.stringify({
          type: "tool_invocation",
          seq: 0,
          sessionId: "s",
          ts: 1,
          turnIndex: 0,
          stepIndex: 0,
          tool: "reply",
          args: { text: "hi" },
          status: "ok",
          summary: "reply",
        }),
        "",
        "{broken",
      ].join("\n"),
    );
    const invocations = readToolInvocationsFromFile(path);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.tool).toBe("reply");
  });
});
