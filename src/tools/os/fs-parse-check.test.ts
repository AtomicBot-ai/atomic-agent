import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolContext } from "../tool-registry.js";
import {
  checkFileParses,
  displayPath,
  formatParseWarning,
  PARSE_CHECK_MAX_CHARS,
  withParseWarning,
} from "./fs-parse-check.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * What a local model actually wrote: a namespace object left open at
 * EOF, the last line a method's `},` with no newline. 8 lines.
 */
const UNCLOSED = [
  "window.HD = window.HD || {};",
  "HD.Scene = {",
  "  init() {",
  "    this.items = [];",
  "  },",
  "  update(dt) {",
  "    return dt;",
  "  },",
].join("\n");

const CLOSED = `${UNCLOSED}\n};\n`;

describe("checkFileParses", () => {
  it("flags an object literal left open at EOF, with the line", () => {
    expect(checkFileParses("js/scene.js", UNCLOSED)).toEqual({
      kind: "error",
      message: "SyntaxError: Unexpected end of input (line 8)",
    });
  });

  it("accepts a classic script", () => {
    expect(checkFileParses("js/scene.js", CLOSED)).toEqual({ kind: "ok" });
  });

  it("accepts a top-level return, as Node's CommonJS wrapper does", () => {
    const src = "if (!process.env.X) return;\nmodule.exports = {};\n";
    expect(checkFileParses("a.cjs", src)).toEqual({ kind: "ok" });
    expect(checkFileParses("a.js", src)).toEqual({ kind: "ok" });
  });

  it("still flags a real error in a file with a top-level return", () => {
    const check = checkFileParses("a.js", "if (x) return;\nconst o = {\n");
    expect(check.kind).toBe("error");
    expect(check).toMatchObject({
      message: expect.stringContaining("Unexpected end of input"),
    });
  });

  it("accepts a hashbang and a byte-order mark", () => {
    expect(
      checkFileParses("bin.js", "#!/usr/bin/env node\nconsole.log(1);\n"),
    ).toEqual({ kind: "ok" });
    expect(checkFileParses("a.js", "﻿var a = 1;\n")).toEqual({
      kind: "ok",
    });
    expect(checkFileParses("a.json", '﻿{"a":1}')).toEqual({ kind: "ok" });
  });

  it.each([
    [
      "valid ES module",
      "a.js",
      'import fs from "node:fs";\nexport const a = 1;\n',
    ],
    [
      "broken ES module",
      "a.js",
      'import fs from "node:fs";\nexport const a = {\n',
    ],
    [
      "export after an earlier error",
      "a.js",
      "const a = {\n  b: 1,\n;\nexport default a;\n",
    ],
    ["broken .mjs with no imports", "a.mjs", "const a = {\n"],
    ["top-level await", "a.js", "const r = await fetch('x');\nconst o = {\n"],
    ["top-level for await", "a.js", "for await (const x of y) {}\n"],
    ["import.meta", "a.js", "console.log(import.meta.url);\n"],
    ["JSX", "a.js", "const el = <div>hi</div>;\n"],
    ["decorators", "a.js", "@decorator\nclass A {}\n"],
    [
      "Flow types",
      "a.js",
      "// @flow\nfunction f(x: number): number { return x; }\n",
    ],
  ])("gives no verdict rather than a false alarm: %s", (_label, path, src) => {
    expect(checkFileParses(path, src)).toEqual({ kind: "skipped" });
  });

  it("does not mistake `exports.x` or a dynamic import for module syntax", () => {
    const src =
      'exports.load = () => import("./x.js");\nexports.o = {\n  a: 1,\n';
    expect(checkFileParses("a.js", src)).toMatchObject({ kind: "error" });
  });

  it("flags broken JSON with the parser's position", () => {
    const check = checkFileParses("data.json", '{\n  "a": 1\n  "b": 2\n}\n');
    expect(check.kind).toBe("error");
    expect(check).toMatchObject({
      message: expect.stringMatching(/^SyntaxError: .*line 3 column 3/),
    });
    expect(checkFileParses("data.json", '{"a": [1, 2]}')).toEqual({
      kind: "ok",
    });
  });

  it("accepts JSONC (comments, trailing commas) outside strict files", () => {
    const jsonc =
      '{\n  // compiler options\n  "url": "https://a.b/c,}", /* keep */\n  "list": [1, 2,],\n}\n';
    expect(checkFileParses("tsconfig.json", jsonc)).toEqual({ kind: "ok" });
    // …but npm reads package.json strictly.
    expect(checkFileParses("package.json", '{"name": "x",}')).toMatchObject({
      kind: "error",
    });
  });

  it("skips unchecked extensions and oversized files", () => {
    expect(checkFileParses("a.ts", "const a = {\n")).toEqual({
      kind: "skipped",
    });
    expect(
      checkFileParses("big.js", `${"x".repeat(PARSE_CHECK_MAX_CHARS)} {`),
    ).toEqual({ kind: "skipped" });
  });
});

describe("formatParseWarning", () => {
  const broken = {
    kind: "error",
    message: "SyntaxError: Unexpected token ';' (line 26)",
  } as const;
  const earlier = {
    kind: "error",
    message: "SyntaxError: Unexpected end of input (line 128)",
  } as const;

  it("is silent when the file parses or no verdict was possible", () => {
    expect(
      formatParseWarning({
        path: "a.js",
        change: "write",
        after: { kind: "ok" },
      }),
    ).toBeNull();
    expect(
      formatParseWarning({
        path: "a.js",
        change: "edit",
        after: { kind: "skipped" },
        before: { kind: "ok" },
      }),
    ).toBeNull();
  });

  it("names the file and the error after a write", () => {
    expect(
      formatParseWarning({
        path: "js/scene.js",
        change: "write",
        after: earlier,
      }),
    ).toBe(
      "⚠ js/scene.js does not parse: SyntaxError: Unexpected end of input (line 128)",
    );
  });

  it("says an edit broke a file that parsed, with the count", () => {
    const warning = formatParseWarning({
      path: "js/scene.js",
      change: "edit",
      before: { kind: "ok" },
      after: broken,
      replacedOccurrences: 1,
    });
    expect(warning).toContain(
      "does not parse after this edit: SyntaxError: Unexpected token ';' (line 26)",
    );
    expect(warning).toContain(
      "It parsed before the edit, which replaced 1 occurrence —",
    );
  });

  it("calls out a many-occurrence edit that left a broken file broken", () => {
    const warning = formatParseWarning({
      path: "js/scene.js",
      change: "edit",
      before: earlier,
      after: broken,
      replacedOccurrences: 14,
    });
    expect(warning).toBe(
      "⚠ js/scene.js still does not parse: SyntaxError: Unexpected token ';' (line 26). " +
        "This edit replaced 14 occurrences without fixing it (before it: SyntaxError: Unexpected end of input (line 128))" +
        " — re-read the file and fix that error instead of stacking more edits.",
    );
  });

  it("notes a moved error after a small edit, and nothing extra when unchanged", () => {
    expect(
      formatParseWarning({
        path: "a.js",
        change: "edit",
        before: earlier,
        after: broken,
        replacedOccurrences: 1,
      }),
    ).toBe(
      "⚠ a.js still does not parse: SyntaxError: Unexpected token ';' (line 26) (before this edit: SyntaxError: Unexpected end of input (line 128))",
    );
    expect(
      formatParseWarning({
        path: "a.js",
        change: "edit",
        before: broken,
        after: broken,
        replacedOccurrences: 1,
      }),
    ).toBe(
      "⚠ a.js still does not parse: SyntaxError: Unexpected token ';' (line 26)",
    );
  });
});

describe("displayPath / withParseWarning", () => {
  it("shows workspace files relative and outside files absolute", () => {
    expect(displayPath("/w/js/scene.js", "/w")).toBe(join("js", "scene.js"));
    expect(displayPath("/elsewhere/a.js", "/w")).toBe("/elsewhere/a.js");
  });

  it("puts the warning first, where no summary cap can cut it", () => {
    const long = Array.from({ length: 60 }, (_, i) => `diff line ${i}`).join(
      "\n",
    );
    const base = compressToolResult({
      tool: "os.fs.edit",
      status: "ok",
      output: long,
    });
    const warned = withParseWarning(
      base,
      "⚠ a.js does not parse: SyntaxError: x",
    );
    expect(warned.summary.startsWith("⚠ a.js does not parse")).toBe(true);
    expect(warned.summary).toContain(base.summary);
    expect(warned.details.parseWarning).toBe(
      "⚠ a.js does not parse: SyntaxError: x",
    );
    expect(withParseWarning(base, null)).toBe(base);
  });
});

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

describe("os.fs.write parse check", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-write-parse-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function writeTool() {
    return buildOsFsWriteTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
  }

  it("writes a broken script anyway and puts the syntax error in the result", async () => {
    const result = await writeTool().run(
      { path: "js/scene.js", content: UNCLOSED },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "js", "scene.js"), "utf8")).toBe(UNCLOSED);
    const [first, second] = result.summary.split("\n");
    expect(first).toBe(
      `⚠ ${join("js", "scene.js")} does not parse: SyntaxError: Unexpected end of input (line 8)`,
    );
    expect(second).toContain("wrote ");
    expect(result.details.parseWarning).toBe(first);
  });

  it("stays silent for code that parses, ES modules and non-code files", async () => {
    const tool = writeTool();
    const ok = await tool.run(
      { path: "scene.js", content: CLOSED },
      makeCtx(dir),
    );
    const esm = await tool.run(
      {
        path: "mod.js",
        content: 'import a from "./a.js";\nexport default a;\n',
      },
      makeCtx(dir),
    );
    const text = await tool.run(
      { path: "notes.txt", content: UNCLOSED },
      makeCtx(dir),
    );
    for (const result of [ok, esm, text]) {
      expect(result.summary).not.toContain("⚠");
      expect(result.details.parseWarning).toBeUndefined();
    }
  });

  it("judges an append on the whole file", async () => {
    const tool = writeTool();
    const head = await tool.run(
      { path: "scene.js", content: UNCLOSED },
      makeCtx(dir),
    );
    expect(head.details.parseWarning).toBeDefined();
    const tail = await tool.run(
      { path: "scene.js", content: "\n};\n", mode: "append" },
      makeCtx(dir),
    );
    expect(tail.details.parseWarning).toBeUndefined();
  });

  it("flags broken JSON", async () => {
    const result = await writeTool().run(
      { path: "data/levels.json", content: '{"levels": [1, 2' },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.details.parseWarning).toMatch(
      /^⚠ data[/\\]levels\.json does not parse: SyntaxError: /,
    );
  });
});
