import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { guardTypedText, stripTerminalCodes } from "./shell-job-write.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2277: `tty: true` starts an interactive kept job that
 * `{"write": id, "text"}` types into; every write passes the guard and
 * asks like a command.
 */

const SESSION = "write-session";

describe("guardTypedText", () => {
  it("takes the strictest verdict over the lines; blank text has none", () => {
    expect(guardTypedText("\n  \n", "/tmp")).toBeNull();
    expect(guardTypedText("ls\nrm -rf /\n", "/tmp")?.action).toBe("block");
    expect(guardTypedText("2**100\n", "/tmp")?.action).toBe("approval_required");
    const dangerous = guardTypedText("ls\ngit reset --hard\n", "/tmp");
    expect(dangerous?.rule.startsWith("dangerous.")).toBe(true);
  });
});

describe("stripTerminalCodes", () => {
  it("drops colour codes and carriage returns", () => {
    expect(stripTerminalCodes("\u001b[1;32mok\u001b[0m\r\n>>> ")).toBe("ok\n>>> ");
  });
});

describe.skipIf(process.platform === "win32")("os.shell.run tty + write (ATO-2277)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;
  let asked: ApprovalRequest[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-write-"));
    jobs = new ShellJobRegistry();
    asked = [];
  });

  afterEach(async () => {
    jobs.endAll();
    await rm(dir, { recursive: true, force: true });
  });

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    return buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      defaultTimeoutMs: 5_000,
      jobs,
      backgroundSettleMs: 300,
    });
  }

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: SESSION, stepIndex: 0, signal: new AbortController().signal };
  }

  it("keeps a shell open between writes: state survives, the reply comes back", async () => {
    const shell = tool();
    const started = await shell.run({ cmd: "sh", tty: true }, ctx());
    expect(started.status).toBe("ok");
    expect(started.details).toMatchObject({ detached: true, jobId: 1, keep: true });
    expect(started.summary).toContain("interactive job 1");
    const first = await shell.run({ write: 1, text: "X=41; cd /\n" }, ctx());
    expect(first.status).toBe("ok");
    const second = await shell.run({ write: 1, text: "echo $((X+1)) $(pwd)\n", timeoutMs: 5_000 }, ctx());
    expect(second.summary).toContain("42 /");
    expect(second.details).toMatchObject({ write: true, jobId: 1 });
    // each write asked like a command, with the typed text as the preview
    const writes = asked.filter((req) => req.reason.startsWith("type into job 1"));
    expect(writes.length).toBe(2);
    expect(writes[1]!.preview).toBe(JSON.stringify("echo $((X+1)) $(pwd)\n"));
    const done = await shell.run({ write: 1, text: "exit 3\n" }, ctx());
    expect(done.details).toMatchObject({ exitCode: 3, jobId: 1 });
    expect(jobs.list(SESSION)).toEqual([]);
  });

  it("refuses a hardline line before anything is typed", async () => {
    const shell = tool();
    await shell.run({ cmd: "sh", tty: true }, ctx());
    const result = await shell.run({ write: 1, text: "rm -rf /\n" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("blocked by shell guard");
    expect(jobs.list(SESSION)[0]?.state).toBe("running");
  });

  it("a job started without tty takes no input; an unknown id is unknown", async () => {
    const shell = tool();
    await shell.run({ cmd: "sleep 30", background: true }, ctx());
    const refused = await shell.run({ write: 1, text: "y\n" }, ctx());
    expect(refused.status).toBe("error");
    expect(refused.summary).toContain('start it with {"cmd": …, "tty": true}');
    const unknown = await shell.run({ write: 9, text: "y\n" }, ctx());
    expect(unknown.summary).toContain("unknown job 9");
  });

  it("eof closes the input: cat ends", async () => {
    const shell = tool();
    await shell.run({ cmd: "cat", tty: true }, ctx());
    const result = await shell.run({ write: 1, text: "hello\n", eof: true, timeoutMs: 5_000 }, ctx());
    expect(result.summary).toContain("hello");
  });
});
