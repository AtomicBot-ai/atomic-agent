import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { recoverMissingShellCmd } from "./recover-missing-cmd.js";
import { buildOsShellTool } from "./shell.js";

describe("recoverMissingShellCmd (#901)", () => {
  it("reads a `-c` shell tail as the command line", () => {
    expect(
      recoverMissingShellCmd({ args: ["-c", "grep -rn foo src | head"], timeoutMs: 60_000 }),
    ).toEqual({ cmd: "grep -rn foo src | head", args: [] });
  });

  it("reads a leading program token as `cmd`", () => {
    expect(recoverMissingShellCmd({ args: ["git", "status", "--short"] })).toEqual({
      cmd: "git",
      args: ["status", "--short"],
    });
  });

  it("accepts args double-serialised into a JSON string", () => {
    expect(recoverMissingShellCmd({ args: '["ls","-la"]' })).toEqual({
      cmd: "ls",
      args: ["-la"],
    });
  });

  it("treats an empty `cmd` like a missing one", () => {
    expect(recoverMissingShellCmd({ cmd: "", args: ["pwd"] })).toEqual({
      cmd: "pwd",
      args: [],
    });
  });

  it("leaves a call that already names `cmd` alone", () => {
    expect(recoverMissingShellCmd({ cmd: "ls", args: ["-la"] })).toBeNull();
  });

  it("does not guess when the args are ambiguous or empty", () => {
    expect(recoverMissingShellCmd({})).toBeNull();
    expect(recoverMissingShellCmd({ args: [] })).toBeNull();
    expect(recoverMissingShellCmd({ args: [""] })).toBeNull();
    expect(recoverMissingShellCmd({ args: ["-la", "./src"] })).toBeNull();
    expect(recoverMissingShellCmd({ args: ["-c"] })).toBeNull();
    expect(recoverMissingShellCmd({ args: ["-c", "  "] })).toBeNull();
    expect(recoverMissingShellCmd({ args: ["-c", "ls", "extra"] })).toBeNull();
    expect(recoverMissingShellCmd({ args: "not json" })).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")(
  "os.shell.run runs a call that omitted `cmd` (#901)",
  () => {
    function approvingTool() {
      const gate = new ApprovalGate({
        emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
      });
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    function ctx(): ToolContext {
      return {
        workingDir: tmpdir(),
        sessionId: "test-session",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    it("runs the `-c` tail and says how it read the call", async () => {
      const result = await approvingTool().run(
        { args: ["-c", "echo recovered-901 | tr a-z A-Z"], timeoutMs: 10_000 },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("RECOVERED-901");
      expect(result.summary).toContain("the call had no `cmd`");
    });

    it("runs a program named as the first arg", async () => {
      const result = await approvingTool().run({ args: ["echo", "argv-901"] }, ctx());
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("argv-901");
      expect(result.summary).toContain('{"cmd":"echo","args":["argv-901"]}');
    });

    it("still refuses a call with nothing to recover, naming what `cmd` is", async () => {
      await expect(
        approvingTool().run({ args: ["-la"], timeoutMs: 1_000 }, ctx()),
      ).rejects.toThrow(/`cmd` must be a non-empty string: it names the program/);
    });
  },
);
