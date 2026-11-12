import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalGate,
  canGrantCategory,
  canGrantShape,
  type ApprovalRequest,
} from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-1172 (with ATO-1263): "allow shell for this session" and an `[a]`
 * grant on `git` still ask before the commands that delete or overwrite
 * work the guard used to read as ordinary. Every one of them asks as
 * `shell_dangerous`, with no shape and nothing to remember. The emitter
 * denies, so nothing here runs.
 */
describe.skipIf(process.platform === "win32")(
  "os.shell.run: a session grant does not cover the remaining destructive commands (ATO-1172)",
  () => {
    let dir: string;
    let asked: ApprovalRequest[];
    let gate: ApprovalGate;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-grant-holes-"));
      asked = [];
      gate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          asked.push(req);
          // Grant the first ordinary call for the whole session (or the
          // `git` shape); refuse anything else.
          if (req.category === "shell") {
            gate.resolve({
              approvalId: req.approvalId,
              approved: true,
              grant: req.commandShape === "git" ? "shape" : "category",
            });
          } else {
            gate.resolve({ approvalId: req.approvalId, approved: false, reason: "no" });
          }
        },
      });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function ctx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "s-holes",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool() {
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    const direct: readonly (readonly [string, readonly string[]])[] = [
      ["git", ["push", "origin", ":main"]],
      ["git", ["push", "--delete", "origin", "feature"]],
      ["git", ["push", "--mirror", "backup"]],
      ["git", ["push", "--prune", "origin"]],
      ["git", ["checkout", "-f", "main"]],
      ["git", ["switch", "--discard-changes", "main"]],
      ["git", ["stash", "drop"]],
      ["git", ["stash", "clear"]],
      ["git", ["-c", "clean.requireForce=false", "clean", "-d"]],
    ];

    it.each(direct)("%s %j asks as shell_dangerous after a shell grant", async (cmd, args) => {
      await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      expect(gate.sessionGrants("s-holes").categories).toEqual(["shell"]);
      await expect(tool().run({ cmd, args: [...args] }, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
      const last = asked.at(-1)!;
      expect(last.category).toBe("shell_dangerous");
      expect(last.commandShape).toBeUndefined();
      expect(canGrantCategory(last)).toBe(false);
      expect(canGrantShape(last)).toBe(false);
    });

    it("a git shape grant does not cover git stash drop", async () => {
      await tool().run({ cmd: "git", args: ["log", "-1"] }, ctx());
      expect(gate.sessionGrants("s-holes").shapes).toEqual(["git"]);
      await expect(
        tool().run({ cmd: "git", args: ["stash", "drop"] }, ctx()),
      ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
      expect(asked.at(-1)!.category).toBe("shell_dangerous");
    });

    it.each([
      "find . -name '*.log' | xargs rm",
      "git push $(echo -f) origin main",
      "m=hard; git reset --$m HEAD~1",
      "g=git; $g push -f",
      "ls | xargs --replace rm {}",
      'cd . && bash -c "$(echo ls)"',
    ])("subshell line %s asks as shell_dangerous after a shell grant", async (line) => {
      await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      await expect(tool().run({ cmd: line }, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
      expect(asked.at(-1)!.category).toBe("shell_dangerous");
    });

    it("ordinary commands still ride the grant", async () => {
      await tool().run({ cmd: "ls", args: ["./"] }, ctx());
      await tool().run({ cmd: "git", args: ["log", "-1"] }, ctx());
      await tool().run({ cmd: "chmod", args: ["-r", join(dir, "nothing-here")] }, ctx()).catch(() => undefined);
      expect(asked.filter((r) => r.category === "shell_dangerous")).toHaveLength(0);
    });
  },
);
