import { mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

  // Review round 1: the check compared written paths only, so a link to
  // home got past it, and home itself (an extract or copy into it) gave
  // no match.
  it.skipIf(process.platform === "win32")("asks in bypass for a write through a symlink to home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-fs-sensitive-link-"));
    try {
      await symlink(homedir(), join(dir, "h"));
      const asked = await writeAt(join(dir, "h", ".ssh", "authorized_keys"));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ askEveryLevel: true, securityFinding: { rule: "dangerous.write_startup_file" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("asks in bypass for a write into the home folder itself", async () => {
    const asked = await writeAt(homedir());
    expect(asked[0]).toMatchObject({ askEveryLevel: true });
  });
});
