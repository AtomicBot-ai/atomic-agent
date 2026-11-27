import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../approval/approval-gate.js";
import { launchApprovalNote } from "./launch-command.js";
import { startLaunchServe } from "./launch-serve.js";
import { parseArgs } from "./serve-args.js";
import { LAUNCH_APPROVAL_REFUSAL, refuseApproval } from "./serve-refuse-approvals.js";

/**
 * ATO-2172 review: the serve `atag launch` starts has nobody to answer
 * an approval (Claude Code, Codex and OpenCode never read /api/events),
 * so a prompt there must be refused at once, not wait forever.
 */
describe("serve --refuse-approvals", () => {
  it("parses the flag; off by default", () => {
    const on = parseArgs(["--refuse-approvals"]);
    const off = parseArgs([]);
    expect("refuseApprovals" in on && on.refuseApprovals).toBe(true);
    expect("refuseApprovals" in off && off.refuseApprovals).toBe(false);
  });

  it("a prompting request is denied at once with the reason, and nothing stays pending", async () => {
    const gate: ApprovalGate = new ApprovalGate({
      emit: (request) => refuseApproval(gate, request),
      level: 1,
    });
    const decision = await gate.request({
      sessionId: "compat-1",
      tool: "os.shell.run",
      category: "shell",
      reason: "run make",
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe(LAUNCH_APPROVAL_REFUSAL);
    expect(decision.automatic).toBe(true);
    expect(gate.isPending(decision.approvalId)).toBe(false);
  });

  it("atag launch starts its serve with --refuse-approvals", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "atomic-launch-serve-"));
    try {
      let spawned: readonly string[] = [];
      const result = await startLaunchServe(stateDir, stateDir, {
        freePort: async () => 41999,
        spawn: ((_cmd: string, args: readonly string[]) => {
          spawned = args;
          return { pid: undefined, on: () => undefined, unref: () => undefined };
        }) as never,
      });
      expect("error" in result).toBe(true);
      expect(spawned).toContain("--refuse-approvals");
      expect(spawned).toContain("serve");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("the launch banner says where approvals go", () => {
    expect(launchApprovalNote({ baseUrl: "http://127.0.0.1:41999", started: true })).toContain(
      "approvals are refused on this serve",
    );
    expect(launchApprovalNote({ baseUrl: "http://127.0.0.1:41999", started: false })).toContain(
      "http://127.0.0.1:41999/panel",
    );
  });
});
