import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import {
  FUSION_WORKER_APPROVAL_MARKER,
  FUSION_WORKER_APPROVAL_REFUSED,
  FUSION_WORKER_OPERATOR_ONLY_MARKER,
  workerRefusalFor,
} from "../../fusion/worker-tool-policy.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-1223: a fan-out's directory lets its workers run commands there
 * unasked, but not a dangerous one. `rm -rf ./build` inside the scope
 * goes to the gate, where the worker's refuse policy hands it back at
 * once, worded so nobody re-sends it into the same refusal.
 */
describe.skipIf(process.platform === "win32")(
  "os.shell.run in a fan-out's directory: dangerous commands are not covered (ATO-1223)",
  () => {
    const WORKER = "s-w-fanout-1";
    let dir: string;
    let asked: ApprovalRequest[];
    let gate: ApprovalGate;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-fanout-"));
      asked = [];
      gate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          asked.push(req);
          gate.resolve({ approvalId: req.approvalId, approved: true });
        },
      });
      gate.setSessionPolicy(WORKER, {
        onPrompt: "refuse",
        reason: FUSION_WORKER_APPROVAL_REFUSED,
        reasonFor: workerRefusalFor,
      });
      gate.fanoutScopes.grant(WORKER, [dir]);
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function ctx(cwd = dir): ToolContext {
      return {
        workingDir: cwd,
        sessionId: WORKER,
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool() {
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    it("refuses rm -rf inside the scope at once, without running it or asking anyone", async () => {
      await mkdir(join(dir, "build"));
      expect(gate.fanoutScopes.allows(WORKER, [dir])).toBe(true);

      const err = await tool()
        .run({ cmd: "rm", args: ["-rf", "./build"] }, ctx())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ApprovalDeniedError);
      expect((err as ApprovalDeniedError).byUser).toBe(false);
      expect((err as ApprovalDeniedError).message).toContain(
        FUSION_WORKER_OPERATOR_ONLY_MARKER,
      );
      // Still classified as a hand-back (`needs_orchestrator`).
      expect((err as ApprovalDeniedError).message).toContain(
        FUSION_WORKER_APPROVAL_MARKER,
      );
      expect((await stat(join(dir, "build"))).isDirectory()).toBe(true);
      expect(asked).toEqual([]);
    });

    it("still runs an ordinary command in the same directory unasked", async () => {
      const result = await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      expect(result.status).toBe("ok");
      expect(asked).toEqual([]);
    });

    it("keeps the general refusal for an ordinary command outside the scope", async () => {
      const outside = await mkdtemp(join(tmpdir(), "atomic-shell-outside-"));
      try {
        const err = await tool()
          .run({ cmd: "ls", args: ["./"] }, ctx(outside))
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(ApprovalDeniedError);
        expect((err as ApprovalDeniedError).message).toContain(
          FUSION_WORKER_APPROVAL_MARKER,
        );
        expect((err as ApprovalDeniedError).message).not.toContain(
          FUSION_WORKER_OPERATOR_ONLY_MARKER,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("full trust (level 5) still runs it: the level settles it before the policy", async () => {
      gate.setLevel(5);
      await mkdir(join(dir, "build"));
      const result = await tool().run(
        { cmd: "rm", args: ["-rf", "./build"] },
        ctx(),
      );
      expect(result.status).toBe("ok");
      await expect(stat(join(dir, "build"))).rejects.toThrow();
    });
  },
);
