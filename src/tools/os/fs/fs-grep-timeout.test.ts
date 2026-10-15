import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullToolResult } from "../../../compressor/result-compressor.js";
import type {
  CommandOptions,
  CommandResult,
} from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import { DEFAULT_TIMEOUT_MS } from "./fs-grep-args.js";
import { OS_FS_GREP_CONTRACT } from "./fs-grep-contract.js";
import { describeGrepTimeout } from "./fs-grep-timeout.js";
import { buildOsFsGrepTool } from "./fs-grep.js";

// The runner is faked: a timeout is a result with `timedOut: true` and
// `exitCode: null`, which is what the real runner resolves with after it
// kills ripgrep. The search root still has to exist, because the tool
// stats it to pick the child's cwd.
let ROOT: string;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "fs-grep-timeout-test-"));
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    workingDir: ROOT,
    sessionId: "test",
    stepIndex: 0,
    signal: signal ?? new AbortController().signal,
  };
}

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "rg",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
    ...overrides,
  };
}

/** What ripgrep printed before it was killed: the runner's view of a timeout. */
function timedOut(stdout: string, durationMs = 30_040): CommandResult {
  return commandResult({
    stdout,
    exitCode: null,
    signal: "SIGKILL",
    durationMs,
    timedOut: true,
  });
}

function match(path: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  });
}

const TWO_FILES = [
  match("a.ts", 3, "const hit = 1;"),
  match("a.ts", 9, "const hit = 2;"),
  match("b.ts", 5, "const hit = 3;"),
].join("\n");

function toolReturning(result: CommandResult) {
  const calls: CommandOptions[] = [];
  const tool = buildOsFsGrepTool({
    resolveRgPath: () => "/fake/rg",
    runCommand: async (_cmd, _args, options) => {
      calls.push(options);
      return result;
    },
  });
  return { tool, calls };
}

describe("os.fs.grep when ripgrep times out", () => {
  it("returns the matches found so far with a leading note", async () => {
    // The final record is cut mid-line, as when the kill lands mid-write.
    const stdout = `${TWO_FILES}\n{"type":"match","data":{"path":{"te`;
    const { tool } = toolReturning(timedOut(stdout));
    const result = await tool.run({ pattern: "hit" }, makeCtx());

    expect(result.status).toBe("ok");
    expect(result.summary).not.toContain("exited with code");
    expect(result.summary.startsWith("[partial results")).toBe(true);
    expect(result.summary).toContain("30 s");
    expect(result.summary).toContain("time limit reached");
    expect(result.summary).toContain(
      "Narrow the pattern, the path or the glob and retry.",
    );
    expect(result.summary).toContain("3: const hit = 1;");
    expect(result.summary).toContain("9: const hit = 2;");
    expect(result.summary).toContain("5: const hit = 3;");
    expect(result.details.totals).toEqual({ files: 2, matches: 3 });
    expect(result.truncated).toBe(true);
    expect(result.details.truncated).toBe(true);
    expect(result.details.stoppedBy).toBe("time");
    expect(result.details.elapsedMs).toBe(30_040);
    expect(result.details.note).toBe(result.summary.split("\n")[0]);
    // The uncompressed copy handed to full-result consumers carries it too.
    const full = fullToolResult(result);
    expect(full.summary.startsWith("[partial results")).toBe(true);
    expect(full.truncated).toBe(true);
  });

  it("keeps the note in front of a result long enough to be compressed", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 2_000; i++) {
      lines.push(match(`dir/file-${i}.ts`, i, `const hit = ${i};`));
    }
    const { tool } = toolReturning(timedOut(lines.join("\n")));
    const result = await tool.run(
      { pattern: "hit", headLimit: 2_000 },
      makeCtx(),
    );
    expect(result.summary.startsWith("[partial results")).toBe(true);
    // Which matches survive compression is the compressor's business;
    // some must, after the note.
    expect(result.summary).toMatch(/\n.*\d+: const hit = \d+;/);
    expect(result.details.truncated).toBe(true);
    expect(fullToolResult(result).summary.startsWith("[partial results")).toBe(
      true,
    );
  });

  it("notes the stop in files_with_matches and count modes", async () => {
    for (const outputMode of ["files_with_matches", "count"] as const) {
      const { tool } = toolReturning(timedOut(TWO_FILES));
      const result = await tool.run({ pattern: "hit", outputMode }, makeCtx());
      expect(result.status).toBe("ok");
      expect(result.summary.startsWith("[partial results")).toBe(true);
      expect(result.summary).toContain(
        outputMode === "count" ? "a.ts:2" : "b.ts",
      );
      expect(result.details.truncated).toBe(true);
      expect(result.details.stoppedBy).toBe("time");
    }
  });

  it("reports a stop with nothing found as partial, not as an error", async () => {
    const { tool } = toolReturning(timedOut("", 5_000));
    const result = await tool.run({ pattern: "hit" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("partial results");
    expect(result.summary).toContain("5 s");
    expect(result.summary).toContain("(no matches)");
    expect(result.details.totals).toEqual({ files: 0, matches: 0 });
    expect(result.details.truncated).toBe(true);
  });

  it("hands the default and an explicit time limit to the runner", async () => {
    const first = toolReturning(commandResult({ stdout: TWO_FILES }));
    await first.tool.run({ pattern: "hit" }, makeCtx());
    expect(first.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);

    const second = toolReturning(commandResult({ stdout: TWO_FILES }));
    await second.tool.run({ pattern: "hit", timeoutMs: 1_500 }, makeCtx());
    expect(second.calls[0]?.timeoutMs).toBe(1_500);
  });
});

describe("os.fs.grep within its time limit", () => {
  it("keeps the old result shape", async () => {
    const { tool } = toolReturning(commandResult({ stdout: TWO_FILES }));
    const result = await tool.run({ pattern: "hit" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).not.toContain("partial results");
    expect(result.summary.startsWith("a.ts:")).toBe(true);
    expect(result.details.truncated).toBe(false);
    expect(result.details).not.toHaveProperty("stoppedBy");
    expect(result.details).not.toHaveProperty("elapsedMs");
    expect(result.details).not.toHaveProperty("note");
  });

  it("still reports other ripgrep failures as errors", async () => {
    const { tool } = toolReturning(
      commandResult({ exitCode: 2, stderr: "rg: some failure" }),
    );
    const result = await tool.run({ pattern: "hit" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).not.toContain("partial results");
  });
});

describe("os.fs.grep cancellation", () => {
  it("rejects when cancelled while ripgrep runs", async () => {
    const controller = new AbortController();
    // The real runner kills ripgrep on abort and resolves, not rejects,
    // with what it captured and `timedOut: false`.
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => {
        controller.abort();
        return commandResult({
          stdout: TWO_FILES,
          exitCode: null,
          signal: "SIGKILL",
        });
      },
    });
    await expect(
      tool.run({ pattern: "hit" }, makeCtx(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects rather than returning partial results when both happen", async () => {
    const controller = new AbortController();
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => {
        controller.abort();
        return timedOut(TWO_FILES);
      },
    });
    await expect(
      tool.run({ pattern: "hit" }, makeCtx(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("os.fs.grep with an already cancelled signal", () => {
  it("rejects without starting ripgrep", async () => {
    const controller = new AbortController();
    controller.abort();
    const { tool, calls } = toolReturning(commandResult({ stdout: TWO_FILES }));
    await expect(
      tool.run({ pattern: "hit" }, makeCtx(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("describeGrepTimeout", () => {
  it("rounds the elapsed time to a tenth of a second", () => {
    expect(describeGrepTimeout({ elapsedMs: 1_249 })).toContain(
      "stopped after 1.2 s",
    );
  });
});

describe("DEFAULT_TIMEOUT_MS", () => {
  it("matches the number the grep contract quotes to the model", () => {
    const seconds = `default ${DEFAULT_TIMEOUT_MS / 1_000} s`;
    expect(OS_FS_GREP_CONTRACT.description).toContain(seconds);
    expect(OS_FS_GREP_CONTRACT.descriptor.summary).toContain(seconds);
  });
});
