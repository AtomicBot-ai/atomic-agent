import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import type { LspChangeInput } from "./lsp/index.js";

/**
 * The seam between the three mutating tools and the language-server
 * diagnostics (ATO-503): what they hand over, and that the block lands
 * in the result the model reads. The servers themselves are faked.
 */

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

const BLOCK = "⚠ a.ts: 1 new error from typescript after this edit:\n  line 1:7 [2322] Type 'string' is not assignable to type 'number'.";

function fakeLsp(answer: string | null = BLOCK) {
  const calls: LspChangeInput[] = [];
  return {
    calls,
    lspDiagnostics: {
      async diagnoseChange(input: LspChangeInput) {
        calls.push(input);
        return answer;
      },
    },
  };
}

describe("after-edit language-server diagnostics in fs tools (ATO-503)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-fs-lsp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("os.fs.edit hands over the file before and after, and shows the new errors first", async () => {
    await writeFile(join(dir, "a.ts"), "const n: number = 1;\n", "utf8");
    const lsp = fakeLsp();
    const tool = buildOsFsEditTool({ approvals: approveAll(), approvalRequired: true, lspDiagnostics: lsp.lspDiagnostics });
    const result = await tool.run(
      { path: "a.ts", oldString: "= 1;", newString: "= 'x';" },
      makeCtx(dir),
    );
    expect(lsp.calls).toEqual([
      {
        absolute: join(dir, "a.ts"),
        display: "a.ts",
        change: "edit",
        before: "const n: number = 1;\n",
        after: "const n: number = 'x';\n",
      },
    ]);
    expect(result.summary.startsWith(BLOCK)).toBe(true);
    expect(result.details.parseWarning).toBe(BLOCK);
  });

  it("os.fs.edit puts the parse warning before the language-server block", async () => {
    await writeFile(join(dir, "a.js"), "const a = {\n  b: 1,\n};\n", "utf8");
    const tool = buildOsFsEditTool({ approvals: approveAll(), approvalRequired: true, lspDiagnostics: fakeLsp("LSP BLOCK").lspDiagnostics });
    const result = await tool.run(
      { path: "a.js", oldString: "};", newString: "" },
      makeCtx(dir),
    );
    const warning = String(result.details.parseWarning);
    expect(warning).toMatch(/^⚠ a\.js does not parse/);
    expect(warning.endsWith("\nLSP BLOCK")).toBe(true);
  });

  it("os.fs.write compares against the file it replaced, and a new file against nothing", async () => {
    await writeFile(join(dir, "old.py"), "x = 1\n", "utf8");
    const lsp = fakeLsp(null);
    const tool = buildOsFsWriteTool({ approvals: approveAll(), approvalRequired: true, lspDiagnostics: lsp.lspDiagnostics });
    await tool.run({ path: "old.py", content: "x = y\n", overwrite: true }, makeCtx(dir));
    await tool.run({ path: "new.py", content: "z = 1\n" }, makeCtx(dir));
    expect(lsp.calls[0]).toMatchObject({ change: "write", before: "x = 1\n", after: "x = y\n" });
    expect(lsp.calls[1]).toMatchObject({ change: "write", after: "z = 1\n" });
    expect(lsp.calls[1]?.before).toBeUndefined();
  });

  it("os.fs.patch asks once per applied file", async () => {
    const original = "export const a = 1;\n";
    const updated = "export const a: string = 1;\n";
    await writeFile(join(dir, "a.ts"), original, "utf8");
    const lsp = fakeLsp("PATCH BLOCK");
    const tool = buildOsFsPatchTool({ approvals: approveAll(), approvalRequired: true, lspDiagnostics: lsp.lspDiagnostics });
    const result = await tool.run(
      { patch: createPatch("a.ts", original, updated), apply: true },
      makeCtx(dir),
    );
    expect(result.details.mode).toBe("applied");
    expect(lsp.calls).toHaveLength(1);
    expect(lsp.calls[0]).toMatchObject({ change: "patch", before: original, after: updated });
    expect(String(result.details.parseWarning)).toContain("PATCH BLOCK");
  });

  it("without the option the results carry no language-server block", async () => {
    await writeFile(join(dir, "a.ts"), "const n = 1;\n", "utf8");
    const tool = buildOsFsEditTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run(
      { path: "a.ts", oldString: "= 1;", newString: "= 2;" },
      makeCtx(dir),
    );
    expect(result.details.parseWarning).toBeUndefined();
  });
});
