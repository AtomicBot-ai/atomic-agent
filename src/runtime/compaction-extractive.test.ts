import { describe, expect, it } from "vitest";
import { estimateTokens } from "../prompt/token-budget.js";
import { assistantReplyTurn, assistantToolCallTurn, steeredUserTurn, stoppedTurnMarker, toolResultTurn, userTurn, type ConversationTurn } from "../session/conversation-turn.js";
import { buildExtractiveSummary, clipMiddle, EXTRACTIVE_USER_MAX_CHARS } from "./compaction-extractive.js";
import { describeToolStep, firstErrorLine } from "./compaction-extractive-steps.js";
import { AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS, chooseCompactionMethod } from "./compaction-mode.js";

/** A long tool-heavy task: about 150k tokens of serialized records. */
function bigSession(): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn("REQUEST-0: refactor the parser in /src/parser.ts and keep the public API")];
  for (let i = 0; i < 300; i++) {
    if (i % 30 === 29) turns.push(userTurn(`REQUEST-${(i + 1) / 30}: also keep step ${i} fast`));
    turns.push(assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/src/file-${i}.ts` }, reasoning: `THINKING_MARKER ${"why ".repeat(40)}` }));
    turns.push(toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `BODY_MARKER_${i}\n${"const value = compute(input);\n".repeat(55)}` }));
    if (i % 10 === 0) {
      turns.push(assistantToolCallTurn({ tool: "os.shell.run", args: { cmd: "npm", args: ["test"] } }));
      turns.push(toolResultTurn({ tool: "os.shell.run", status: "error", summary: `$ npm test\nexit: 1\nOUTPUT_MARKER ok 1\nError: expected 2 got 3 in case ${i}\n${"at frame\n".repeat(40)}` }));
    }
    if (i % 7 === 0) {
      turns.push(assistantToolCallTurn({ tool: "os.fs.edit", args: { path: `/src/edit-${i}.ts`, oldString: "OLD_MARKER", newString: "NEW_MARKER" } }));
      turns.push(toolResultTurn({ tool: "os.fs.edit", status: "ok", summary: "DIFF_MARKER applied" }));
    }
    if (i % 25 === 24) turns.push(assistantReplyTurn(`Progress ${i}: ${"details ".repeat(200)}`, { progressNote: true }));
  }
  turns.push(assistantReplyTurn("Done with the parser refactor."));
  return turns;
}

describe("extractive summary", () => {
  it("summarizes a ~150k-token session in milliseconds within the budget, without bodies", () => {
    const turns = bigSession();
    expect(estimateTokens(turns.map((t) => JSON.stringify(t)).join("\n"))).toBeGreaterThan(120_000);
    const started = performance.now();
    const summary = buildExtractiveSummary(turns, 0, turns.length, { maxTokens: 2048 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(estimateTokens(summary)).toBeLessThanOrEqual(2048);
    for (let r = 0; r <= 10; r++) expect(summary).toContain(`REQUEST-${r}:`);
    expect(summary).toContain("REQUEST-0: refactor the parser in /src/parser.ts and keep the public API");
    expect(summary).toContain("/src/file-299.ts");
    expect(summary).toContain("/src/edit-294.ts");
    expect(summary).toContain("ran `npm test` → exit 1: Error: expected 2 got 3 in case 290");
    expect(summary).toContain("Done with the parser refactor.");
    for (const marker of ["BODY_MARKER", "OUTPUT_MARKER", "THINKING_MARKER", "OLD_MARKER", "NEW_MARKER", "DIFF_MARKER", "at frame"]) {
      expect(summary).not.toContain(marker);
    }
  });

  it("keeps the newest requests verbatim when they alone exceed the budget, and trims long ones in the middle", () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push(userTurn(`ASK-${i} ${"word ".repeat(i === 39 ? 2000 : 300)} END-${i}`));
      turns.push(assistantReplyTurn(`answer ${i}`));
    }
    const summary = buildExtractiveSummary(turns, 0, turns.length, { maxTokens: 1500 });
    expect(estimateTokens(summary)).toBeLessThanOrEqual(1500);
    expect(summary).toContain("ASK-39");
    expect(summary).toContain("END-39");
    expect(summary).toContain("[…]");
    expect(summary).not.toContain("ASK-0 ");
    expect(summary).toMatch(/\d+ older requests omitted/);
    expect(clipMiddle("x".repeat(5000), EXTRACTIVE_USER_MAX_CHARS).length).toBeLessThanOrEqual(EXTRACTIVE_USER_MAX_CHARS);
  });

  it("covers only the requested range, carries the previous checkpoint and stays non-empty on a tiny budget", () => {
    const turns = [userTurn("EARLY"), assistantReplyTurn("early reply"), userTurn("LATER"), steeredUserTurn("STEER"), stoppedTurnMarker()];
    const summary = buildExtractiveSummary(turns, 2, turns.length, { maxTokens: 400, previousSummary: "PREVIOUS CHECKPOINT" });
    expect(summary).toContain("PREVIOUS CHECKPOINT");
    expect(summary).toContain("LATER");
    expect(summary).toContain("(sent while a task ran) STEER");
    expect(summary).toContain("stopped by the user");
    expect(summary).not.toContain("EARLY");
    const tiny = buildExtractiveSummary(turns, 0, turns.length, { maxTokens: 10 });
    expect(tiny.trim()).not.toBe("");
    expect(estimateTokens(tiny)).toBeLessThanOrEqual(10);
  });
});

describe("tool step lines", () => {
  const ok = (tool: string, summary = "fine") => toolResultTurn({ tool, status: "ok", summary }) as Extract<ConversationTurn, { kind: "tool_result" }>;
  const err = (tool: string, summary: string) => toolResultTurn({ tool, status: "error", summary }) as Extract<ConversationTurn, { kind: "tool_result" }>;
  it("names the target and outcome, never the written content", () => {
    expect(describeToolStep({ tool: "os.fs.read", args: { path: "/a.ts" } }, ok("os.fs.read", "SECRET BODY"))).toMatchObject({ line: "read /a.ts → ok", read: ["/a.ts"] });
    expect(describeToolStep({ tool: "os.fs.write", args: { path: "/b.ts", content: "SECRET" } }, ok("os.fs.write"))).toMatchObject({ line: "wrote /b.ts → ok", changed: ["/b.ts"] });
    const patch = describeToolStep({ tool: "os.fs.patch", args: { patch: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** End Patch" } }, ok("os.fs.patch"));
    expect(patch).toMatchObject({ line: "patched src/c.ts → ok", changed: ["src/c.ts"] });
    expect(describeToolStep({ tool: "os.shell.run", args: { cmd: "git", args: ["status"] } }, ok("os.shell.run", "$ git status\nexit: 0\nclean")).line).toBe("ran `git status` → exit 0");
    const failed = describeToolStep({ tool: "os.web.fetch", args: { url: "https://example.com/x" } }, err("os.web.fetch", "\nHTTP 404 not found\nbody"));
    expect(failed).toMatchObject({ line: "fetched https://example.com/x → error: HTTP 404 not found", urls: ["https://example.com/x"] });
    expect(failed.error).toContain("HTTP 404 not found");
    expect(describeToolStep({ tool: "os.fs.edit", args: { path: "/d.ts" } }, undefined).line).toBe("edited /d.ts → no result recorded");
    expect(firstErrorLine("$ make\nexit: 2\ncompiling\nmake: *** [all] Error 2")).toBe("make: *** [all] Error 2");
  });
});

describe("compaction method choice", () => {
  const small = () => 1_000;
  it("keeps explicit modes and picks extractive under auto only for slow local routes", () => {
    expect(chooseCompactionMethod("model", { local: true, prefixReuse: "none" }, small)).toBe("model");
    expect(chooseCompactionMethod("extractive", {}, small)).toBe("extractive");
    expect(chooseCompactionMethod("auto", {}, () => 1_000_000)).toBe("model");
    expect(chooseCompactionMethod("auto", { local: true, prefixReuse: "none" }, small)).toBe("extractive");
    expect(chooseCompactionMethod("auto", { local: true, prefixReuse: "partial" }, small)).toBe("model");
    expect(chooseCompactionMethod("auto", { local: true }, () => AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS)).toBe("extractive");
  });
});
