import { afterEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { NodePtyModule, NodePtySpawnOptions } from "../../../native/load-node-pty.js";
import type { ToolContext } from "../../tool-registry.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2484: with the pty binding loaded, `tty: true` runs the program
 * on node-pty (ConPTY on Windows) instead of `script(1)` or pipes, and
 * `write` types into that terminal.
 */

const SESSION = "pty-backend";

/** A pty whose program answers each typed line with `=> <line>`. */
function echoingPty() {
  const spawned: Array<{ file: string; options: NodePtySpawnOptions }> = [];
  const typed: string[] = [];
  const module: NodePtyModule = {
    spawn(file, _args, options) {
      spawned.push({ file, options });
      let data: (text: string) => void = () => undefined;
      return {
        pid: 31337,
        cols: 0,
        rows: 0,
        onData(listener) {
          data = listener;
          setTimeout(() => data(">>> "), 5);
          return { dispose: () => undefined };
        },
        onExit: () => ({ dispose: () => undefined }),
        write(text) {
          typed.push(text);
          setTimeout(() => data(`=> ${text.trim()}\r\n>>> `), 5);
        },
        resize: () => undefined,
        kill: () => undefined,
      };
    },
  };
  return { module, spawned, typed };
}

describe("os.shell.run tty on node-pty (ATO-2484)", () => {
  let jobs: ShellJobRegistry;

  afterEach(() => {
    jobs?.endAll();
  });

  function ctx(): ToolContext {
    return { workingDir: process.cwd(), sessionId: SESSION, stepIndex: 0, signal: new AbortController().signal };
  }

  it("starts the program itself on the pty and types into it", async () => {
    jobs = new ShellJobRegistry();
    const pty = echoingPty();
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const shell = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      defaultTimeoutMs: 5_000,
      jobs,
      backgroundSettleMs: 100,
      sandbox: () => ({ mode: "off", network: true }),
      loadPty: () => pty.module,
    });
    const started = await shell.run({ cmd: "python3", tty: true }, ctx());
    expect(started.summary).toContain("interactive job 1 on a terminal");
    expect(pty.spawned).toHaveLength(1);
    // not the script(1) relay: the program is spawned directly
    expect(pty.spawned[0]!.file).not.toBe("/bin/sh");
    expect(pty.spawned[0]!.file).not.toBe("/usr/bin/script");
    expect(pty.spawned[0]!.options.name).toBe("dumb");
    const reply = await shell.run({ write: 1, text: "2**100\n", timeoutMs: 2_000 }, ctx());
    expect(pty.typed).toEqual(["2**100\r"]);
    expect(reply.summary).toContain("=> 2**100");
    const record = jobs.list(SESSION)[0]!;
    // the hook a terminal view resizes through (ATO-2485)
    expect("resize" in record.job).toBe(true);
  });
});
