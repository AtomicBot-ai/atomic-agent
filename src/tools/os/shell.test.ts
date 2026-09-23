import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsShellTool, isOpaqueInterpreterShape } from "./shell.js";

function approvingTool(defaultTimeoutMs?: number) {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return buildOsShellTool({
    approvals: gate,
    approvalRequired: true,
    ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
  });
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} survived the timeout kill`);
}

describe("os.shell.run describes its timeout (F47)", () => {
  it("states the configured default and how to override it", () => {
    expect(approvingTool(600_000).description).toContain(
      "default 10 min — a command still running then is not killed but detached as a job",
    );
  });

  it("says there is no timeout when none is configured", () => {
    expect(approvingTool(0).description).toContain("no timeout");
    expect(approvingTool().description).toContain("no timeout");
  });
});

// The default timeout detaches rather than kills; that path is pinned in
// shell-detach.test.ts. Here: an explicit `timeoutMs` still kills.
describe.skipIf(process.platform === "win32")(
  "os.shell.run explicit timeoutMs (F47)",
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-timeout-"));
    });

    afterEach(async () => {
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

    it("an explicit timeoutMs of 0 disables the default", async () => {
      const result = await approvingTool(300).run(
        { cmd: "sleep", args: ["1"], timeoutMs: 0 },
        makeCtx(),
      );
      expect(result.status).toBe("ok");
      expect(result.details.timedOut).toBe(false);
      expect(result.details.source).toBeUndefined();
    });

    it("an explicit timeoutMs wins over the default, and the text says so", async () => {
      const result = await approvingTool(30_000).run(
        { cmd: "sleep", args: ["30"], timeoutMs: 300 },
        makeCtx(),
      );
      expect(result.status).toBe("error");
      expect(result.details.timedOut).toBe(true);
      expect(result.details.timeoutMs).toBe(300);
      expect(result.details.source).toBe("explicit");
      expect(result.summary).toContain("stopped after 0.3 s (timeoutMs)");
      expect(result.summary).not.toContain("default timeout");
    });

    it("kills the whole process group, not just the shell", async () => {
      const pidFile = join(dir, "background.pid");
      // The `&` routes this through `sh -c`. The background sleep is the
      // shell's child: a kill aimed at the shell alone leaves it running
      // for 30 s, holding stdout open — and the result with it.
      // 1.5 s: long enough for the shell to have run `echo` on a loaded
      // host; the kill itself is what is measured, not the fuse.
      const result = await approvingTool(600_000).run(
        { cmd: `sleep 30 & echo $! > "${pidFile}"; sleep 30`, timeoutMs: 1_500 },
        makeCtx(),
      );
      expect(result.details.timedOut).toBe(true);
      expect(result.details.source).toBe("explicit");
      expect(result.details.durationMs).toBeLessThan(5_000);
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(pid).toBeGreaterThan(0);
      await waitForExit(pid);
    });

    it("keeps the output captured before the stop", async () => {
      const result = await approvingTool(600_000).run(
        { cmd: "echo partial; sleep 30", timeoutMs: 1_500 },
        makeCtx(),
      );
      expect(result.details.timedOut).toBe(true);
      expect(result.summary).toContain("partial");
    });
  },
);

describe("isOpaqueInterpreterShape (shape-grant suppression)", () => {
  it("withholds [a] for shell interpreters whose danger lives in their args", () => {
    // `bash -c "<anything>"` and friends: the binary name hides what
    // runs, so a shape grant on them would silence arbitrary code.
    for (const shape of ["bash", "sh", "zsh", "dash", "ksh"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(true);
    }
  });

  it("allows [a] for ordinary binaries the shape name fully describes", () => {
    for (const shape of ["git", "npm", "ls", "cat", "curl", "rm", "docker"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(false);
    }
  });
});

describe("os.shell.run says when it ran with no arguments (F40)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-bare-"));
  });

  afterEach(async () => {
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

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildOsShellTool({ approvals: gate, approvalRequired: true });
  }

  it("notes a bare invocation when args is absent", async () => {
    // The live case was `python3` with its script under an unknown key:
    // exit 0, nothing done, and nothing in the output said so.
    const result = await tool().run({ cmd: "echo" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("$ echo (ran with no arguments)\nexit: 0");
  });

  it("notes a bare invocation when args is empty", async () => {
    const result = await tool().run({ cmd: "echo", args: [] }, makeCtx());
    expect(result.summary).toContain("$ echo (ran with no arguments)");
  });

  it("stays silent when arguments were passed", async () => {
    const result = await tool().run({ cmd: "echo", args: ["hi"] }, makeCtx());
    expect(result.summary).toContain("$ echo hi\nexit: 0");
    expect(result.summary).not.toContain("ran with no arguments");
  });

  it("stays silent on the subshell path, where the arguments live in cmd", async () => {
    const result = await tool().run({ cmd: "echo hi | cat" }, makeCtx());
    expect(result.summary).toContain("hi");
    expect(result.summary).not.toContain("ran with no arguments");
  });
});
