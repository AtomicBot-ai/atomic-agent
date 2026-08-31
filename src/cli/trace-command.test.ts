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
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
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

  it("replay rebuilds the skill catalog with the configured token budget", async () => {
    // Regression guard for the replay call-site wiring: `handleReplay`
    // must pass `config.skills.catalogTokenBudget` to
    // `buildSkillCatalog`. The skill catalog feeds the stable prefix, so
    // an honored budget changes the recomputed hash; if replay silently
    // fell back to the legacy 4096-char cap, both runs below would build
    // the same two-entry catalog and print identical currentHash values.
    const globalSkillsDir = join(stateDir, "skills");
    for (const name of ["replay-budget-a", "replay-budget-b"]) {
      mkdirSync(join(globalSkillsDir, name), { recursive: true });
      writeFileSync(
        join(globalSkillsDir, name, "SKILL.md"),
        [
          "---",
          `name: ${name}`,
          `description: "${"d".repeat(100)}"`,
          "version: 0.1.0",
          "---",
          "",
          `# ${name}`,
        ].join("\n"),
        "utf8",
      );
    }

    const currentHashFromReplay = async (): Promise<string> => {
      (process.stdout.write as ReturnType<typeof vi.fn>).mockClear();
      const code = await traceCommand(["replay", "s-fixture"]);
      // The fixture's recorded hash can never match a live prefix, so
      // replay always reports drift (exit code 2).
      expect(code).toBe(2);
      const output = (process.stdout.write as ReturnType<typeof vi.fn>).mock
        .calls.map((c) => c[0])
        .join("");
      const row = output
        .split("\n")
        .find((line) => line.includes("DRIFT"));
      expect(row).toBeDefined();
      const columns = (row as string).trim().split(/\s+/);
      const currentHash = columns[columns.length - 1] as string;
      expect(currentHash).toMatch(/^[0-9a-f]{16}$/);
      return currentHash;
    };

    // Default budget: both catalog entries fit under the 4096-char cap.
    const wideHash = await currentHashFromReplay();

    // 4 tokens x 8 chars/token = 32 chars: the catalog is cut down to
    // the single always-kept first entry, which must shift the prefix.
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "4";
    resetConfigCache();
    const narrowHash = await currentHashFromReplay();
    expect(narrowHash).not.toBe(wideHash);
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
