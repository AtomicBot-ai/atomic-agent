import { describe, it, expect } from "vitest";
import type {
  CommandOptions,
  CommandResult,
} from "../../sandbox/command-runner.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsFsGrepTool, parseRipgrepJson } from "./fs-grep.js";

// A platform-native absolute root: the grep runner is mocked in these tests
// so the path is never touched on disk, but it must be a valid absolute path
// for the host so `resolveUserPath` does not reject a Unix path on Windows.
const FIXTURE_ROOT =
  process.platform === "win32" ? "C:\\tmp\\fixture" : "/tmp/fixture";

function makeCtx(): ToolContext {
  return {
    workingDir: FIXTURE_ROOT,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeCommandResult(
  overrides: Partial<CommandResult>,
): CommandResult {
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
    ...overrides,
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function beginFile(path: string): unknown {
  return { type: "begin", data: { path: { text: path } } };
}

function matchLine(
  path: string,
  lineNumber: number,
  text: string,
  submatches: Array<{ start: number; end: number; text: string }> = [],
): unknown {
  return {
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: submatches.map((s) => ({
        match: { text: s.text },
        start: s.start,
        end: s.end,
      })),
    },
  };
}

function contextLine(path: string, lineNumber: number, text: string): unknown {
  return {
    type: "context",
    data: {
      path: { text: path },
      lines: { text },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [],
    },
  };
}

function endFile(path: string): unknown {
  return {
    type: "end",
    data: { path: { text: path }, binary_offset: null, stats: {} },
  };
}

describe("parseRipgrepJson", () => {
  it("groups matches and context by file", () => {
    const stdout = jsonl([
      beginFile("a.ts"),
      matchLine("a.ts", 1, "hello world\n", [
        { start: 0, end: 5, text: "hello" },
      ]),
      contextLine("a.ts", 2, "next line\n"),
      endFile("a.ts"),
      { type: "summary", data: {} },
    ]);
    const parsed = parseRipgrepJson(stdout);
    expect(parsed).toHaveLength(1);
    const file = parsed[0];
    expect(file.path).toBe("a.ts");
    expect(file.matchCount).toBe(1);
    expect(file.matches).toHaveLength(2);
    expect(file.matches[0]).toMatchObject({
      lineNumber: 1,
      text: "hello world",
      isContext: false,
    });
    expect(file.matches[1]).toMatchObject({
      lineNumber: 2,
      text: "next line",
      isContext: true,
    });
  });

  it("skips malformed NDJSON lines", () => {
    const stdout = "not json\n" + jsonl([matchLine("a.ts", 1, "hit\n")]);
    const parsed = parseRipgrepJson(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].matchCount).toBe(1);
  });
});

describe("os.fs.grep", () => {
  it("returns structured error when ripgrep is missing", async () => {
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => null,
      runCommand: async () => makeCommandResult({}),
    });
    const result = await tool.run({ pattern: "foo" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.missing).toBe(true);
    expect(result.summary).toContain("ripgrep");
  });

  it("formats content mode with line-number markers", async () => {
    const stdout = jsonl([
      beginFile("a.ts"),
      matchLine("a.ts", 10, "const x = 1;\n"),
      endFile("a.ts"),
      beginFile("b.ts"),
      matchLine("b.ts", 3, "const y = 2;\n"),
      matchLine("b.ts", 7, "const z = 3;\n"),
      endFile("b.ts"),
    ]);
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => makeCommandResult({ stdout }),
    });
    const result = await tool.run({ pattern: "const" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("a.ts:");
    expect(result.summary).toContain("10: const x = 1;");
    expect(result.summary).toContain("b.ts:");
    expect(result.summary).toContain("3: const y = 2;");
    expect(result.details.totals).toEqual({ files: 2, matches: 3 });
  });

  it("respects headLimit across matches in content mode", async () => {
    const stdout = jsonl([
      beginFile("a.ts"),
      matchLine("a.ts", 1, "hit1\n"),
      matchLine("a.ts", 2, "hit2\n"),
      matchLine("a.ts", 3, "hit3\n"),
      endFile("a.ts"),
    ]);
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => makeCommandResult({ stdout }),
    });
    const result = await tool.run(
      { pattern: "hit", headLimit: 2 },
      makeCtx(),
    );
    expect(result.details.truncated).toBe(true);
    expect(result.summary).toContain("1: hit1");
    expect(result.summary).toContain("2: hit2");
    expect(result.summary).not.toContain("3: hit3");
  });

  it("supports files_with_matches mode", async () => {
    const stdout = jsonl([
      beginFile("x.ts"),
      matchLine("x.ts", 1, "hit\n"),
      endFile("x.ts"),
      beginFile("y.ts"),
      matchLine("y.ts", 1, "hit\n"),
      endFile("y.ts"),
    ]);
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => makeCommandResult({ stdout }),
    });
    const result = await tool.run(
      { pattern: "hit", outputMode: "files_with_matches" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("x.ts\ny.ts");
    expect(result.details.files).toEqual(["x.ts", "y.ts"]);
  });

  it("supports count mode", async () => {
    const stdout = jsonl([
      beginFile("a.ts"),
      matchLine("a.ts", 1, "hit\n"),
      matchLine("a.ts", 2, "hit\n"),
      endFile("a.ts"),
      beginFile("b.ts"),
      matchLine("b.ts", 9, "hit\n"),
      endFile("b.ts"),
    ]);
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => makeCommandResult({ stdout }),
    });
    const result = await tool.run(
      { pattern: "hit", outputMode: "count" },
      makeCtx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("a.ts:2\nb.ts:1");
    expect(result.details.counts).toEqual([
      { path: "a.ts", count: 2 },
      { path: "b.ts", count: 1 },
    ]);
  });

  it("reports exit code 1 as empty match set, not an error", async () => {
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () => makeCommandResult({ exitCode: 1 }),
    });
    const result = await tool.run({ pattern: "nothing" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("(no matches)");
    expect(result.details.totals).toEqual({ files: 0, matches: 0 });
  });

  it("reports non-zero exit codes other than 1 as errors", async () => {
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async () =>
        makeCommandResult({ exitCode: 2, stderr: "bad regex: foo" }),
    });
    const result = await tool.run({ pattern: "(" }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("bad regex");
  });

  it("passes -i, -U, --glob, --type, -A, -B to ripgrep", async () => {
    let capturedArgs: string[] = [];
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async (_cmd, args, _opts: CommandOptions) => {
        capturedArgs = args;
        return makeCommandResult({ stdout: "" });
      },
    });
    await tool.run(
      {
        pattern: "foo",
        caseInsensitive: true,
        multiline: true,
        glob: ["*.ts", "!test/**"],
        type: "js",
        contextBefore: 2,
        contextAfter: 3,
      },
      makeCtx(),
    );
    expect(capturedArgs).toContain("-i");
    expect(capturedArgs).toContain("-U");
    expect(capturedArgs).toContain("--multiline-dotall");
    expect(capturedArgs).toContain("--glob");
    expect(capturedArgs).toContain("*.ts");
    expect(capturedArgs).toContain("!test/**");
    expect(capturedArgs).toContain("--type");
    expect(capturedArgs).toContain("js");
    expect(capturedArgs).toContain("-B");
    expect(capturedArgs).toContain("2");
    expect(capturedArgs).toContain("-A");
    expect(capturedArgs).toContain("3");
    expect(capturedArgs[capturedArgs.length - 1]).toBe(".");
    expect(capturedArgs[capturedArgs.length - 2]).toBe("foo");
  });

  it("applies contextAround to both sides when contextBefore/After not set", async () => {
    let capturedArgs: string[] = [];
    const tool = buildOsFsGrepTool({
      resolveRgPath: () => "/fake/rg",
      runCommand: async (_cmd, args) => {
        capturedArgs = args;
        return makeCommandResult({ stdout: "" });
      },
    });
    await tool.run(
      { pattern: "foo", contextAround: 2 },
      makeCtx(),
    );
    const before = capturedArgs.indexOf("-B");
    const after = capturedArgs.indexOf("-A");
    expect(before).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(-1);
    expect(capturedArgs[before + 1]).toBe("2");
    expect(capturedArgs[after + 1]).toBe("2");
  });
});
