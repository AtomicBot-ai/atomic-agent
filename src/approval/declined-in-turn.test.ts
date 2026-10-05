import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOsFsWriteTool } from "../tools/os/fs-write.js";
import { buildOsShellTool } from "../tools/os/shell.js";
import type { ToolContext } from "../tools/tool-registry.js";
import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./approval-gate.js";

/**
 * ATO-225: the user pressed Deny on `os.fs.write test10.txt`, and the
 * model asked for the same write three more times, then tried it with
 * `printf … >`, `echo … >` and `sh -c "echo … > …/test10.txt"`. The
 * gate asked the user every time. Now a repeat in the same turn, or a
 * shell write into the declined file, is refused without a prompt and
 * reads to the model as a refusal standing on the user's no.
 */
describe("a call the user declined is not asked again in the same turn", () => {
  let dir: string;
  let gate: ApprovalGate;
  let prompts: ApprovalRequest[];
  /** Answers for the next prompts, in order; a bare Deny when empty. */
  let answers: Omit<ApprovalDecision, "approvalId">[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "declined-in-turn-"));
    prompts = [];
    answers = [];
    gate = new ApprovalGate({
      level: 1,
      emit: (request) => {
        prompts.push(request);
        const answer = answers.shift() ?? { approved: false };
        queueMicrotask(() =>
          gate.resolve({ approvalId: request.approvalId, ...answer }),
        );
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (sessionId = "s-1"): ToolContext => ({
    workingDir: dir,
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  });
  const write = (path: string, content: string, sessionId?: string) =>
    buildOsFsWriteTool({ approvals: gate, approvalRequired: true }).run(
      { path, content },
      ctx(sessionId),
    );
  const shell = (args: Record<string, unknown>) =>
    buildOsShellTool({ approvals: gate, approvalRequired: true }).run(
      args,
      ctx(),
    );

  it("refuses the same call again without asking, as a refusal standing on the user's no", async () => {
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      name: "ApprovalDeniedError",
      byUser: true,
    });
    const again = write("test10.txt", "привет");
    await expect(again).rejects.toMatchObject({
      name: "ApprovalDeniedError",
      byUser: false,
      declinedEarlier: true,
    });
    await expect(again).rejects.toThrow(
      "os.fs.write was not run: refused without a decision from the user. " +
        "Reason: the user already declined this same call earlier in this turn. " +
        "Do not try it again or another way to do the same thing; " +
        "tell the user it was not done and ask what they would like instead.",
    );
    expect(prompts).toHaveLength(1);
    expect(existsSync(join(dir, "test10.txt"))).toBe(false);
  });

  it("refuses a write of the same file with other content, and a level that would allow it", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    await expect(write("./test10.txt", "hello")).rejects.toMatchObject({
      declinedEarlier: true,
    });
    // Auto-approval is no way round the user's no either.
    gate.setLevel(5);
    await expect(write("test10.txt", "hello")).rejects.toMatchObject({
      declinedEarlier: true,
    });
    expect(prompts).toHaveLength(1);
    expect(existsSync(join(dir, "test10.txt"))).toBe(false);
  });

  it("refuses a shell command that redirects into the declined file, whatever the route", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    const target = join(dir, "test10.txt");
    for (const args of [
      { cmd: "printf %s привет > test10.txt" },
      { cmd: "echo", args: ["привет", ">", "test10.txt"] },
      { cmd: "sh", args: ["-c", `echo привет > ${target}`] },
      { cmd: `cd .. && touch ${basename(dir)}/test10.txt` },
    ]) {
      const refused = shell(args);
      await expect(refused).rejects.toMatchObject({
        name: "ApprovalDeniedError",
        byUser: false,
        declinedEarlier: true,
      });
      await expect(refused).rejects.toThrow(
        `the user already declined os.fs.write on ${target} earlier in this turn`,
      );
    }
    expect(prompts).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  it("still asks for a call that does not change the declined file", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    // Reading the declined file into another one, and another file.
    await expect(shell({ cmd: "cat test10.txt > copy.txt" })).rejects.toMatchObject({
      byUser: true,
    });
    answers.push({ approved: true });
    await write("other.txt", "fine");
    expect(prompts.map((p) => p.tool)).toEqual([
      "os.fs.write",
      "os.shell.run",
      "os.fs.write",
    ]);
    expect(await readFile(join(dir, "other.txt"), "utf8")).toBe("fine");
  });

  it("asks again in the next turn", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    // What the agent loop does when a turn starts (and on a steer).
    gate.forgetDeclined("s-1");
    answers.push({ approved: true });
    await write("test10.txt", "привет");
    expect(prompts).toHaveLength(2);
    expect(await readFile(join(dir, "test10.txt"), "utf8")).toBe("привет");
  });

  it("after a typed reply refuses only the identical call", async () => {
    answers.push({ approved: false, reason: "back it up first" });
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      byUser: true,
    });
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      declinedEarlier: true,
    });
    // What they said may make a later write of the same file the very
    // thing they asked for, so that one is theirs to answer.
    answers.push({ approved: true });
    await write("test10.txt", "привет, again");
    expect(prompts).toHaveLength(2);
  });

  it("is stopped by nothing nobody decided, and by nothing in another session", async () => {
    answers.push({ approved: false, automatic: true, reason: "timed out" });
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      byUser: false,
    });
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      byUser: true,
    });
    answers.push({ approved: true });
    await write("test10.txt", "привет", "s-2");
    expect(prompts.map((p) => p.sessionId)).toEqual(["s-1", "s-1", "s-2"]);
  });
});
