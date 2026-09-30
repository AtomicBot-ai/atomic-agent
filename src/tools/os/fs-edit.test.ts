import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";

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

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.reject(req.approvalId, "denied by test"),
  });
  return gate;
}

describe("os.fs.edit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-edit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a unique substring after approval", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1;\nconst y = 2;\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { path: "a.ts", oldString: "const x = 1;", newString: "const x = 42;" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("const x = 42;\nconst y = 2;\n");
    expect(result.details.replacedOccurrences).toBe(1);
  });

  it("rejects non-unique oldString without replaceAll", async () => {
    const file = join(dir, "b.ts");
    await writeFile(file, "foo\nfoo\nbar\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "b.ts", oldString: "foo", newString: "baz" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/not unique/);
    expect(await readFile(file, "utf8")).toBe("foo\nfoo\nbar\n");
  });

  it("replaces every occurrence when replaceAll=true", async () => {
    const file = join(dir, "c.ts");
    await writeFile(file, "foo\nfoo\nbar\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: "c.ts",
        oldString: "foo",
        newString: "baz",
        replaceAll: true,
      },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("baz\nbaz\nbar\n");
    expect(result.details.replacedOccurrences).toBe(2);
  });

  it("rejects when oldString is not found", async () => {
    const file = join(dir, "d.ts");
    await writeFile(file, "alpha\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "d.ts", oldString: "beta", newString: "gamma" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("rejects when oldString equals newString", async () => {
    const file = join(dir, "e.ts");
    await writeFile(file, "foo\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "e.ts", oldString: "foo", newString: "foo" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/differ/);
  });

  it("honours approval denial and leaves the file intact", async () => {
    const file = join(dir, "f.ts");
    const original = "const x = 1;\n";
    await writeFile(file, original, "utf8");
    const tool = buildOsFsEditTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "f.ts", oldString: "const x = 1;", newString: "const x = 2;" },
        makeCtx(dir),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("preserves multi-byte UTF-8 correctly", async () => {
    const file = join(dir, "utf8.ts");
    await writeFile(file, "магос благословенный\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: "utf8.ts",
        oldString: "магос",
        newString: "инициат",
      },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("инициат благословенный\n");
  });

  it("leaves no orphaned temp files in the target directory", async () => {
    const file = join(dir, "g.ts");
    await writeFile(file, "one\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await tool.run(
      { path: "g.ts", oldString: "one", newString: "two" },
      makeCtx(dir),
    );
    const remaining = await readdir(dir);
    expect(
      remaining.filter((name) => name.endsWith(".atomic-agent.tmp")),
    ).toEqual([]);
  });

  it("keeps the whole diff, both ends, for a multi-line edit", async () => {
    // Eighteen changed lines, so the diff is 38 lines: well past the
    // compressor's 12-line default, and inside the 40 lines
    // `renderUnifiedDiff` is willing to emit.
    const file = join(dir, "many.ts");
    const before = Array.from(
      { length: 18 },
      (_, i) => `const v${i} = ${i};`,
    ).join("\n");
    const after = Array.from(
      { length: 18 },
      (_, i) => `const v${i} = ${i + 100};`,
    ).join("\n");
    await writeFile(file, `${before}\n`, "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { path: "many.ts", oldString: before, newString: after },
      makeCtx(dir),
    );

    expect(result.status).toBe("ok");
    // The header end: which file this diff is of. A 12-line tail-slice
    // throws these two lines away first.
    expect(result.summary).toContain(`--- a/${file}`);
    expect(result.summary).toContain(`+++ b/${file}`);
    // The body end: the first and last line on both sides of the change.
    expect(result.summary).toContain("-const v0 = 0;");
    expect(result.summary).toContain("-const v17 = 17;");
    expect(result.summary).toContain("+const v0 = 100;");
    expect(result.summary).toContain("+const v17 = 117;");
    expect(result.summary).not.toContain("[omitted");
    expect(result.summary).not.toContain("[truncated]");
    expect(result.truncated).toBe(false);
  });

  describe("parse check on code files", () => {
    /**
     * `HD.Scene = { m0() {…}, m1() {…}, … }` — the shape a local model
     * wrote. Unclosed, the file ends on the last method's `},` with no
     * trailing newline, exactly as the model left it.
     */
    function sceneSource(methods: number, closed: boolean): string {
      const lines = ["HD.Scene = {"];
      for (let i = 0; i < methods; i += 1) {
        lines.push(`  m${i}() {`, `    return ${i};`, "  },");
      }
      return closed ? `${lines.join("\n")}\n};\n` : lines.join("\n");
    }

    it("warns with the count when replaceAll breaks a file that parsed", async () => {
      const file = join(dir, "scene.js");
      await writeFile(file, sceneSource(4, true), "utf8");
      const tool = buildOsFsEditTool({
        approvals: approveAll(),
        approvalRequired: true,
      });
      const result = await tool.run(
        {
          path: "scene.js",
          oldString: "},\n",
          newString: "};\n",
          replaceAll: true,
        },
        makeCtx(dir),
      );
      // Never blocks: the edit lands and the call still succeeds.
      expect(result.status).toBe("ok");
      expect(await readFile(file, "utf8")).toContain("  };\n  m1() {");
      expect(result.details.replacedOccurrences).toBe(4);
      expect(result.summary.split("\n")[0]).toBe(
        "⚠ scene.js does not parse after this edit: SyntaxError: Unexpected token ';' (line 4). " +
          "It parsed before the edit, which replaced 4 occurrences — undo it, or re-read the file and rewrite it, instead of stacking more edits.",
      );
      expect(result.details.parseWarning).toBe(result.summary.split("\n")[0]);
    });

    it("says a blind replaceAll left a broken file broken, and what broke it before", async () => {
      // The benchmark sequence: the file was already unclosed at EOF, and
      // the `},\n` → `};\n` sweep broke every method separator instead
      // while missing the last `},`, which has no newline after it.
      const file = join(dir, "scene.js");
      await writeFile(file, sceneSource(5, false), "utf8");
      const tool = buildOsFsEditTool({
        approvals: approveAll(),
        approvalRequired: true,
      });
      const result = await tool.run(
        {
          path: "scene.js",
          oldString: "},\n",
          newString: "};\n",
          replaceAll: true,
        },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      const warning = result.summary.split("\n")[0]!;
      expect(warning).toContain(
        "⚠ scene.js still does not parse: SyntaxError: Unexpected token ';' (line 4)",
      );
      expect(warning).toContain("replaced 4 occurrences without fixing it");
      expect(warning).toContain(
        "before it: SyntaxError: Unexpected end of input (line 16)",
      );
      expect(warning).toContain("instead of stacking more edits");
    });

    it("stays silent for an edit that keeps the file parsing", async () => {
      const file = join(dir, "scene.js");
      await writeFile(file, sceneSource(3, true), "utf8");
      const tool = buildOsFsEditTool({
        approvals: approveAll(),
        approvalRequired: true,
      });
      const result = await tool.run(
        { path: "scene.js", oldString: "return 1;", newString: "return 10;" },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      expect(result.summary).not.toContain("⚠");
      expect(result.details.parseWarning).toBeUndefined();
    });

    it("stays silent once an edit repairs a broken file", async () => {
      const file = join(dir, "scene.js");
      await writeFile(file, sceneSource(2, false), "utf8");
      const tool = buildOsFsEditTool({
        approvals: approveAll(),
        approvalRequired: true,
      });
      const result = await tool.run(
        {
          path: "scene.js",
          oldString: "return 1;\n  },",
          newString: "return 1;\n  },\n};\n",
        },
        makeCtx(dir),
      );
      expect(result.status).toBe("ok");
      expect(result.details.parseWarning).toBeUndefined();
    });

    it("does not check files it cannot judge", async () => {
      // `.ts` is not parse-checked; neither is an ES module whose syntax
      // a plain script parse would reject.
      await writeFile(join(dir, "types.ts"), "export const a = {\n", "utf8");
      await writeFile(
        join(dir, "esm.js"),
        'import x from "./x.js";\nexport const a = { b: 1 };\n',
        "utf8",
      );
      const tool = buildOsFsEditTool({
        approvals: approveAll(),
        approvalRequired: true,
      });
      const ts = await tool.run(
        { path: "types.ts", oldString: "a = {", newString: "b = {" },
        makeCtx(dir),
      );
      const esm = await tool.run(
        { path: "esm.js", oldString: "b: 1 };", newString: "b: 1" },
        makeCtx(dir),
      );
      expect(ts.details.parseWarning).toBeUndefined();
      expect(esm.details.parseWarning).toBeUndefined();
    });
  });
});
