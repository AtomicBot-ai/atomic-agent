import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ApprovalRule } from "../../../approval/approval-rules.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-1332: a saved deny rule applies to every command, not only to the
 * ones the shell guard sends to the gate. A command the guard deems safe
 * (`echo`) is refused on the rule, and a command run by a nested shell
 * (`bash -c "rm -rf tmp"`) is matched like one on the line itself.
 */
describe.skipIf(process.platform === "win32")(
  "os.shell.run with saved deny rules (ATO-1332)",
  () => {
    let dir: string;
    let asked: ApprovalRequest[];
    let gate: ApprovalGate;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-deny-rules-"));
      asked = [];
      gate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          asked.push(req);
          gate.resolve({ approvalId: req.approvalId, approved: true });
        },
      });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function withRules(
      ...rules: Array<Pick<ApprovalRule, "decision" | "commandPrefix">>
    ): void {
      gate.setRules({
        list: () =>
          rules.map((r, i) => ({
            id: `r${i + 1}`,
            createdAt: "",
            source: "user" as const,
            ...r,
          })),
        add: () => {
          throw new Error("unused");
        },
        remove: () => false,
      });
    }

    function ctx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "s",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool() {
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    async function denial(
      args: Record<string, unknown>,
    ): Promise<ApprovalDeniedError> {
      const err = await tool()
        .run(args, ctx())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ApprovalDeniedError);
      return err as ApprovalDeniedError;
    }

    it("a deny rule on `echo` refuses `echo hi`, which the guard deems safe", async () => {
      withRules({ decision: "deny", commandPrefix: ["echo"] });
      const err = await denial({ cmd: "echo", args: ["hi"] });
      expect(err.byUser).toBe(false);
      expect(err.message).toContain("blocked by your rule r1");
      expect(asked).toEqual([]);
    });

    it("a deny rule refuses a safe command even at full trust", async () => {
      gate.setLevel(5);
      withRules({ decision: "deny", commandPrefix: ["ls"] });
      await denial({ cmd: "ls", args: ["./"] });
      expect(asked).toEqual([]);
    });

    it('a deny rule on `rm` refuses `bash -c "rm -rf tmp"` without running it', async () => {
      await mkdir(join(dir, "tmp"));
      withRules({ decision: "deny", commandPrefix: ["rm"] });
      const err = await denial({ cmd: "bash", args: ["-c", "rm -rf tmp"] });
      expect(err.message).toContain("blocked by your rule r1");
      expect((await stat(join(dir, "tmp"))).isDirectory()).toBe(true);
      expect(asked).toEqual([]);
    });

    it("a deny rule on `rm` refuses `sh -lc 'cd x && rm y'`", async () => {
      withRules({ decision: "deny", commandPrefix: ["rm"] });
      await denial({ cmd: "sh -lc 'cd x && rm y'" });
      expect(asked).toEqual([]);
    });

    // Review round: every line here ran `rm -rf tmp` past a deny rule on
    // `rm`. At level 5 the rule is the only thing between it and the disk.
    it.each([
      `tcsh -c "rm -rf tmp"`,
      `csh -c "rm -rf tmp"`,
      `fish -c "rm -rf tmp"`,
      `bash +x -c "rm -rf tmp"`,
      `sh +e -c "rm -rf tmp"`,
      "timeout 5 rm -rf tmp",
      "sudo -u root rm -rf tmp",
      "nice -n 5 rm -rf tmp",
      "env -u X rm -rf tmp",
      "eval rm -rf tmp",
      "echo tmp | xargs rm -rf",
      "printf 'rm -rf tmp' | sh",
    ])("a deny rule on `rm` refuses %s at full trust", async (line) => {
      gate.setLevel(5);
      await mkdir(join(dir, "tmp"));
      withRules({ decision: "deny", commandPrefix: ["rm"] });
      const err = await denial({ cmd: line });
      expect(err.message).toContain("blocked by your rule r1");
      expect((await stat(join(dir, "tmp"))).isDirectory()).toBe(true);
      expect(asked).toEqual([]);
    });

    it("a script piped into a bare shell is refused under any deny rule, and says why", async () => {
      gate.setLevel(5);
      withRules({ decision: "deny", commandPrefix: ["npm", "publish"] });
      const err = await denial({ cmd: "printf 'echo hi' | sh" });
      expect(err.message).toContain("a rule cannot read");
    });

    it("a script piped into a shell still runs when no deny rule exists", async () => {
      gate.setLevel(5);
      withRules({ decision: "allow", commandPrefix: ["sh"] });
      const result = await tool().run({ cmd: "printf 'echo hi' | sh" }, ctx());
      expect(result.status).toBe("ok");
    });

    it("a safe command no deny rule names still runs unasked", async () => {
      withRules({ decision: "deny", commandPrefix: ["rm"] });
      const result = await tool().run({ cmd: "echo", args: ["hi"] }, ctx());
      expect(result.status).toBe("ok");
      expect(asked).toEqual([]);
    });

    it("an ask rule does not make a safe command prompt", async () => {
      withRules({ decision: "ask", commandPrefix: ["echo"] });
      const result = await tool().run({ cmd: "echo", args: ["hi"] }, ctx());
      expect(result.status).toBe("ok");
      expect(asked).toEqual([]);
    });

    it("an allow rule on `rm` does not cover the `rm` inside `bash -c`", async () => {
      await mkdir(join(dir, "tmp"));
      withRules({ decision: "allow", commandPrefix: ["rm"] });
      const result = await tool().run(
        { cmd: "bash", args: ["-c", "rm -rf tmp"] },
        ctx(),
      );
      // Asked (and approved by the test host): the allow rule did not settle it.
      expect(result.status).toBe("ok");
      expect(asked).toHaveLength(1);
    });
  },
);
