import { describe, expect, it } from "vitest";

import type { ConversationTurn } from "../../session/conversation-turn.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { buildHandoffBrief, changedFilesOf, parseHandoffTarget } from "./handoff-export.js";

const turns: ConversationTurn[] = [
  { kind: "user", text: "Fix the login redirect", at: 1 },
  { kind: "assistant_tool_call", tool: "os.fs.edit", args: { path: "src/auth.ts", oldString: "a", newString: "b" }, at: 2 },
  { kind: "tool_result", tool: "os.fs.edit", status: "ok", summary: "edited", at: 3 },
  { kind: "assistant_tool_call", tool: "os.fs.write", args: { path: "src/failed.ts", content: "x" }, at: 4 },
  { kind: "tool_result", tool: "os.fs.write", status: "error", summary: "denied", at: 5 },
  { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "README.md" }, at: 6 },
  { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "read", at: 7 },
  { kind: "assistant_reply", text: "Kept the cookie, moved the redirect into auth.ts.", at: 8 },
  { kind: "user", text: "Now add a test", at: 9 },
];

function session() {
  const state = createEmptySessionState({ id: "s-abc", workingDir: "/work/app", metadata: { title: "Login fix" } });
  state.turns = turns;
  return state;
}

describe("buildHandoffBrief (ATO-1158)", () => {
  it("lists the task, decisions, open items and changed files", () => {
    const brief = buildHandoffBrief({ session: session(), to: "claude", now: new Date(0) });
    expect(brief).toContain("# Handoff: Login fix");
    expect(brief).toContain("for Claude Code");
    expect(brief).toContain("> Fix the login redirect");
    expect(brief).toContain("Latest request:");
    expect(brief).toContain("> Now add a test");
    expect(brief).toContain("> Kept the cookie, moved the redirect into auth.ts.");
    expect(brief).toContain("The last turn did not finish");
    expect(brief).toContain("- `src/auth.ts`");
    // A failed write and a read are not changes.
    expect(brief).not.toContain("src/failed.ts");
    expect(brief).not.toContain("- `README.md`");
  });

  it("names Codex for --to codex", () => {
    expect(buildHandoffBrief({ session: session(), to: "codex" })).toContain("Open Codex in the folder");
  });

  it("reads a fresh chat without failing", () => {
    const brief = buildHandoffBrief({
      session: createEmptySessionState({ id: "s-new", workingDir: "/w" }),
      to: "claude",
    });
    expect(brief).toContain("No request in this chat yet");
    expect(brief).toContain("No file changes recorded");
  });
});

describe("changedFilesOf", () => {
  it("reads moves and applied patches, not dry runs", () => {
    const files = changedFilesOf([
      { kind: "assistant_tool_call", tool: "os.fs.move", args: { moves: [{ from: "a.txt", to: "b.txt" }] }, at: 1 },
      { kind: "tool_result", tool: "os.fs.move", status: "ok", summary: "", at: 2 },
      { kind: "assistant_tool_call", tool: "os.fs.patch", args: { patch: "--- a/x.ts\n+++ b/x.ts\n", apply: false }, at: 3 },
      { kind: "tool_result", tool: "os.fs.patch", status: "ok", summary: "", at: 4 },
      { kind: "assistant_tool_call", tool: "os.fs.patch", args: { patch: "--- a/y.ts\n+++ b/y.ts\n", apply: true }, at: 5 },
      { kind: "tool_result", tool: "os.fs.patch", status: "ok", summary: "", at: 6 },
    ]);
    expect(files).toEqual(["a.txt", "b.txt", "y.ts"]);
  });
});

describe("parseHandoffTarget", () => {
  it("accepts claude, claude-code and codex only", () => {
    expect(parseHandoffTarget("claude")).toBe("claude");
    expect(parseHandoffTarget("claude-code")).toBe("claude");
    expect(parseHandoffTarget("codex")).toBe("codex");
    expect(parseHandoffTarget("hermes")).toBeNull();
  });
});
