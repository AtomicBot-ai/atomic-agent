import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import { requireFsApproval } from "./fs-require-approval.js";

/**
 * ATO-2505: at level 5 (bypass) `os.fs.write` ran a write into
 * `~/.ssh/authorized_keys` or `~/.bashrc` unasked. Now it asks at every
 * level and carries the finding; a write into the project stays quiet.
 * The gate denies, so nothing is written; `requireFsApproval` writes
 * nothing itself either.
 */
describe("os.fs.write into a startup or SSH file in home (ATO-2505)", () => {
  async function writeAt(path: string): Promise<ApprovalRequest[]> {
    const asked: ApprovalRequest[] = [];
    const gate: ApprovalGate = new ApprovalGate({
      level: 5,
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: false, reason: "no" });
      },
    });
    await requireFsApproval(
      { approvals: gate, approvalRequired: true },
      { kind: "write", paths: [path], sessionId: "s", tool: "os.fs.write", reason: "write", workingDir: "/tmp/project" },
      new AbortController().signal,
    ).catch(() => undefined);
    return asked;
  }

  it.each([join(homedir(), ".ssh", "authorized_keys"), join(homedir(), ".bashrc")])(
    "asks in bypass: %s",
    async (path) => {
      const asked = await writeAt(path);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        askEveryLevel: true,
        securityFinding: { rule: "dangerous.write_startup_file", confidence: 1 },
      });
    },
  );

  it("leaves a project file quiet in bypass", async () => {
    expect(await writeAt("/tmp/project/notes.txt")).toHaveLength(0);
  });
});
