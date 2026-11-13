import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../../../sandbox/command-runner.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import { parseAstGrepJson } from "./ast-grep-json.js";
import { AST_GREP_MISSING_HINT, npmNativeCandidates, resolveAstGrepPath } from "./ast-grep-resolver.js";
import {
  buildAstGrepArgs,
  neutralAstGrepConfig,
  parseAstGrepQuery,
  type AstGrepDependencies,
} from "./ast-grep-run.js";
import { buildOsCodeRewriteTool, planRewrite } from "./code-rewrite.js";
import { buildOsCodeSearchTool } from "./code-search.js";

function ctxFor(workingDir: string): ToolContext {
  return { workingDir, sessionId: "code-test", stepIndex: 0, signal: new AbortController().signal };
}

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({ emit: (req) => gate.reject(req.approvalId, "denied") });
  return gate;
}

/** One ast-grep JSON match for `needle` (the n-th occurrence) in `content`. */
function matchJson(
  file: string,
  content: string,
  needle: string,
  replacement?: string,
  occurrence = 0,
): Record<string, unknown> {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = content.indexOf(needle, index + 1);
  if (index < 0) throw new Error(`fixture: ${needle} not in content`);
  const before = content.slice(0, index);
  const line = before.split("\n").length - 1;
  const column = index - (before.lastIndexOf("\n") + 1);
  const byteStart = Buffer.byteLength(before, "utf8");
  const byteEnd = byteStart + Buffer.byteLength(needle, "utf8");
  const endBefore = content.slice(0, index + needle.length);
  const out: Record<string, unknown> = {
    text: needle,
    range: {
      byteOffset: { start: byteStart, end: byteEnd },
      start: { line, column },
      end: { line: endBefore.split("\n").length - 1, column: 0 },
    },
    file,
    lines: content.split("\n")[line],
    language: "TypeScript",
  };
  if (replacement !== undefined) {
    out.replacement = replacement;
    out.replacementOffsets = { start: byteStart, end: byteEnd };
  }
  return out;
}

function commandResult(partial: Partial<CommandResult>): CommandResult {
  return {
    command: "ast-grep",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    inputTruncated: false,
    ...partial,
  };
}

const NEUTRAL = "/tmp/atomic-ast-grep-test/sgconfig.yml";

function fakeDeps(
  respond: (args: string[]) => Partial<CommandResult>,
  calls: string[][] = [],
  cwds: string[] = [],
): Partial<AstGrepDependencies> {
  return {
    resolveAstGrepPath: () => "/usr/local/bin/ast-grep",
    neutralConfig: async () => NEUTRAL,
    runCommand: async (_cmd, args, options) => {
      calls.push(args);
      cwds.push(options.cwd);
      return commandResult(respond(args));
    },
  };
}

const stream = (items: unknown[]): string => items.map((i) => JSON.stringify(i)).join("\n");

describe("resolveAstGrepPath", () => {
  it("prefers the override, then ast-grep on PATH, and never the sg alias", () => {
    const exists = (set: string[]) => (p: string) => set.includes(p);
    expect(
      resolveAstGrepPath({
        env: { ATOMIC_AGENT_AST_GREP_PATH: "/opt/ag", PATH: "/usr/bin" },
        platform: "darwin",
        fileExists: exists(["/opt/ag", "/usr/bin/ast-grep"]),
      }),
    ).toBe("/opt/ag");
    expect(
      resolveAstGrepPath({
        env: { PATH: "/a:/b" },
        platform: "linux",
        fileExists: exists(["/b/ast-grep"]),
      }),
    ).toBe("/b/ast-grep");
    expect(
      resolveAstGrepPath({ env: { PATH: "/a" }, platform: "linux", fileExists: exists(["/a/sg"]) }),
    ).toBeNull();
    expect(
      resolveAstGrepPath({
        env: { Path: "C:\\tools;C:\\scoop" },
        platform: "win32",
        fileExists: exists([join("C:\\scoop", "ast-grep.exe")]),
      }),
    ).toBe(join("C:\\scoop", "ast-grep.exe"));
    expect(resolveAstGrepPath({ env: {}, platform: "linux", fileExists: () => true })).toBeNull();
  });
});

describe("resolveAstGrepPath on Windows with npm's .cmd shim", () => {
  const shimDir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const exists = (set: string[]) => (p: string) => set.includes(p);

  it("never returns the .cmd shim: spawning it without a shell fails with EINVAL", () => {
    expect(
      resolveAstGrepPath({
        env: { Path: shimDir },
        platform: "win32",
        fileExists: exists([join(shimDir, "ast-grep.cmd"), join(shimDir, "ast-grep")]),
      }),
    ).toBeNull();
  });

  it("follows the shim to the native exe npm installed beside it", () => {
    const nested = join(
      shimDir, "node_modules", "@ast-grep", "cli", "node_modules", "@ast-grep", "cli-win32-x64-msvc", "ast-grep.exe",
    );
    const resolved = resolveAstGrepPath({
      env: { Path: shimDir },
      platform: "win32",
      fileExists: exists([join(shimDir, "ast-grep.cmd"), nested]),
    });
    expect(resolved).toBe(nested);
    expect(resolved!.endsWith(".exe")).toBe(true);
    const hoisted = join(shimDir, "node_modules", "@ast-grep", "cli-win32-arm64-msvc", "ast-grep.exe");
    expect(
      resolveAstGrepPath({
        env: { Path: shimDir },
        platform: "win32",
        fileExists: exists([join(shimDir, "ast-grep.cmd"), hoisted]),
      }),
    ).toBe(hoisted);
  });

  it("keeps looking down PATH past a shim with no native binary", () => {
    const later = join("C:\\tools", "ast-grep.exe");
    expect(
      resolveAstGrepPath({
        env: { Path: `${shimDir};C:\\tools` },
        platform: "win32",
        fileExists: exists([join(shimDir, "ast-grep.cmd"), later]),
      }),
    ).toBe(later);
    expect(npmNativeCandidates(shimDir).every((c) => c.endsWith("ast-grep.exe"))).toBe(true);
  });
});

describe("ast-grep arguments and output", () => {
  it("validates the query and builds the argv with an absolute target", () => {
    const query = parseAstGrepQuery(
      { pattern: "foo($A)", rewrite: "", lang: "ts", globs: ["src/**", " "], timeoutMs: 999_999 },
      "t",
      true,
    );
    expect(query).toEqual({ pattern: "foo($A)", rewrite: "", lang: "ts", globs: ["src/**"], timeoutMs: 300_000 });
    expect(buildAstGrepArgs(query, "/repo", NEUTRAL)).toEqual([
      "run", "--config", NEUTRAL, "--pattern", "foo($A)", "--rewrite", "", "--lang", "ts", "--globs", "src/**", "--json=stream", "--", "/repo",
    ]);
    expect(() => parseAstGrepQuery({ pattern: " " }, "t", false)).toThrow("t: `pattern` must be a non-empty string");
    expect(() => parseAstGrepQuery({ pattern: "a" }, "t", true)).toThrow("`rewrite` must be a string");
    expect(() => parseAstGrepQuery({ pattern: "a", globs: [1] }, "t", false)).toThrow("`globs` must be an array");
    expect(() => parseAstGrepQuery({ pattern: "a", timeoutMs: 0 }, "t", false)).toThrow("`timeoutMs`");
  });

  it("reads stream, compact and pretty JSON, skipping junk and cut lines", () => {
    const m = matchJson("/r/a.ts", "x\nfoo(1)\n", "foo(1)", "bar(1)");
    expect(parseAstGrepJson(stream([m, { not: "a match" }]) + "\n{\"text\":\"cut")).toHaveLength(1);
    expect(parseAstGrepJson(JSON.stringify([m, m]))).toHaveLength(2);
    expect(parseAstGrepJson(JSON.stringify([m], null, 2))).toHaveLength(1);
    const [parsed] = parseAstGrepJson(stream([m]));
    expect(parsed).toMatchObject({
      file: "/r/a.ts", line: 2, column: 1, text: "foo(1)", byteStart: 2, byteEnd: 8,
      replacement: "bar(1)", replaceStart: 2, replaceEnd: 8,
    });
    expect(parseAstGrepJson("")).toEqual([]);
  });
});

describe("os.code.search", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-code-search-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("explains how to install ast-grep when it is missing", async () => {
    const tool = buildOsCodeSearchTool({ resolveAstGrepPath: () => null });
    const result = await tool.run({ pattern: "foo()" }, ctxFor(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain(AST_GREP_MISSING_HINT);
    expect(result.details.missing).toBe(true);
  });

  it("lists matches relative to the working directory", async () => {
    const file = join(dir, "a.ts");
    const content = "// foo(1) in a comment\nfoo(2);\nfoo(3);\n";
    await writeFile(file, content);
    const calls: string[][] = [];
    const cwds: string[] = [];
    const tool = buildOsCodeSearchTool(
      fakeDeps(() => ({ stdout: stream([matchJson(file, content, "foo(2)"), matchJson(file, content, "foo(3)")]) }), calls, cwds),
    );
    const result = await tool.run({ pattern: "foo($A)", lang: "typescript" }, ctxFor(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("2 matches in 1 file");
    expect(result.summary).toContain("a.ts:2:1: foo(2);");
    expect(result.details.totals).toEqual({ files: 1, matches: 2 });
    expect(calls[0]).toEqual([
      "run", "--config", NEUTRAL, "--pattern", "foo($A)", "--lang", "typescript", "--json=stream", "--", dir,
    ]);
    // Never the project: ast-grep looks for sgconfig.yml from its cwd up.
    expect(cwds).toEqual([dirname(NEUTRAL)]);
  });

  it("caps the listed matches at maxResults", async () => {
    const file = join(dir, "a.ts");
    const content = "f();\nf();\nf();\n";
    await writeFile(file, content);
    const tool = buildOsCodeSearchTool(
      fakeDeps(() => ({ stdout: stream([0, 1, 2].map((n) => matchJson(file, content, "f()", undefined, n))) })),
    );
    const result = await tool.run({ pattern: "f()", maxResults: 2 }, ctxFor(dir));
    expect(result.summary).toContain("3 matches in 1 file (first 2 shown");
    expect(result.details.truncated).toBe(true);
  });

  it("reports no matches on exit 1 and ast-grep's own error otherwise", async () => {
    const none = buildOsCodeSearchTool(fakeDeps(() => ({ exitCode: 1 })));
    expect((await none.run({ pattern: "x" }, ctxFor(dir))).summary).toContain("(no matches)");
    const bad = buildOsCodeSearchTool(fakeDeps(() => ({ exitCode: 2, stderr: "Error: Cannot parse query as a valid pattern." })));
    const result = await bad.run({ pattern: "x(" }, ctxFor(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("ast-grep: Error: Cannot parse query");
  });

  it("refuses a path that does not exist without running ast-grep", async () => {
    const calls: string[][] = [];
    const tool = buildOsCodeSearchTool(fakeDeps(() => ({}), calls));
    const result = await tool.run({ pattern: "x", path: "nope" }, ctxFor(dir));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("path not found: nope");
    expect(calls).toEqual([]);
  });
});

describe("os.code.rewrite", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-code-rewrite-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ a: string; b: string; aText: string; bText: string; stdout: string }> {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    // A non-ASCII character before the match: offsets are bytes, not chars.
    const aText = "const s = \"ünïcode\";\noldName(1);\n// oldName(2) stays\n";
    const bText = "oldName(x, y);\n";
    await writeFile(a, aText);
    await writeFile(b, bText);
    const stdout = stream([
      matchJson(a, aText, "oldName(1)", "newName(1)"),
      matchJson(b, bText, "oldName(x, y)", "newName(x, y)"),
    ]);
    return { a, b, aText, bText, stdout };
  }

  it("dry-runs by default: shows the diff and writes nothing", async () => {
    const { a, aText, stdout } = await seed();
    const calls: string[][] = [];
    const tool = buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, fakeDeps(() => ({ stdout }), calls));
    const result = await tool.run({ pattern: "oldName($$$A)", rewrite: "newName($$$A)" }, ctxFor(dir));
    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("dry-run");
    expect(result.summary).toContain("-oldName(1);");
    expect(result.summary).toContain("+newName(1);");
    expect(await readFile(a, "utf8")).toBe(aText);
    expect(calls[0]).toContain("--rewrite");
  });

  it("writes every file after one approval", async () => {
    const { a, b, stdout } = await seed();
    const tool = buildOsCodeRewriteTool({ approvals: approveAll(), approvalRequired: true }, fakeDeps(() => ({ stdout })));
    const result = await tool.run({ pattern: "oldName($$$A)", rewrite: "newName($$$A)", apply: true }, ctxFor(dir));
    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("applied");
    expect(await readFile(a, "utf8")).toBe("const s = \"ünïcode\";\nnewName(1);\n// oldName(2) stays\n");
    expect(await readFile(b, "utf8")).toBe("newName(x, y);\n");
  });

  it("writes nothing when the approval is declined", async () => {
    const { a, aText, stdout } = await seed();
    const tool = buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, fakeDeps(() => ({ stdout })));
    await expect(
      tool.run({ pattern: "oldName($$$A)", rewrite: "newName($$$A)", apply: true }, ctxFor(dir)),
    ).rejects.toThrow(/The user declined/);
    expect(await readFile(a, "utf8")).toBe(aText);
  });

  it("refuses the whole rewrite when one file changed after ast-grep read it", async () => {
    const { a, b, bText, stdout } = await seed();
    await writeFile(a, "something else entirely\n");
    const tool = buildOsCodeRewriteTool({ approvals: approveAll(), approvalRequired: true }, fakeDeps(() => ({ stdout })));
    const result = await tool.run({ pattern: "oldName($$$A)", rewrite: "newName($$$A)", apply: true }, ctxFor(dir));
    expect(result.status).toBe("error");
    expect(result.details.mode).toBe("apply-refused");
    expect(result.summary).toMatch(/a\.ts .*the file changed after ast-grep read it/);
    expect(await readFile(b, "utf8")).toBe(bText);
    expect(await readFile(a, "utf8")).toBe("something else entirely\n");
  });

  it("refuses a timed-out or cut-off run instead of rewriting part of it", async () => {
    const { a, aText, stdout } = await seed();
    for (const partial of [{ timedOut: true, exitCode: null }, { truncated: true }]) {
      const tool = buildOsCodeRewriteTool({ approvals: approveAll(), approvalRequired: true }, fakeDeps(() => ({ stdout, ...partial })));
      const result = await tool.run({ pattern: "oldName($$$A)", rewrite: "newName($$$A)", apply: true }, ctxFor(dir));
      expect(result.status).toBe("error");
      expect(result.summary).toContain("nothing was changed");
    }
    expect(await readFile(a, "utf8")).toBe(aText);
  });

  it("refuses a masked secret marker before asking", async () => {
    const env = join(dir, "config.ts");
    const text = "const key = readKey();\n";
    await writeFile(env, text);
    const stdout = stream([matchJson(env, text, "readKey()", "\"[redacted:api_key]\"")]);
    const tool = buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, fakeDeps(() => ({ stdout })));
    await expect(
      tool.run({ pattern: "readKey()", rewrite: "\"[redacted:api_key]\"", apply: true }, ctxFor(dir)),
    ).rejects.toThrow(/masked secret/);
    expect(await readFile(env, "utf8")).toBe(text);
  });

  it("says so when ast-grep is missing or nothing matches", async () => {
    const missing = buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, { resolveAstGrepPath: () => null });
    expect((await missing.run({ pattern: "a", rewrite: "b" }, ctxFor(dir))).summary).toContain(AST_GREP_MISSING_HINT);
    const none = buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, fakeDeps(() => ({ exitCode: 1 })));
    expect((await none.run({ pattern: "a", rewrite: "b", apply: true }, ctxFor(dir))).summary).toContain("nothing to rewrite");
  });
});

describe("planRewrite", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-code-plan-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies several matches in one file from the end, and refuses overlaps", async () => {
    const file = join(dir, "a.ts");
    const text = "f(1); f(2); f(3);\n";
    await writeFile(file, text);
    const matches = parseAstGrepJson(
      stream([0, 1, 2].map((n) => matchJson(file, text, `f(${n + 1})`, `g(${n + 1})`))),
    );
    const [plan] = await planRewrite(matches, dir);
    expect(plan).toMatchObject({ display: "a.ts", matches: 3, after: "g(1); g(2); g(3);\n" });

    const overlapping = parseAstGrepJson(
      stream([matchJson(file, text, "f(1); f(2)", "x"), matchJson(file, text, "f(2)", "y")]),
    );
    const [refused] = await planRewrite(overlapping, dir);
    expect(refused!.after).toBeNull();
    expect(refused!.reason).toMatch(/overlap/);
  });
});

describe("the project's own sgconfig.yml is never read", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "atomic-sgconfig-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pins every run, search and rewrite, to an empty config outside the project", async () => {
    const config = await neutralAstGrepConfig();
    expect(await readFile(config, "utf8")).toBe("ruleDirs: []\n");
    expect(config.startsWith(dir)).toBe(false);
    expect(await neutralAstGrepConfig()).toBe(config);

    const calls: string[][] = [];
    const cwds: string[] = [];
    const deps = { ...fakeDeps(() => ({ exitCode: 1 }), calls, cwds), neutralConfig: neutralAstGrepConfig };
    await buildOsCodeSearchTool(deps).run({ pattern: "foo()" }, ctxFor(dir));
    await buildOsCodeRewriteTool({ approvals: denyAll(), approvalRequired: true }, deps).run(
      { pattern: "foo()", rewrite: "bar()" },
      ctxFor(dir),
    );
    for (const argv of calls) expect(argv.slice(0, 3)).toEqual(["run", "--config", config]);
    expect(cwds).toEqual([dirname(config), dirname(config)]);
  });

  // NEEDS_RUN (combined MBP run, ast-grep installed): skipped where no
  // ast-grep binary is found. A repository's sgconfig.yml declares a
  // custom language whose native library does not exist; ast-grep run
  // from the project root with its own config must fail on it, and
  // os.code.search in the same repository must not read it at all.
  it.skipIf(resolveAstGrepPath() === null)(
    "a cloned repo's customLanguages.libraryPath is not loaded by os.code.search",
    async () => {
      await writeFile(
        join(dir, "sgconfig.yml"),
        [
          "ruleDirs: []",
          "customLanguages:",
          "  planted:",
          "    libraryPath: ./planted/libplanted.so",
          "    extensions: [planted]",
          "",
        ].join("\n"),
      );
      await mkdir(join(dir, "planted"));
      await writeFile(join(dir, "a.ts"), "foo();\n");
      await writeFile(join(dir, "b.planted"), "foo\n");
      const binary = resolveAstGrepPath()!;

      // Ablation: the project config is live when ast-grep runs inside the repo.
      const direct = await runCommand(binary, ["run", "--pattern", "foo()", "--json=stream", "--", "."], {
        cwd: dir,
        timeoutMs: 30_000,
      });
      expect((direct.exitCode !== 0 && direct.exitCode !== 1) || direct.stderr.trim().length > 0).toBe(true);

      const result = await buildOsCodeSearchTool().run({ pattern: "foo()", lang: "typescript" }, ctxFor(dir));
      expect(result.status).toBe("ok");
      expect(result.details.totals).toEqual({ files: 1, matches: 1 });
    },
  );
});
