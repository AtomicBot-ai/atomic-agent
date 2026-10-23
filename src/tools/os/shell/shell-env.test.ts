import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

// ATO-347: a command the model runs must not see the agent's provider
// keys, while the agent's own `process.env` keeps them.
describe.skipIf(process.platform === "win32")(
  "os.shell.run does not hand the agent's secrets to the command",
  () => {
    const NAMES = {
      ATO347_TEST_API_KEY: "leaked-key-value",
      ATO347_PASS_TOKEN: "passed-token-value",
      ATO347_PLAIN: "plain-value",
    } as const;
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-env-"));
      Object.assign(process.env, NAMES);
    });

    afterEach(async () => {
      for (const name of Object.keys(NAMES)) delete process.env[name];
      await rm(dir, { recursive: true, force: true });
    });

    function makeCtx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "test-session",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool(envPassthrough?: string[]) {
      const gate = new ApprovalGate({
        emit: (req) =>
          gate.resolve({ approvalId: req.approvalId, approved: true }),
      });
      return buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        ...(envPassthrough === undefined ? {} : { envPassthrough }),
      });
    }

    // One printenv per name: BSD printenv on macOS takes a single name.
    const line =
      "printenv ATO347_PLAIN; printenv ATO347_TEST_API_KEY; printenv ATO347_PASS_TOKEN; echo end";

    it("strips key and token variables and keeps the rest", async () => {
      const result = await tool().run({ cmd: line }, makeCtx());
      expect(result.summary).toContain("plain-value");
      expect(result.summary).not.toContain("leaked-key-value");
      expect(result.summary).not.toContain("passed-token-value");
      expect(process.env.ATO347_TEST_API_KEY).toBe("leaked-key-value");
    });

    it("passes a variable the operator listed in envPassthrough", async () => {
      const result = await tool(["ATO347_PASS_TOKEN"]).run(
        { cmd: line },
        makeCtx(),
      );
      expect(result.summary).toContain("passed-token-value");
      expect(result.summary).not.toContain("leaked-key-value");
    });

    it("keeps a variable the command line sets itself", async () => {
      const result = await tool().run(
        { cmd: "ATO347_TEST_API_KEY=inline-value printenv ATO347_TEST_API_KEY" },
        makeCtx(),
      );
      expect(result.summary).toContain("inline-value");
    });
  },
);
