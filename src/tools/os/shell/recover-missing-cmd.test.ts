import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { compressToolResult, fullToolResult } from "../../../compressor/result-compressor.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  looksLikeScriptCode,
  looksPosixOnly,
  markRecoveredResult,
  missingCmdNotice,
  recoverMissingShellCmd,
} from "./recover-missing-cmd.js";
import { buildOsShellTool } from "./shell.js";

describe("recoverMissingShellCmd (#901)", () => {
  it("reads a `-c` shell tail as the command line", () => {
    expect(
      recoverMissingShellCmd(
        { args: ["-c", "grep -rn foo src | head"], timeoutMs: 60_000 },
        "darwin",
      ),
    ).toEqual({ cmd: "grep -rn foo src | head", args: [], shellLine: true });
  });

  it("reads a leading program token as `cmd`", () => {
    expect(recoverMissingShellCmd({ args: ["git", "status", "--short"] }, "linux")).toEqual({
      cmd: "git",
      args: ["status", "--short"],
      shellLine: false,
    });
  });

  it("accepts args double-serialised into a JSON string", () => {
    expect(recoverMissingShellCmd({ args: '["ls","-la"]' }, "linux")).toEqual({
      cmd: "ls",
      args: ["-la"],
      shellLine: false,
    });
  });

  it("treats an empty or whitespace-only `cmd` like a missing one", () => {
    for (const cmd of ["", "   "]) {
      expect(recoverMissingShellCmd({ cmd, args: ["pwd"] }, "linux")).toEqual({
        cmd: "pwd",
        args: [],
        shellLine: false,
      });
    }
  });

  it("leaves a call that already names `cmd` alone", () => {
    expect(recoverMissingShellCmd({ cmd: "ls", args: ["-la"] }, "linux")).toBeNull();
    expect(recoverMissingShellCmd({ cmd: 3, args: ["ls"] }, "linux")).toBeNull();
  });

  it("does not guess when the args are ambiguous or empty", () => {
    for (const args of [
      undefined,
      [],
      [""],
      ["-la", "./src"],
      ["-c"],
      ["-c", "  "],
      ["-c", "ls", "extra"],
      "not json",
    ]) {
      expect(recoverMissingShellCmd({ args }, "linux")).toBeNull();
    }
  });

  it("refuses a `-c` tail that reads as Python or Node code", () => {
    for (const line of [
      "import os; print(os.getcwd())",
      "from pathlib import Path\nprint(Path('.').resolve())",
      "print('hi')",
      "console.log(process.cwd())",
      "const fs = require('fs'); fs.readdirSync('.')",
    ]) {
      expect(looksLikeScriptCode(line)).toBe(true);
      expect(recoverMissingShellCmd({ args: ["-c", line] }, "linux")).toBeNull();
    }
    for (const line of [
      "ls -la | grep src",
      "git status && git log -1",
      "printf '%s\\n' a b",
      "ls; process.sh",
    ]) {
      expect(looksLikeScriptCode(line)).toBe(false);
    }
  });

  it("reads a plain `-c` tail on Windows, where it runs under cmd.exe /c", () => {
    for (const line of ["git status", "hostname", "pytest -q", "a && b", "git log -1 | more"]) {
      expect(looksPosixOnly(line)).toBe(false);
      expect(
        recoverMissingShellCmd({ args: ["-c", line], timeoutMs: 60_000 }, "win32"),
      ).toEqual({ cmd: line, args: [], shellLine: true });
    }
  });

  it("refuses a `-c` tail on Windows that only a POSIX shell reads as meant", () => {
    for (const line of [
      "echo 'x'",
      "ls $HOME",
      "echo $(pwd)",
      "echo `date`",
      "cat x 2>/dev/null",
      "export A=1",
      "make && export A=1",
      "cd ~/src",
      "ls my\\ dir",
      "cd src; ls",
    ]) {
      expect(looksPosixOnly(line)).toBe(true);
      expect(recoverMissingShellCmd({ args: ["-c", line] }, "win32")).toBeNull();
    }
    expect(recoverMissingShellCmd({ args: ["-c", "print('x')"] }, "win32")).toBeNull();
  });

  it("keeps reading the same `-c` tails on Linux and macOS as before", () => {
    for (const line of ["echo 'x'", "ls $HOME", "cat x 2>/dev/null", "export A=1", "git status"]) {
      for (const platform of ["linux", "darwin"] as const) {
        expect(recoverMissingShellCmd({ args: ["-c", line] }, platform)).toEqual({
          cmd: line,
          args: [],
          shellLine: true,
        });
      }
    }
  });

  it("treats a leading `/x` switch as ambiguous on Windows only", () => {
    expect(recoverMissingShellCmd({ args: ["/c", "dir"] }, "win32")).toBeNull();
    expect(recoverMissingShellCmd({ args: ["/s", "x"] }, "win32")).toBeNull();
    expect(recoverMissingShellCmd({ args: ["dir", "/b"] }, "win32")).toEqual({
      cmd: "dir",
      args: ["/b"],
      shellLine: false,
    });
    expect(recoverMissingShellCmd({ args: ["/usr/bin/git", "status"] }, "linux")).toEqual({
      cmd: "/usr/bin/git",
      args: ["status"],
      shellLine: false,
    });
  });
});

function ctx(): ToolContext {
  return {
    workingDir: tmpdir(),
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function approvingTool() {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return buildOsShellTool({ approvals: gate, approvalRequired: true });
}

describe("missingCmdNotice (#901)", () => {
  const line = (cmd: string) => ({ cmd, args: [], shellLine: true });

  it("names the shell the `-c` line went to on each OS", () => {
    expect(missingCmdNotice(line("git status"), true, "linux")).toContain(
      'ran the `-c` line as a shell command line (sh -c): "git status"',
    );
    expect(missingCmdNotice(line("git status"), true, "darwin")).toContain("(sh -c)");
    const win = missingCmdNotice(line("git status"), true, "win32");
    expect(win).toContain('ran the `-c` line as a shell command line (cmd.exe /c): "git status"');
    expect(win).not.toContain("sh -c");
  });

  it("says a `-c` line that needed no shell ran directly", () => {
    for (const platform of ["linux", "win32"] as const) {
      const ran = missingCmdNotice(line("hostname"), true, platform);
      expect(ran).toContain('ran it directly (no shell needed): "hostname"');
      expect(ran).not.toMatch(/sh -c|cmd\.exe/);
      expect(missingCmdNotice(line("hostname"), false, platform)).toContain(
        'read the `-c` line as one program to run directly (no shell needed): "hostname"',
      );
    }
  });

  it("keeps the argv wording for a program named as the first arg", () => {
    expect(
      missingCmdNotice({ cmd: "git", args: ["status"], shellLine: false }, true, "win32"),
    ).toContain('ran it as {"cmd":"git","args":["status"]}');
  });
});

describe("markRecoveredResult (#901)", () => {
  it("marks a compressed result without redefining its fixed fullOutput", () => {
    const compressed = compressToolResult({
      tool: "os.shell.run",
      status: "ok",
      output: "line one\nline two",
      details: { exitCode: 0 },
    });
    const marked = markRecoveredResult(compressed, { cmd: "ls", args: [], shellLine: false });
    expect(marked.details.recoveredMissingCmd).toBe("argv");
    expect(marked.summary).toContain("the call had no `cmd`");
    expect(Object.keys(marked)).not.toContain("fullOutput");
    const full = fullToolResult(marked);
    expect(full.summary.startsWith("line one\nline two\n")).toBe(true);
    expect(full.summary).toContain("the call had no `cmd`");
    expect(compressed.details.recoveredMissingCmd).toBeUndefined();
  });

  it("uses the platform it is given for the notice", () => {
    const compressed = compressToolResult({
      tool: "os.shell.run",
      status: "ok",
      output: "ok",
      details: { exitCode: 0 },
    });
    const marked = markRecoveredResult(
      compressed,
      { cmd: "git status", args: [], shellLine: true },
      "win32",
    );
    expect(marked.summary).toContain("(cmd.exe /c)");
    expect(fullToolResult(marked).summary).toContain("(cmd.exe /c)");
  });
});

describe("a recovered call still goes through the guard and approval (#901)", () => {
  it("asks for approval with the reconstructed argv, and says so in the reason", async () => {
    const requests: Array<{ preview: string; reason: string }> = [];
    const gate = new ApprovalGate({
      emit: (req) => {
        requests.push({ preview: req.preview ?? "", reason: req.reason });
        gate.reject(req.approvalId, "not now");
      },
    });
    const tool = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => true },
    });
    await expect(tool.run({ args: ["git", "push"] }, ctx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.preview).toBe("git push");
    expect(requests[0]!.reason).toContain("reconstructed from args");
  });

  it("blocks a recovered `-c` line the guard blocks", async () => {
    const tool = buildOsShellTool({
      approvals: new ApprovalGate({ emit: () => undefined }),
      approvalRequired: true,
      shellPolicy: { isGitRemoteSyncEnabled: () => false },
    });
    const call = { args: ["-c", "git fetch --all && git pull"] };
    const result = await tool.run(call, ctx());
    expect(result.status).toBe("error");
    expect(result.details.guardRule).toBe("policy.git_remote_sync_off");
    expect(result.details.cmd).toBe("git fetch --all && git pull");
    expect(result.details.recoveredMissingCmd).toBe("shell_line");
    expect(result.summary).toContain("reconstructed from args and read the `-c` line");
    expect(result.summary).not.toContain("and ran ");
  });

  it.skipIf(process.platform === "win32")(
    "previews a recovered `-c` line as the line itself",
    async () => {
      const previews: string[] = [];
      const gate = new ApprovalGate({
        emit: (req) => {
          previews.push(req.preview ?? "");
          gate.reject(req.approvalId, "not now");
        },
      });
      const tool = buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        shellPolicy: { isGitRemoteSyncEnabled: () => true },
      });
      await expect(
        tool.run({ args: ["-c", "git fetch --all && git pull"] }, ctx()),
      ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
      expect(previews).toEqual(["git fetch --all && git pull"]);
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "os.shell.run runs a call that omitted `cmd` (#901)",
  () => {
    it("runs the `-c` tail and says after the output how it read the call", async () => {
      const result = await approvingTool().run(
        { args: ["-c", "echo recovered-901 | tr a-z A-Z"], timeoutMs: 10_000 },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("RECOVERED-901");
      expect(result.summary).toContain("ran the `-c` line as a shell command line (sh -c)");
      expect(result.details.recoveredMissingCmd).toBe("shell_line");
    });

    it("keeps the notice when the output is long enough to be cut", async () => {
      const result = await approvingTool().run(
        { args: ["-c", "seq 1 2000"], timeoutMs: 10_000 },
        ctx(),
      );
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("2000");
      expect(result.summary.trimEnd().endsWith("its arguments in `args`.")).toBe(true);
    });

    it("keeps the notice in the full output cloud mode shows", async () => {
      const result = await approvingTool().run(
        { args: ["-c", "seq 1 2000"], timeoutMs: 10_000 },
        ctx(),
      );
      const full = fullToolResult(result);
      expect(full.summary).not.toBe(result.summary);
      expect(full.summary).toContain("\n1000\n");
      expect(full.summary.trimEnd().endsWith("its arguments in `args`.")).toBe(true);
      expect(Object.keys(result)).not.toContain("fullOutput");
    });

    it("leaves a call that named `cmd` unmarked", async () => {
      const result = await approvingTool().run({ cmd: "echo", args: ["named-901"] }, ctx());
      expect(result.status).toBe("ok");
      expect(result.details.recoveredMissingCmd).toBeUndefined();
      expect(result.summary).not.toContain("the call had no `cmd`");
      expect(fullToolResult(result).summary).not.toContain("the call had no `cmd`");
    });

    it("runs a program named as the first arg", async () => {
      const result = await approvingTool().run({ args: ["echo", "argv-901"] }, ctx());
      expect(result.status).toBe("ok");
      expect(result.summary).toContain("argv-901");
      expect(result.summary).toContain('{"cmd":"echo","args":["argv-901"]}');
      expect(result.details.recoveredMissingCmd).toBe("argv");
    });

    it("still refuses a call with nothing to recover, saying what `cmd` is", async () => {
      await expect(
        approvingTool().run({ args: ["-la"], timeoutMs: 1_000 }, ctx()),
      ).rejects.toThrow(/`cmd` must be a non-empty string \(got no `cmd` with `args`, `timeoutMs`\): put the program/);
      await expect(
        approvingTool().run({ args: ["-c", "print('x')"] }, ctx()),
      ).rejects.toThrow(/`cmd` must be a non-empty string/);
    });
  },
);
