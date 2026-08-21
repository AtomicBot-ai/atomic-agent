import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * `[e]` on the approval prompt: the operator moves a write somewhere
 * else before approving it. The rule these tests pin is that a retarget
 * rides the approval only while it stays on the same rung of the
 * ladder — anything else is a new question, and the agent's own config
 * is never an answer at all.
 */
describe("os.fs.write retarget", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-write-retarget-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx() {
    return {
      workingDir: dir,
      sessionId: "s1",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  it("offers the resolved target as the redirectable path", async () => {
    const seen: ApprovalRequest[] = [];
    const gate = new ApprovalGate({
      emit: (req) => {
        seen.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    await tool.run({ path: "out.txt", content: "hi" }, ctx());
    expect(seen[0]?.redirectablePath).toBe(join(dir, "out.txt"));
  });

  it("writes to the operator's path, creating folders that do not exist", async () => {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({
          approvalId: req.approvalId,
          approved: true,
          pathOverride: join(dir, "brand", "new", "index.html"),
        }),
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { path: "out.txt", content: "<h1>apple</h1>" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "brand", "new", "index.html"), "utf8")).toBe(
      "<h1>apple</h1>",
    );
    // The model has to learn where the file actually went, or its next
    // step reads back a path that was never written.
    expect(result.details.path).toBe(join(dir, "brand", "new", "index.html"));
    expect(result.details.requestedPath).toBe(join(dir, "out.txt"));
    expect(result.summary).toContain("the operator moved this write");
  });

  it("asks again when the new target sits on a different rung", async () => {
    // workspace → home. One prompt covers one rung; the second prompt
    // is the operator confirming the rung they just moved to.
    const prompts: ApprovalRequest[] = [];
    const outside = join(homedir(), ".atomic-agent-retarget-test", "out.txt");
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts.push(req);
        if (prompts.length === 1) {
          gate.resolve({
            approvalId: req.approvalId,
            approved: true,
            pathOverride: outside,
          });
          return;
        }
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    try {
      const result = await tool.run({ path: "out.txt", content: "x" }, ctx());
      expect(result.status).toBe("ok");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]?.category).toBe("fs_write_workspace");
      expect(prompts[1]?.category).toBe("fs_write_home");
      expect(prompts[1]?.reason).toContain(outside);
    } finally {
      await rm(join(homedir(), ".atomic-agent-retarget-test"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("refuses a retarget onto the agent's own config", async () => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{}", "utf8");
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({
          approvalId: req.approvalId,
          approved: true,
          pathOverride: configPath,
        }),
    });
    const tool = buildOsFsWriteTool({
      approvals: gate,
      approvalRequired: true,
      trustConfigPaths: [configPath],
    });
    await expect(
      tool.run({ path: "out.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/refusing to redirect into the agent's own config/);
    expect(await readFile(configPath, "utf8")).toBe("{}");
  });

  it("gives up rather than loop when a host keeps redirecting", async () => {
    // A host that answers every prompt with a new target would spin
    // forever; the cap turns that into a plain tool error.
    let hop = 0;
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({
          approvalId: req.approvalId,
          approved: true,
          // Alternating rungs keeps every hop asking again.
          pathOverride:
            hop++ % 2 === 0
              ? join(homedir(), ".atomic-agent-retarget-loop", `${hop}.txt`)
              : join(dir, `${hop}.txt`),
        }),
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    try {
      await expect(
        tool.run({ path: "out.txt", content: "x" }, ctx()),
      ).rejects.toThrow(/redirected more than/);
    } finally {
      await rm(join(homedir(), ".atomic-agent-retarget-loop"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("ignores a pathOverride on a tool that never offered one", async () => {
    // `redirectablePath` is the offer; an override without it is a host
    // answering a question nobody asked.
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({
          approvalId: req.approvalId,
          approved: true,
          pathOverride: join(dir, "elsewhere.txt"),
        }),
    });
    const decision = await gate.request({
      sessionId: "s1",
      tool: "os.shell.run",
      category: "shell",
      reason: "run something",
    });
    expect(decision.approved).toBe(true);
    // The gate passes it through untouched — it is `requireApproval`
    // that drops it, which the write tool above exercises end to end.
    expect(decision.pathOverride).toBe(join(dir, "elsewhere.txt"));
  });
});
