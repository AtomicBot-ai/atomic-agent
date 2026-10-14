import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  steeredUserTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { formatPauseDigest } from "./pause-digest.js";

function step(
  tool: string,
  args: Record<string, unknown>,
  status: "ok" | "error" | null,
  summary = "",
): ConversationTurn[] {
  const call = assistantToolCallTurn({ tool, args, at: 1 });
  return status === null
    ? [call]
    : [call, toolResultTurn({ tool, status, summary, at: 1 })];
}

describe("formatPauseDigest", () => {
  it("is null when the turn did no work", () => {
    expect(formatPauseDigest([])).toBeNull();
    expect(formatPauseDigest([userTurn("hello", 1)])).toBeNull();
  });

  it("reports the request, call counts, changed files, last steps and the last note", () => {
    const digest = formatPauseDigest([
      userTurn("refactor the\n  parser", 1),
      steeredUserTurn("also the lexer", 1),
      ...step("os.fs.read", { path: "src/parser.ts" }, "ok"),
      ...step("os.fs.edit", { path: "src/parser.ts", oldString: "a", newString: "b" }, "ok"),
      ...step("os.fs.write", { path: "src/lexer.ts", content: "x" }, "ok"),
      ...step("os.fs.write", { path: "src/denied.ts", content: "x" }, "error", "approval declined"),
      assistantReplyTurn("parser done, lexer next", { at: 1, progressNote: true }),
      ...step("os.shell.run", { cmd: "npm", args: ["test"] }, "error", "exit 1:\n 3 failing"),
      ...step("os.shell.run", { cmd: "npm test" }, null),
    ]);
    expect(digest).not.toBeNull();
    const text = digest!;
    expect(text).toContain("Summary from this task's log");
    expect(text).toContain('- Request: "refactor the parser"');
    expect(text).not.toContain("also the lexer");
    expect(text).toContain("- Tool calls: 6 (3 ok, 2 failed, 1 not finished)");
    // A write that failed changed nothing.
    expect(text).toContain("- Files changed: src/parser.ts, src/lexer.ts\n");
    expect(text).toContain("  - os.shell.run `npm test` (failed: exit 1: 3 failing)");
    expect(text).toContain("  - os.shell.run `npm test` (not finished)");
    expect(text).toContain('- Last note: "parser done, lexer next"');
    // Only the most recent five steps are listed.
    expect(text).not.toContain("os.fs.read src/parser.ts");
  });

  it("caps long fields and the file list", () => {
    const turns: ConversationTurn[] = [userTurn("x".repeat(500), 1)];
    for (let n = 0; n < 12; n += 1) {
      turns.push(...step("os.fs.write", { path: `f${n}.ts`, content: "" }, "ok"));
    }
    const text = formatPauseDigest(turns)!;
    expect(text).toContain(`"${"x".repeat(159)}…"`);
    expect(text).toContain(
      "- Files changed: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts (+4 more)\n",
    );
  });
});
