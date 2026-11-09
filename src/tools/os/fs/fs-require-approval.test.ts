import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import { requireFsApproval } from "./fs-require-approval.js";

describe("requireFsApproval and the project's saved rules", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-require-approval-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function categoryOfWrite(path: string): Promise<string> {
    const gate = new ApprovalGate({
      level: 4,
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const outcome = await requireFsApproval(
      { approvals: gate, approvalRequired: true },
      { kind: "write", paths: [path], sessionId: "s", tool: "os.fs.write", reason: "r", workingDir: dir },
      new AbortController().signal,
    );
    return outcome.category;
  }

  it("treats a write of the project rules file as trust_config", async () => {
    expect(await categoryOfWrite(join(dir, ".atomic-agent", "approval-rules.json"))).toBe("trust_config");
  });

  it("leaves other workspace files alone", async () => {
    expect(await categoryOfWrite(join(dir, "notes.txt"))).toBe("fs_write_workspace");
  });
});
