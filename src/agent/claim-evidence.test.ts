import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../session/conversation-turn.js";
import {
  claimHasEvidence,
  detectCheckClaims,
  formatUnverifiedClaimNotice,
  turnToolCalls,
  unverifiedClaims,
} from "./claim-evidence.js";

const shell = (cmd: string, args: string[] = []) => ({
  tool: "os.shell.run",
  args: { cmd, args },
});

describe("detectCheckClaims", () => {
  it("finds the claims the failing replies made, one per kind, in order", () => {
    // Run 12: "Ran node --check on all JavaScript files (all passed)".
    expect(
      detectCheckClaims("Ran node --check on all JavaScript files (all passed)."),
    ).toEqual([{ kind: "node-check", text: "node --check" }]);
    expect(detectCheckClaims("All 12 tests pass. I verified the layout.")).toEqual([
      { kind: "tests", text: "tests pass" },
      { kind: "verified", text: "verified" },
    ]);
    expect(detectCheckClaims("I ran the tests and lint passes; it builds cleanly.")).toEqual([
      { kind: "tests", text: "ran the tests" },
      { kind: "lint", text: "lint passes" },
      { kind: "build", text: "builds cleanly" },
    ]);
  });

  it("does not fire on ordinary prose", () => {
    expect(detectCheckClaims("Here is the file. Run the tests when you like.")).toEqual([]);
    expect(detectCheckClaims("The build step is next; nothing checked yet.")).toEqual([]);
  });
});

describe("claimHasEvidence", () => {
  it("accepts a shell command containing the claimed check", () => {
    const nodeCheck = { kind: "node-check" as const, text: "node --check" };
    expect(claimHasEvidence(nodeCheck, [shell("node", ["--check", "a.js"])])).toBe(true);
    expect(claimHasEvidence(nodeCheck, [shell("node -c js/a.js")])).toBe(true);
    expect(claimHasEvidence(nodeCheck, [shell("node", ["js/a.js"])])).toBe(false);
    expect(claimHasEvidence(nodeCheck, [shell("ls")])).toBe(false);
    const tests = { kind: "tests" as const, text: "tests pass" };
    expect(claimHasEvidence(tests, [shell("npx", ["vitest", "run"])])).toBe(true);
    expect(claimHasEvidence(tests, [shell("npm test")])).toBe(true);
    expect(claimHasEvidence(tests, [shell("cat", ["a.js"])])).toBe(false);
  });

  it("accepts any verify.* call for any claim", () => {
    for (const kind of ["node-check", "tests", "verified", "lint", "build"] as const) {
      expect(
        claimHasEvidence({ kind, text: "x" }, [{ tool: "verify.syntax", args: {} }]),
      ).toBe(true);
    }
  });

  it("reads a bare 'verified' as backed by any command the turn ran", () => {
    const verified = { kind: "verified" as const, text: "verified" };
    expect(claimHasEvidence(verified, [shell("ls")])).toBe(true);
    expect(claimHasEvidence(verified, [{ tool: "os.fs.read", args: {} }])).toBe(false);
  });
});

describe("unverifiedClaims / turnToolCalls", () => {
  it("returns only the claims nothing backs", () => {
    expect(
      unverifiedClaims("tests pass and node --check passed", [shell("node --check a.js")]),
    ).toEqual([{ kind: "tests", text: "tests pass" }]);
    expect(unverifiedClaims("tests pass", [{ tool: "verify.run", args: {} }])).toEqual([]);
  });

  it("reads this turn's calls: everything after the last user turn", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "build it", at: 1 },
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "node --check a.js" }, at: 2 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "", at: 3 },
      { kind: "assistant_reply", text: "done", at: 4 },
      { kind: "user", text: "now fix it", at: 5 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.js" }, at: 6 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "", at: 7 },
    ];
    expect(turnToolCalls(turns)).toEqual([{ tool: "os.fs.read", args: { path: "a.js" } }]);
    // The earlier turn's node --check is not evidence for this turn.
    expect(unverifiedClaims("node --check passed", turnToolCalls(turns))).toHaveLength(1);
  });

  it("names the claim and both exits in the notice", () => {
    const notice = formatUnverifiedClaimNotice([{ kind: "tests", text: "tests pass" }]);
    expect(notice).toContain('claims "tests pass"');
    expect(notice).toContain("no such check ran this turn");
    expect(notice).toContain("`verify.run`");
    expect(notice).toContain("`os.shell.run`");
    expect(notice).toContain("remove the claim");
  });
});
