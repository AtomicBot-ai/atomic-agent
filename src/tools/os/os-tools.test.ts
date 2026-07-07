import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { osFsReadTool } from "./fs-read.js";
import { osFsListTool } from "./fs-list.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { buildOsShellTool, needsShellInterpretation } from "./shell.js";
import { buildOsFsTrashTool } from "./fs-trash.js";
import { runCommand } from "../../sandbox/command-runner.js";
import { registerOsTools } from "./index.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs tools", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-os-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("os.fs.read returns file contents", async () => {
    await writeFile(join(dir, "hello.txt"), "привет, магос", "utf8");
    const result = await osFsReadTool.run({ path: "hello.txt" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("привет, магос");
  });

  it("os.fs.read supports offset and limit for line-range reads", async () => {
    await writeFile(
      join(dir, "multiline.txt"),
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      "utf8",
    );
    const result = await osFsReadTool.run(
      { path: "multiline.txt", offset: 2, limit: 2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("beta\ngamma");
    expect(result.details.startLine).toBe(2);
    expect(result.details.endLine).toBe(3);
    expect(result.details.totalLines).toBe(5);
    expect(result.details.returnedLines).toBe(2);
  });

  it("os.fs.read prefixes LINE_NUMBER| when lineNumbers=true", async () => {
    await writeFile(join(dir, "three.txt"), "one\ntwo\nthree\n", "utf8");
    const result = await osFsReadTool.run(
      { path: "three.txt", lineNumbers: true, offset: 2, limit: 2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe(`${"2".padStart(6, " ")}|two\n${"3".padStart(6, " ")}|three`);
  });

  it("os.fs.read treats negative offset as counting from the end", async () => {
    await writeFile(
      join(dir, "tail.txt"),
      "l1\nl2\nl3\nl4\nl5\n",
      "utf8",
    );
    const result = await osFsReadTool.run(
      { path: "tail.txt", offset: -2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("l4\nl5");
    expect(result.details.startLine).toBe(4);
    expect(result.details.endLine).toBe(5);
  });

  it("os.fs.read keeps byte-mode behaviour unchanged when no range specified", async () => {
    await writeFile(join(dir, "plain.txt"), "one\ntwo\n", "utf8");
    const result = await osFsReadTool.run({ path: "plain.txt" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.totalLines).toBeUndefined();
    expect(result.summary).toContain("one");
    expect(result.summary).toContain("two");
  });

  it("os.fs.list enumerates directory entries", async () => {
    await writeFile(join(dir, "a.txt"), "a", "utf8");
    await mkdir(join(dir, "sub"));
    const result = await osFsListTool.run({ path: "." }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("a.txt");
    expect(result.summary).toContain("sub");
  });

  it("os.fs.write refuses to run without approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => {
        gate.reject(req.approvalId, "denied by test");
      },
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run(
        { path: "out.txt", content: "hello" },
        makeCtx(dir),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("os.fs.write writes after approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { path: "out.txt", content: "hello" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    const written = await readFile(join(dir, "out.txt"), "utf8");
    expect(written).toBe("hello");
  });
});

describe("needsShellInterpretation", () => {
  it("routes shell metacharacters to a subshell", () => {
    expect(needsShellInterpretation("a | b", [])).toBe(true);
    expect(needsShellInterpretation("a && b", [])).toBe(true);
    expect(needsShellInterpretation("a; b", [])).toBe(true);
    expect(needsShellInterpretation("echo $HOME", [])).toBe(true);
    expect(needsShellInterpretation("cat > out.txt", [])).toBe(true);
  });

  it("routes a pre-joined command line (whitespace, no args) to a subshell", () => {
    expect(needsShellInterpretation("ffprobe -v quiet f.mp3", [])).toBe(true);
  });

  it("keeps the argv path for a structured call", () => {
    expect(needsShellInterpretation("ffprobe", ["-v", "quiet", "f.mp3"])).toBe(
      false,
    );
    expect(needsShellInterpretation("ls", ["-la"])).toBe(false);
  });

  it("does not treat a bare argv glob as needing a subshell", () => {
    // `*`/`?` are handled by expandShellGlobArgs on the argv path.
    expect(needsShellInterpretation("rm", ["-f", "*.png"])).toBe(false);
    expect(needsShellInterpretation("ls", ["*.png"])).toBe(false);
  });
});

describe("os.shell.run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires approval for commands that are not guard-allowed", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "no"),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run({ cmd: "node", args: ["-e", "process.stdout.write('hi')"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("skips approval for guard-allowed commands", async () => {
    let approvals = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        approvals += 1;
        gate.reject(req.approvalId, "should not ask");
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "echo", args: ["hi"] }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hi");
    expect(result.details.guardVerdict).toBe("allow");
    expect(approvals).toBe(0);
  });

  it("executes echo and captures stdout when approved", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "node", args: ["-e", "process.stdout.write('hi')"] },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hi");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.guardVerdict).toBe("approval_required");
  });

  it("blocks hardline commands without approval or execution", async () => {
    let approvals = 0;
    const gate = new ApprovalGate({
      emit: (req) => {
        approvals += 1;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "rm", args: ["-rf", "/"] }, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("blocked by shell guard");
    expect(result.details.guardVerdict).toBe("block");
    expect(result.details.guardRule).toBe("hardline.rm_root");
    expect(approvals).toBe(0);
  });

  it("recovers a JSON-stringified array `args` (cloud native_tools double-serialise bug)", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "echo", args: "[\"hello\",\"world\"]" },
      makeCtx(dir),
    );
    // The string is shaped like a JSON array — coerced back to
    // ["hello","world"] so the call proceeds normally instead of
    // silently dropping args.
    expect(result.details.rawArgs).toEqual(["hello", "world"]);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hello world");
  });

  it("returns a structured error when `args` is an object", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "should not ask"),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "echo", args: { unexpected: "object" } },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("`args` must be an array of strings");
    expect(result.details.rawArgsType).toBe("object");
  });

  it("returns a structured error when `args` is a scalar string", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "should not ask"),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "echo", args: "hello world" },
      makeCtx(dir),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("`args` must be an array of strings");
    expect(result.details.rawArgsType).toBe("string");
  });

  it("treats missing `args` as empty array (back-compat)", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "should not ask"),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "echo" }, makeCtx(dir));
    expect(result.details.rawArgs).toEqual([]);
  });

  it.skipIf(
    process.platform === "win32",
    "expands *.png for rm and removes matched files",
    async () => {
      await writeFile(join(dir, "x.png"), "1", "utf8");
      await writeFile(join(dir, "y.png"), "2", "utf8");
      const gate = new ApprovalGate({
        emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
      });
      const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
      const result = await tool.run(
        { cmd: "rm", args: ["-f", "*.png"] },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      expect(existsSync(join(dir, "x.png"))).toBe(false);
      expect(existsSync(join(dir, "y.png"))).toBe(false);
    },
  );

  it("runs a piped command line via a subshell", async () => {
    if (process.platform === "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "printf 'a\\nb\\na\\n' | sort | uniq | wc -l" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    // 2 distinct lines (a, b) -> uniq -> wc -l == 2.
    expect(result.summary.replace(/\s+/g, " ")).toContain("2");
  });

  it("expands an env var via a subshell", async () => {
    if (process.platform === "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: 'echo "$HOME"' }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    expect(result.summary).toContain(process.env.HOME ?? "");
  });

  it("treats a pre-joined command line in `cmd` as a subshell command", async () => {
    if (process.platform === "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "echo hello world" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    expect(result.summary).toContain("hello world");
  });

  it("runs a piped command line via a cmd.exe subshell (win32)", async () => {
    if (process.platform !== "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "echo hello| findstr hello" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    expect(result.summary).toContain("hello");
  });

  it("expands a %VAR% via a cmd.exe subshell (win32)", async () => {
    if (process.platform !== "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "echo %USERPROFILE%" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    expect(result.summary).toContain(process.env.USERPROFILE ?? "");
  });

  it("chains commands with && via a cmd.exe subshell (win32)", async () => {
    if (process.platform !== "win32") return;
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "echo a && echo b" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(true);
    expect(result.summary).toContain("a");
    expect(result.summary).toContain("b");
  });

  it("keeps the direct argv path for a structured command", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    // Use a real executable (not a cmd.exe builtin) so the direct-exec
    // argv path is exercised on Windows too — `echo` is a builtin there
    // and is deliberately routed through the subshell.
    const result = await tool.run(
      { cmd: "node", args: ["-e", "process.stdout.write('hi')"] },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.details.shell).toBe(false);
    expect(result.summary).toContain("hi");
  });

  it("still blocks a catastrophic command line routed through the subshell", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "rm -rf / --no-preserve-root" }, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("blocked by shell guard");
  });
});

describe("os.fs.trash", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-trash-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires approval", async () => {
    await writeFile(join(dir, "t.txt"), "x", "utf8");
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "no"),
    });
    const tool = buildOsFsTrashTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run({ paths: ["t.txt"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("returns error when path is missing", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsFsTrashTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ paths: ["nope.txt"] }, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("not found");
  });

  it("moves a file via gio trash on Linux when available", async () => {
    if (process.platform !== "linux") return;
    const which = await runCommand("sh", ["-c", "command -v gio"], {
      cwd: "/",
      timeoutMs: 5000,
    });
    if (which.exitCode !== 0) return;

    const target = join(dir, "trash-me.txt");
    await writeFile(target, "bye", "utf8");
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsFsTrashTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ paths: ["trash-me.txt"] }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(existsSync(target)).toBe(false);
  });
});

describe("registerOsTools", () => {
  it("registers the full OS tool surface", () => {
    const registry = new ToolRegistry();
    const gate = new ApprovalGate({ emit: () => undefined });
    registerOsTools(registry, {
      approvals: gate,
      approvalRequired: false,
      config: {
        http: {
          enabled: true,
          approvalMode: "writes",
          hostAllowlist: null,
          maxResponseBytes: 1_048_576,
          defaultTimeoutMs: 30_000,
        },
        web: {
          search: {
            enabled: true,
            provider: "duckduckgo",
            maxResults: 8,
            timeoutMs: 15_000,
            cacheTtlMinutes: 15,
            fallback: [],
            searxng: { instanceUrl: null },
            exa: {
              endpoint: "https://mcp.exa.ai/mcp",
              apiEndpoint: "https://api.exa.ai/search",
              apiKeyEnv: "EXA_API_KEY",
            },
            brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
          },
        },
      },
    });
    const names = registry.list().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "os.clipboard.read",
        "os.clipboard.write",
        "os.fs.archive.extract",
        "os.fs.archive.list",
        "os.fs.archive.read_entry",
        "os.fs.diff",
        "os.fs.edit",
        "os.fs.glob",
        "os.fs.grep",
        "os.fs.hash",
        "os.fs.list",
        "os.fs.patch",
        "os.fs.read",
        "os.fs.read_document",
        "os.fs.trash",
        "os.fs.watch",
        "os.fs.write",
        "os.git.blame",
        "os.git.branch",
        "os.git.diff",
        "os.git.log",
        "os.git.show",
        "os.git.status",
        "os.http.request",
        "os.notify",
        "os.proc.kill",
        "os.proc.list",
        "os.shell.run",
        "os.web.search",
        "os.web.fetch",
        "os.window.focus",
        "os.window.list",
      ].sort(),
    );
  });
});
