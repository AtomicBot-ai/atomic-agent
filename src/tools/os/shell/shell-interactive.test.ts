import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-1252 through the tool with real processes: a command that waits
 * for a person comes back with a handoff instead of sitting until the
 * timeout, `background: true` hands back a kept job, and neither path
 * skips the guard or the approval.
 */

const SESSION = "shell-interactive";

describe.skipIf(process.platform === "win32")("os.shell.run and commands that wait for a person", () => {
  let dir: string;
  let jobs: ShellJobRegistry;
  let asked: ApprovalRequest[];
  let approve: boolean;

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: approve });
      },
    });
    return buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      defaultTimeoutMs: 20_000,
      jobs,
      promptWatch: { pollMs: 100, quietMs: 400 },
      backgroundSettleMs: 300,
    });
  }

  function ctx(): ToolContext {
    return {
      sessionId: SESSION,
      stepIndex: 0,
      workingDir: dir,
      modelMode: "cloud",
      signal: new AbortController().signal,
    } as ToolContext;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-interactive-"));
    jobs = new ShellJobRegistry();
    asked = [];
    approve = true;
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a device-code sign-in as a job and hands over the link and code", async () => {
    const started = Date.now();
    const result = await tool().run(
      { cmd: "printf 'First copy your one-time code: ABCD-1234\\nOpen https://example.test/login/device in your browser\\n'; sleep 30" },
      ctx(),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.summary).toContain("this step needs the user");
    expect(result.summary).toContain("code: ABCD-1234");
    expect(result.summary).toContain("link: https://example.test/login/device");
    expect(result.details).toMatchObject({ detached: true, keep: true });
    // It went through the approval like any other command.
    expect(asked).toHaveLength(1);
  });

  it("stops a command sitting at a password prompt", async () => {
    const result = await tool().run(
      { cmd: "printf 'Password: '; sleep 30" },
      ctx(),
    );
    expect(result.summary).toContain("this step needs the user: it asks for a password");
    expect(result.summary).toContain("was stopped");
    expect(result.details).not.toMatchObject({ detached: true });
  });

  it("says which step needs the user when sudo fails without a terminal", async () => {
    const result = await tool().run(
      { cmd: "echo 'sudo: a terminal is required to read the password' >&2; exit 1" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("needs your computer password");
  });

  it("starts a server with background: true and returns a kept job", async () => {
    const result = await tool().run(
      { cmd: "echo listening on http://localhost:3000; sleep 30", background: true },
      ctx(),
    );
    expect(result.summary).toContain("started in the background as job");
    expect(result.summary).toContain("listening on http://localhost:3000");
    expect(result.details).toMatchObject({ detached: true, keep: true });
    jobs.endTurn(SESSION);
    expect(jobs.list(SESSION).filter((r) => r.job.exited() === null)).toHaveLength(1);
  });

  it("reports a background command that failed at once as a normal exit", async () => {
    const result = await tool().run(
      { cmd: "echo port in use >&2; exit 3", background: true },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("exit: 3");
  });

  it("asks before a dangerous command in the background, and does not start it when declined", async () => {
    approve = false;
    await expect(
      tool().run({ cmd: "rm", args: ["-rf", join(dir, "x")], background: true }, ctx()),
    ).rejects.toThrow(/declined/);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reason).toMatch(/recursive remove/);
    expect(jobs.list(SESSION)).toHaveLength(0);
  });

  it("still blocks a catastrophic command in the background", async () => {
    const result = await tool().run({ cmd: "rm -rf ~", background: true }, ctx());
    expect(result.summary).toContain("blocked by shell guard");
    expect(asked).toHaveLength(0);
  });

  it("gives the command the non-interactive switches without the agent's secrets", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-not-for-children";
    try {
      const result = await tool().run(
        { cmd: "echo \"brew=$HOMEBREW_NO_AUTO_UPDATE apt=$DEBIAN_FRONTEND key=${OPENAI_API_KEY:-none}\"" },
        ctx(),
      );
      expect(result.summary).toContain("brew=1 apt=noninteractive key=none");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});
