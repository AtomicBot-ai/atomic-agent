import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { buildOsFsEditTool } from "../../tools/os/fs/fs-edit.js";
import { osFsReadTool } from "../../tools/os/fs/fs-read.js";
import { STALE_READ_NOTICE } from "../../tools/os/fs/fs-read-freshness.js";
import { ToolLoopTracker } from "../loop-detector.js";
import { executeBatch, toBatchInputs } from "./batch-scheduler.js";

/**
 * Seam for ATO-659: the turn's tracker owns the read versions and the
 * batch executor hands them to every tool, so a read in one step and an
 * edit in the next see the same store.
 */
describe("batch executor: file read versions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-batch-versions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function registry(): ToolRegistry {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const reg = new ToolRegistry();
    reg.register(osFsReadTool);
    reg.register(buildOsFsEditTool({ approvals: gate, approvalRequired: true }));
    return reg;
  }

  function ctx(tracker: ToolLoopTracker | undefined, stepIndex: number) {
    return {
      workingDir: dir,
      sessionId: "s1",
      stepIndex,
      signal: new AbortController().signal,
      ...(tracker ? { tracker } : {}),
    };
  }

  const edit = toBatchInputs([
    {
      tool: "os.fs.edit",
      args: { path: "a.ts", oldString: "const x = 1;", newString: "const x = 2;" },
    },
  ]);
  const readCall = toBatchInputs([{ tool: "os.fs.read", args: { path: "a.ts" } }]);

  it("notes an edit of a file changed between steps of one turn", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 1;\n", "utf8");
    const reg = registry();
    const tracker = new ToolLoopTracker();
    await executeBatch(readCall, reg, ctx(tracker, 0));
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 5;\n", "utf8");
    const outcome = await executeBatch(edit, reg, ctx(tracker, 1));
    const result = outcome.results[0]?.compressed;
    expect(result?.status).toBe("ok");
    expect(result?.summary.startsWith(STALE_READ_NOTICE)).toBe(true);
  });

  it("stays silent without a tracker", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 1;\n", "utf8");
    const reg = registry();
    await executeBatch(readCall, reg, ctx(undefined, 0));
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 5;\n", "utf8");
    const outcome = await executeBatch(edit, reg, ctx(undefined, 1));
    expect(outcome.results[0]?.compressed?.summary).not.toContain(
      STALE_READ_NOTICE,
    );
  });
});
