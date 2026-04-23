import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";

import { traceCommand } from "./trace-command.js";

function writeTraceFixture(dir: string, sessionId: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: "session_started",
      seq: 0,
      sessionId,
      ts: 1000,
      workingDir: "/work",
    },
    { type: "turn_started", seq: 1, sessionId, ts: 1001, turnIndex: 0 },
    {
      type: "step_started",
      seq: 2,
      sessionId,
      ts: 1002,
      turnIndex: 0,
      stepIndex: 0,
    },
    {
      type: "prompt_captured",
      seq: 3,
      sessionId,
      ts: 1003,
      turnIndex: 0,
      stepIndex: 0,
      stablePrefixHash:
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      tail: "### conversation\nuser: hi\n",
      tokens: { total: 100, stablePrefix: 80, tail: 20 },
      slotId: 0,
      cacheReused: false,
    },
    {
      type: "llm_completion",
      seq: 4,
      sessionId,
      ts: 1004,
      turnIndex: 0,
      stepIndex: 0,
      attempt: 1,
      content: '{"tool":"reply","args":{"text":"hello"}}',
      cacheHitTokens: 80,
      modelId: "demo",
      stop: true,
      truncated: false,
    },
    {
      type: "tool_invocation",
      seq: 5,
      sessionId,
      ts: 1005,
      turnIndex: 0,
      stepIndex: 0,
      tool: "reply",
      args: { text: "hello" },
      status: "ok",
      summary: "hello",
    },
    {
      type: "step_finished",
      seq: 6,
      sessionId,
      ts: 1006,
      turnIndex: 0,
      stepIndex: 0,
      summary: "reply",
      durationMs: 4,
    },
    {
      type: "turn_finished",
      seq: 7,
      sessionId,
      ts: 1007,
      turnIndex: 0,
      reason: "reply",
      stepCount: 1,
      durationMs: 7,
    },
  ];
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, `${sessionId}.ndjson`), body, "utf8");
}

describe("traceCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-trace-cli-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeTraceFixture(join(stateDir, "traces"), "s-fixture");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("prints help when no subcommand is passed", async () => {
    const code = await traceCommand([]);
    expect(code).toBe(0);
    const written = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    expect(written).toMatch(/atomic-agent trace/);
  });

  it("lists available traces", async () => {
    const code = await traceCommand(["list"]);
    expect(code).toBe(0);
    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    expect(output).toContain("s-fixture");
    expect(output).toContain("/work");
  });

  it("shows a chronology with default (non-raw) truncation", async () => {
    const code = await traceCommand(["show", "s-fixture"]);
    expect(code).toBe(0);
    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    expect(output).toContain("session_started");
    expect(output).toContain("prompt_captured");
    expect(output).toContain("tool_invocation");
    expect(output).toContain("turn_finished");
    expect(output).toContain("prefixHash=aabbccddeeff");
    expect(output).not.toContain("### conversation");
  });

  it("includes raw tail and content when --raw is set", async () => {
    const code = await traceCommand(["show", "s-fixture", "--raw"]);
    expect(code).toBe(0);
    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    expect(output).toContain("### conversation");
    expect(output).toContain('{"tool":"reply"');
  });

  it("filters by --step", async () => {
    const code = await traceCommand(["show", "s-fixture", "--step", "0"]);
    expect(code).toBe(0);
    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    expect(output).toContain("step_started");
    expect(output).not.toContain("session_started");
    expect(output).not.toContain("turn_finished");
  });

  it("exports JSON format", async () => {
    const code = await traceCommand([
      "export",
      "s-fixture",
      "--format",
      "json",
    ]);
    expect(code).toBe(0);
    const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
      .calls.map((c) => c[0])
      .join("");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe("session_started");
    expect(parsed[parsed.length - 1].type).toBe("turn_finished");
  });

  it("fails gracefully for missing session", async () => {
    const code = await traceCommand(["show", "missing"]);
    expect(code).toBe(1);
    const err = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("");
    expect(err).toMatch(/no trace events/);
  });
});
