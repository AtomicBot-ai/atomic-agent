import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { readArgumentAliases } from "../../argument-aliases.js";
import { findUnknownArguments } from "../../unknown-argument-guard.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";
import { ShellJobRegistry } from "./shell-jobs.js";

/**
 * ATO-1259 ("закрой хром" on openrouter/auto): four `os.shell.run` calls
 * reached the tool with no arguments, the model decided "the tool is
 * dropping the `cmd` field", then polled job 1, which never existed.
 * These are the shapes from that session and the ones models send
 * instead of `cmd`.
 */
const ctx: ToolContext = {
  workingDir: tmpdir(),
  sessionId: "shapes",
  stepIndex: 0,
  signal: new AbortController().signal,
};

function tool(jobs = new ShellJobRegistry()) {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return buildOsShellTool({ approvals: gate, approvalRequired: false, jobs });
}

describe("os.shell.run call shapes", () => {
  it("an empty call says the arguments did not arrive, on one line, with an example", async () => {
    const error = await tool().run({}, ctx).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("arrived with no arguments");
    expect(message).toContain('{"cmd":"git status"}');
    expect(message).not.toContain("\n");
  });

  it("a call with other keys but no cmd shows the example in its own shape", async () => {
    const error = (await tool().run({ timeoutMs: 5000, background: false }, ctx).catch((e: Error) => e)) as Error;
    expect(error.message).toContain('{"cmd":"git status","timeoutMs":5000,"background":false}');
    expect(error.message).toContain("`timeoutMs`");
  });

  it("runs an argv sent in cmd", async () => {
    const result = await tool().run({ cmd: ["echo", "argv-in-cmd"] }, ctx);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("argv-in-cmd");
  });

  it.each(["command", "cmdline", "commandLine", "command_line"])(
    "reads `%s` as cmd, and the unknown-argument guard lets it through",
    async (key) => {
      const sent = { [key]: "echo alias-ok", timeoutMs: 10_000 };
      expect(findUnknownArguments("os.shell.run", sent)).toBeNull();
      const reading = readArgumentAliases("os.shell.run", sent);
      expect(reading?.args).toEqual({ cmd: "echo alias-ok", timeoutMs: 10_000 });
      expect(reading?.note).toContain(`read \`${key}\` as \`cmd\``);
      const result = await tool().run(reading!.args, ctx);
      expect(result.summary).toContain("alias-ok");
    },
  );

  it("never lets an alias override or join a cmd that was given", () => {
    expect(readArgumentAliases("os.shell.run", { cmd: "ls", command: "rm -rf x" })).toBeNull();
    expect(findUnknownArguments("os.shell.run", { cmd: "ls", command: "rm -rf x" })).not.toBeNull();
    expect(readArgumentAliases("os.shell.run", { command: "a", cmdline: "b" })).toBeNull();
  });

  it.each([[{ wait: 1 }], [{ kill: 1 }]])(
    "%j for a job that never existed says so plainly and not to poll again",
    async (call) => {
      const result = await tool().run(call, ctx);
      expect(result.status).toBe("error");
      expect(result.summary).toContain("unknown job 1 in this session; this session has no jobs now");
      expect(result.summary).toContain("do not poll for it again");
      expect(result.details).toMatchObject({ unknownJob: true, jobIds: [] });
    },
  );
});
