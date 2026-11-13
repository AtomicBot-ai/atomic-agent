import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  createEmptySessionState,
  stoppedTurnMarker,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";
import { collectUserTasks } from "./collect-tasks.js";
import { FIT_TASK_SET_KIND, parseFitTaskSet } from "./fit-task.js";

let clock = Date.parse("2026-11-01T10:00:00Z");
const at = (): number => (clock += 1000);

function session(id: string, turns: ConversationTurn[]): SessionState {
  return { ...createEmptySessionState({ id, workingDir: "/w" }), turns };
}

function task(prompt: string, reply: string, tools: Array<[string, Record<string, unknown>]> = []): ConversationTurn[] {
  const out: ConversationTurn[] = [userTurn(prompt, at())];
  for (const [tool, args] of tools) {
    out.push(assistantToolCallTurn({ tool, args, at: at() }));
    out.push(toolResultTurn({ tool, status: "ok", summary: "done", at: at() }));
  }
  out.push(assistantReplyTurn(reply, at()));
  return out;
}

const NOW = () => new Date("2026-11-12T00:00:00Z");

describe("collectUserTasks", () => {
  it("keeps the newest tasks, oldest first, as judge-scored cases", () => {
    const a = session("s-a", [...task("list my files", "here they are", [["os.fs.list", {}]]), ...task("fix the bug in a.ts", "fixed", [["os.fs.edit", {}]])]);
    const b = session("s-b", task("what is 2+2", "4"));
    const { set } = collectUserTasks([b, a], { last: 2, now: NOW });
    expect(set.kind).toBe(FIT_TASK_SET_KIND);
    expect(set.createdAt).toBe("2026-11-12T00:00:00.000Z");
    expect(set.tasks.map((t) => t.prompt)).toEqual(["fix the bug in a.ts", "what is 2+2"]);
    const fix = set.tasks[0]!;
    expect(fix.category).toBe("coding");
    expect(fix.source.toolsUsed).toEqual(["os.fs.edit"]);
    expect(fix.expectations[0]!.kind).toBe("judge");
    expect(fix.expectations[0]!.rubric).toContain("fixed");
    expect(fix.id).toMatch(/^fit-[0-9a-f]{10}$/);
    expect(set.tasks[1]!.category).toBe("os");
  });

  it("leaves out tasks that sent something outside", () => {
    const s = session("s-1", [
      ...task("email the report to Bob", "sent", [["os.email.send", { to: "bob@x.test" }]]),
      ...task("push my branch", "pushed", [["os.shell.run", { cmd: "git push" }]]),
      ...task("read the readme", "it says hi", [["os.fs.read", {}]]),
    ]);
    const { set, skipped } = collectUserTasks([s], { last: 10, now: NOW });
    expect(set.tasks.map((t) => t.prompt)).toEqual(["read the readme"]);
    expect(skipped.outbound).toBe(2);
  });

  it("leaves out stopped, unanswered, slash-command and repeated tasks", () => {
    const s = session("s-1", [
      userTurn("write a long story", at()),
      stoppedTurnMarker(at()),
      userTurn("never answered", at()),
      ...task("/status", "running"),
      ...task("Summarise notes.md", "a summary"),
      ...task("summarise notes.md ", "another summary"),
    ]);
    const { set, skipped } = collectUserTasks([s], { last: 10, now: NOW });
    expect(set.tasks.map((t) => t.source.referenceReply)).toEqual(["another summary"]);
    expect(skipped).toEqual({ outbound: 0, stopped: 1, unanswered: 1, command: 1, duplicate: 1 });
  });

  it("masks secrets in the prompt and the reference reply", () => {
    // Built at run time so the file holds no key-shaped literal.
    const key = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-");
    const s = session("s-1", task(`use the key ${key} to list my models`, `done with ${key}`));
    const { set } = collectUserTasks([s], { last: 10, now: NOW });
    const json = JSON.stringify(set);
    expect(json).not.toContain(key);
    expect(set.tasks[0]!.prompt).toContain("[redacted:");
  });

  it("writes a set that parses back", () => {
    const { set } = collectUserTasks([session("s-1", task("hello there", "hi"))], { last: 10, now: NOW });
    expect(parseFitTaskSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
    expect(() => parseFitTaskSet({ kind: "other" })).toThrow(/not a task set/);
  });
});
