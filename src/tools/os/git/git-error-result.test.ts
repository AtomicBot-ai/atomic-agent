import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import {
  GIT_FAILURE_SUMMARY_CHARS,
  GIT_FAILURE_TAIL_LINES,
  buildGitErrorResult,
  describeGitFailure,
} from "./git-error-result.js";

/**
 * The blocks below are git 2.x output copied out of a real repository —
 * a merge over five modified files, the same merge over a dirty tree,
 * and `git checkout` over a dirty tree. The point of the tests is that
 * the sentence git prints last, which is the only line the model can
 * act on, survives compression; on the compressor's 400/12 defaults it
 * did not.
 */
const CONFLICT = `Auto-merging src/agent/agent-loop.ts
CONFLICT (content): Merge conflict in src/agent/agent-loop.ts
Auto-merging src/agent/step-executor.ts
CONFLICT (content): Merge conflict in src/agent/step-executor.ts
Auto-merging src/session/conversation-turn.ts
CONFLICT (content): Merge conflict in src/session/conversation-turn.ts
Auto-merging src/tools/os/git/git-push.ts
CONFLICT (content): Merge conflict in src/tools/os/git/git-push.ts
Auto-merging src/tools/os/shell-result.ts
CONFLICT (content): Merge conflict in src/tools/os/shell-result.ts
Automatic merge failed; fix conflicts and then commit the result.`;

const OVERWRITTEN = `error: Your local changes to the following files would be overwritten by merge:
\tsrc/agent/agent-loop.ts
\tsrc/agent/step-executor.ts
\tsrc/session/conversation-turn.ts
\tsrc/tools/os/git/git-push.ts
\tsrc/tools/os/shell-result.ts
Please commit your changes or stash them before you merge.
Aborting
Merge with strategy ort failed.`;

/** The same failure over a branch switch, which spells the remedy differently. */
const CHECKOUT_OVERWRITTEN = `error: Your local changes to the following files would be overwritten by checkout:
\tsrc/agent/agent-loop.ts
\tsrc/agent/step-executor.ts
\tsrc/session/conversation-turn.ts
\tsrc/tools/os/git/git-push.ts
\tsrc/tools/os/shell-result.ts
Please commit your changes or stash them before you switch branches.
Aborting`;

/** A conflict over deep paths, the shape that costs the most characters per line. */
function deepConflict(files: number): string {
  const path = (i: number) =>
    `packages/orchestrator/src/tools/os/git/handlers/git-remote-policy-${i}.ts`;
  return [
    ...Array.from(
      { length: files },
      (_, i) =>
        `Auto-merging ${path(i)}\nCONFLICT (content): Merge conflict in ${path(i)}`,
    ),
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n");
}

describe("buildGitErrorResult", () => {
  it("keeps every conflicted path and the sentence that says what to do", () => {
    // 604 characters over 11 lines: the default 400-character cap cut
    // this at "CONFLICT (content): Me", losing the last two paths and
    // the whole "Automatic merge failed" line.
    expect(CONFLICT.length).toBeGreaterThan(400);
    const result = buildGitErrorResult("os.git.merge", CONFLICT, { repo: "/repo" });
    expect(result.status).toBe("error");
    expect(result.summary).toBe(CONFLICT);
    expect(result.truncated).toBe(false);
    for (const file of [
      "src/agent/agent-loop.ts",
      "src/agent/step-executor.ts",
      "src/session/conversation-turn.ts",
      "src/tools/os/git/git-push.ts",
      "src/tools/os/shell-result.ts",
    ]) {
      expect(result.summary).toContain(`CONFLICT (content): Merge conflict in ${file}`);
    }
    expect(result.summary).toContain(
      "Automatic merge failed; fix conflicts and then commit the result.",
    );
    expect(result.details).toMatchObject({ repo: "/repo", error: CONFLICT });
  });

  it("keeps the whole would-be-overwritten list, signature line and all", () => {
    const result = buildGitErrorResult("os.git.merge", OVERWRITTEN);
    // "error:" matches the compressor's markers, so git's header is
    // repeated as a `key:` line and costs 84 characters before the
    // body even starts — enough on its own to push this over 400.
    expect(result.summary.split("\n")[0]).toBe(
      "key: error: Your local changes to the following files would be overwritten by merge:",
    );
    expect(result.summary.endsWith(OVERWRITTEN)).toBe(true);
    expect(result.summary.length).toBeGreaterThan(400);
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain(
      "Please commit your changes or stash them before you merge.",
    );
    expect(result.summary).toContain("Merge with strategy ort failed.");
  });

  it("keeps the branch-switch remedy, which names a different command", () => {
    const result = buildGitErrorResult("os.git.checkout", CHECKOUT_OVERWRITTEN);
    expect(result.summary.endsWith(CHECKOUT_OVERWRITTEN)).toBe(true);
    expect(result.summary).toContain(
      "Please commit your changes or stash them before you switch branches.",
    );
    expect(result.truncated).toBe(false);
  });

  it("names all ten files of a ten-file conflict over deep paths", () => {
    // 21 lines, so one falls off the head — and it is the redundant
    // `Auto-merging` line for the first file, not its `CONFLICT` line.
    // Every path the model has to go and fix is still named.
    const raw = deepConflict(10);
    expect(raw.length).toBeGreaterThan(GIT_FAILURE_SUMMARY_CHARS / 2);
    const result = buildGitErrorResult("os.git.merge", raw);
    for (const line of raw.split("\n").filter((l) => l.startsWith("CONFLICT"))) {
      expect(result.summary).toContain(line);
    }
    expect(result.summary).toContain(
      "Automatic merge failed; fix conflicts and then commit the result.",
    );
    expect(result.summary).not.toContain("[truncated]");
  });

  it("clips a longer list from the head, with a count, and still ends on the remedy", () => {
    // Past the window something has to go. The line cap is the one that
    // binds, so whole lines go from the head and the compressor says how
    // many; what must never go is the last line.
    const raw = deepConflict(20);
    const result = buildGitErrorResult("os.git.merge", raw);
    expect(result.truncated).toBe(true);
    expect(result.summary.split("\n")[0]).toMatch(/^… \[omitted \d+ lines\]$/);
    expect(result.summary).not.toContain("[truncated]");
    expect(result.summary.endsWith(
      "Automatic merge failed; fix conflicts and then commit the result.",
    )).toBe(true);
    expect(result.summary.split("\n")).toHaveLength(GIT_FAILURE_TAIL_LINES + 1);
    expect(result.summary.length).toBeLessThanOrEqual(GIT_FAILURE_SUMMARY_CHARS);
  });

  it("is a real improvement on the compressor's defaults", () => {
    // The regression this fix exists for: with no options the remedy is
    // gone from all four blocks. If this ever passes on the defaults the
    // tests above have stopped proving anything.
    for (const raw of [CONFLICT, OVERWRITTEN, deepConflict(10), deepConflict(20)]) {
      const onDefaults = compressToolResult({
        tool: "os.git.merge",
        status: "error",
        output: raw,
      });
      const last = raw.split("\n").at(-1)!;
      expect(onDefaults.summary).not.toContain(last);
      expect(buildGitErrorResult("os.git.merge", raw).summary).toContain(last);
    }
  });
});

describe("describeGitFailure", () => {
  it("hands the conflict block through verbatim, stderr before stdout", () => {
    expect(
      describeGitFailure({
        command: "git",
        args: ["--no-pager", "merge", "feature"],
        exitCode: 1,
        signal: null,
        stdout: CONFLICT,
        stderr: "",
        durationMs: 12,
        timedOut: false,
        truncated: false,
        repoRoot: "/repo",
      }),
    ).toBe(CONFLICT);
  });
});
