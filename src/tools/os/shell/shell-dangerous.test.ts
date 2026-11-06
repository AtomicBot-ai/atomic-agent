import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalGate,
  canGrantCategory,
  canGrantShape,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool, isDangerousGuardRule } from "./shell.js";

/**
 * ATO-1220: a command the guard's dangerous layer matched asks as
 * `shell_dangerous`, which no `shell` grant, no `[a]` shape grant and no
 * level below 5 silences. Real gate at level 1; the emitter answers
 * through `answer`, and records every request it was shown.
 */
describe.skipIf(process.platform === "win32")(
  "os.shell.run: dangerous commands ask every time (ATO-1220)",
  () => {
    let dir: string;
    let asked: ApprovalRequest[];
    let answer: (req: ApprovalRequest) => Omit<ApprovalDecision, "approvalId">;
    let gate: ApprovalGate;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-dangerous-"));
      asked = [];
      answer = () => ({ approved: false });
      gate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          asked.push(req);
          gate.resolve({ approvalId: req.approvalId, ...answer(req) });
        },
      });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function ctx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "s-dangerous",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool() {
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    async function runDenied(args: Record<string, unknown>): Promise<void> {
      await expect(tool().run(args, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
    }

    it("a shell category grant does not cover rm -rf, git reset --hard or sudo", async () => {
      answer = (req) =>
        req.category === "shell"
          ? { approved: true, grant: "category" }
          : { approved: false, reason: "no" };
      await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      expect(asked).toHaveLength(1);
      expect(gate.sessionGrants("s-dangerous").categories).toEqual(["shell"]);

      // Ordinary commands ride the grant.
      await tool().run({ cmd: "ls" }, ctx());
      await tool().run({ cmd: "git", args: ["status"] }, ctx());
      expect(asked).toHaveLength(1);

      // Dangerous ones still ask, with no shape to remember.
      await runDenied({ cmd: "rm", args: ["-rf", "./x"] });
      await runDenied({ cmd: "git", args: ["reset", "--hard"] });
      await runDenied({ cmd: "sudo", args: ["ls"] });
      expect(asked).toHaveLength(4);
      for (const req of asked.slice(1)) {
        expect(req.category).toBe("shell_dangerous");
        expect(req.commandShape).toBeUndefined();
        expect(canGrantCategory(req)).toBe(false);
        expect(canGrantShape(req)).toBe(false);
      }
    });

    it("a shape grant on git covers git status but not git push --force", async () => {
      answer = (req) =>
        req.category === "shell" && req.commandShape === "git"
          ? { approved: true, grant: "shape" }
          : { approved: false, reason: "no" };
      await tool().run({ cmd: "git", args: ["log", "-1"] }, ctx());
      expect(asked).toHaveLength(1);
      expect(gate.sessionGrants("s-dangerous").shapes).toEqual(["git"]);

      await tool().run({ cmd: "git", args: ["status"] }, ctx());
      expect(asked).toHaveLength(1);

      await runDenied({ cmd: "git", args: ["push", "--force"] });
      expect(asked).toHaveLength(2);
      expect(asked[1]!.category).toBe("shell_dangerous");
      expect(asked[1]!.commandShape).toBeUndefined();
    });

    it("an approve with grant: category on rm -rf runs once and records nothing", async () => {
      await mkdir(join(dir, "x"));
      answer = () => ({ approved: true, grant: "category" });
      const result = await tool().run({ cmd: "rm", args: ["-rf", "./x"] }, ctx());
      expect(result.status).toBe("ok");
      await expect(stat(join(dir, "x"))).rejects.toThrow();
      expect(gate.sessionGrants("s-dangerous")).toEqual({
        categories: [],
        shapes: [],
      });

      // Asked again: the grant was not recorded.
      answer = () => ({ approved: false, reason: "no" });
      await runDenied({ cmd: "rm", args: ["-rf", "./y"] });
      expect(asked).toHaveLength(2);
      expect(asked[1]!.category).toBe("shell_dangerous");
    });

    it("level 4 runs ls unasked but still asks before rm -rf; level 5 runs it", async () => {
      gate.setLevel(4);
      await tool().run({ cmd: "ls" }, ctx());
      expect(asked).toHaveLength(0);
      await runDenied({ cmd: "rm", args: ["-rf", "./x"] });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.category).toBe("shell_dangerous");

      gate.setLevel(5);
      const result = await tool().run({ cmd: "rm", args: ["-rf", "./z"] }, ctx());
      expect(result.status).toBe("ok");
      expect(asked).toHaveLength(1);
    });

    it("a dangerous line in a subshell asks as shell_dangerous too", async () => {
      answer = (req) =>
        req.category === "shell"
          ? { approved: true, grant: "category" }
          : { approved: false, reason: "no" };
      await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      await runDenied({ cmd: "cd . && rm -rf ./x" });
      expect(asked).toHaveLength(2);
      expect(asked[1]!.category).toBe("shell_dangerous");
    });
  },
);

describe("isDangerousGuardRule", () => {
  it("matches the dangerous layer's rule ids only", () => {
    expect(isDangerousGuardRule("dangerous.rm_recursive")).toBe(true);
    expect(isDangerousGuardRule("dangerous.git_force_push")).toBe(true);
    expect(isDangerousGuardRule("default")).toBe(false);
    expect(isDangerousGuardRule("hardline.rm_root")).toBe(false);
    expect(isDangerousGuardRule("dangerous")).toBe(false);
  });
});

describe("same-turn denials treat shell_dangerous like shell", () => {
  it("a declined write refuses a dangerous command on that file; a declined dangerous command is not a no to its targets", async () => {
    const asked: ApprovalRequest[] = [];
    const gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: false });
      },
    });
    const base = { sessionId: "s-d", reason: "r" } as const;
    await gate.request({
      ...base,
      tool: "os.fs.write",
      category: "fs_write_workspace",
      targetPaths: ["/t/b"],
    });
    const refused = await gate.request({
      ...base,
      tool: "os.shell.run",
      category: "shell_dangerous",
      preview: "rm -rf /t/b",
      targetPaths: ["/t/b"],
    });
    expect(refused).toMatchObject({ approved: false, declinedEarlier: true });
    expect(asked).toHaveLength(1);

    await gate.request({
      ...base,
      tool: "os.shell.run",
      category: "shell_dangerous",
      preview: "rm -rf /t/a",
      targetPaths: ["/t/a"],
    });
    const trash = await gate.request({
      ...base,
      tool: "os.fs.trash",
      category: "fs_trash",
      targetPaths: ["/t/a"],
    });
    expect(trash.declinedEarlier).toBeUndefined();
    expect(asked).toHaveLength(3);
  });
});
