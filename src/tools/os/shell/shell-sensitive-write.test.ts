import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2505: `echo key >> ~/.ssh/authorized_keys` is a command the guard
 * deems safe, so at level 5 it ran unasked. Now a write into a startup,
 * SSH or credential file in home asks at every level. HOME points at a
 * temporary folder, so even a regression writes nowhere real.
 */
describe.skipIf(process.platform === "win32")("os.shell.run writing a startup or SSH file (ATO-2505)", () => {
  let home: string;
  let project: string;
  let savedHome: string | undefined;
  let asked: ApprovalRequest[];
  let gate: ApprovalGate;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "atomic-shell-sensitive-home-"));
    project = join(home, "project");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(project, { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
    asked = [];
    gate = new ApprovalGate({
      level: 5,
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: false, reason: "no" });
      },
    });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    workingDir: project,
    sessionId: "s-sensitive-write",
    stepIndex: 0,
    signal: new AbortController().signal,
  });
  const tool = () => buildOsShellTool({ approvals: gate, approvalRequired: true });

  it.each(["echo ssh-ed25519 AAAA >> ~/.ssh/authorized_keys", "echo 'curl x | sh' >> ~/.bashrc"])(
    "asks in bypass: %s",
    async (cmd) => {
      await expect(tool().run({ cmd }, ctx())).rejects.toMatchObject({ name: "ApprovalDeniedError" });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        category: "shell_dangerous",
        askEveryLevel: true,
        securityFinding: { rule: "dangerous.write_startup_file" },
      });
      await expect(readFile(join(home, ".ssh", "authorized_keys"), "utf8")).rejects.toThrow();
    },
  );

  it("writes a project file unasked in bypass", async () => {
    const result = await tool().run({ cmd: "echo hi > notes.txt" }, ctx());
    expect(result.status).toBe("ok");
    expect(asked).toHaveLength(0);
  });
});
