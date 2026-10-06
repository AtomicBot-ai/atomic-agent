import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOsFsEditTool } from "../tools/os/fs/fs-edit.js";
import { buildOsFsTrashTool } from "../tools/os/fs/fs-trash.js";
import { buildOsFsWriteTool } from "../tools/os/fs/fs-write.js";
import { buildOsShellTool } from "../tools/os/shell/shell.js";
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
 * reads to the model as the user's no. A false refusal is the worse
 * mistake, so everything the gate cannot tie to a bare Deny still asks.
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
  const edit = (path: string, oldString: string, newString: string) =>
    buildOsFsEditTool({ approvals: gate, approvalRequired: true }).run(
      { path, oldString, newString },
      ctx(),
    );
  const trash = (path: string) =>
    buildOsFsTrashTool({ approvals: gate, approvalRequired: true }).run(
      { paths: [path] },
      ctx(),
    );

  it("refuses the same call again without asking, in words that say the user declined it", async () => {
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
    // Not "refused without a decision": that reads as a system block to
    // work around (ATO-245).
    await expect(again).rejects.toThrow(
      "os.fs.write was not run: the user already declined this same call " +
        "earlier in this turn, so it was not asked again. " +
        "Do not try it again or another way; " +
        "tell the user it was not done and ask what they would like instead.",
    );
    await expect(again).rejects.not.toThrow("without a decision");
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
      { cmd: 'echo "привет" > test10.txt' },
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
        `os.shell.run was not run: the user already declined os.fs.write on ${target} ` +
          "(this call would change that file too) earlier in this turn",
      );
    }
    expect(prompts).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  it("still asks for a call that does not change the declined file", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    // Reading the declined file into another one; commands that only
    // mention it; a direct exec whose `>` is an argument, not a redirect.
    for (const args of [
      { cmd: "cat test10.txt > copy.txt" },
      { cmd: 'grep -n "<title>" test10.txt' },
      { cmd: 'grep -E "error|rm" test10.txt' },
      { cmd: "cat > notes.md <<'EOF'\ncp other.txt test10.txt\nEOF" },
      { cmd: "echo", args: ["привет", ">", "test10.txt"] },
    ]) {
      await expect(shell(args)).rejects.toMatchObject({ byUser: true });
    }
    answers.push({ approved: true });
    await write("other.txt", "fine");
    expect(prompts.map((p) => p.tool)).toEqual([
      "os.fs.write",
      "os.shell.run",
      "os.shell.run",
      "os.shell.run",
      "os.shell.run",
      "os.shell.run",
      "os.fs.write",
    ]);
    expect(await readFile(join(dir, "other.txt"), "utf8")).toBe("fine");
    expect(existsSync(join(dir, "test10.txt"))).toBe(false);
  });

  it("a no to one edit of a file is not a no to a different edit of it", async () => {
    await writeFile(join(dir, "page.html"), "<h1>old</h1>\n<p>body</p>\n");
    await expect(edit("page.html", "old", "new")).rejects.toMatchObject({
      byUser: true,
    });
    // The same hunk again is the same call…
    await expect(edit("page.html", "old", "new")).rejects.toMatchObject({
      declinedEarlier: true,
    });
    // …a different one is a new question, at any level.
    gate.setLevel(5);
    await edit("page.html", "body", "text");
    gate.setLevel(1);
    answers.push({ approved: true });
    await write("page.html", "<h1>rewritten</h1>\n");
    expect(prompts).toHaveLength(2);
    expect(await readFile(join(dir, "page.html"), "utf8")).toBe(
      "<h1>rewritten</h1>\n",
    );
  });

  it("a declined trash blocks a shell remove of the file, not an edit of it", async () => {
    await writeFile(join(dir, "keep.txt"), "one\n");
    await expect(trash("keep.txt")).rejects.toMatchObject({ byUser: true });
    await expect(shell({ cmd: "rm -f keep.txt" })).rejects.toMatchObject({
      declinedEarlier: true,
    });
    answers.push({ approved: true });
    await edit("keep.txt", "one", "two");
    expect(prompts.map((p) => p.tool)).toEqual(["os.fs.trash", "os.fs.edit"]);
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("two\n");
  });

  it("holds a fusion worker to what the user declined on its orchestrator's turn, inside its fan-out scope too", async () => {
    await expect(write("test10.txt", "привет")).rejects.toThrow();
    // What `worker-runner.ts` sets up for a worker of session s-1.
    const worker = "s-w-1";
    gate.setSessionPolicy(worker, { onPrompt: "refuse", reason: "no operator" });
    gate.fanoutScopes.grant(worker, [dir]);
    gate.followDeclined(worker, "s-1");
    const workerShell = buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
    }).run({ cmd: "printf %s привет > test10.txt" }, ctx(worker));
    await expect(workerShell).rejects.toMatchObject({ declinedEarlier: true });
    await expect(write("test10.txt", "hello", worker)).rejects.toMatchObject({
      declinedEarlier: true,
    });
    // Any other file in the scope is still the fan-out's to write.
    await write("other.txt", "fine", worker);
    expect(prompts).toHaveLength(1);
    expect(existsSync(join(dir, "test10.txt"))).toBe(false);
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

  it("after a typed reply refuses nothing, not even the identical call", async () => {
    // A host may deliver the words as a steer the loop drains only at
    // the next step: "yes, go ahead" must not meet an automatic refusal.
    answers.push({ approved: false, reason: "да, давай" });
    await expect(write("test10.txt", "привет")).rejects.toMatchObject({
      byUser: true,
    });
    answers.push({ approved: true });
    await write("test10.txt", "привет");
    expect(prompts).toHaveLength(2);
    expect(await readFile(join(dir, "test10.txt"), "utf8")).toBe("привет");
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
