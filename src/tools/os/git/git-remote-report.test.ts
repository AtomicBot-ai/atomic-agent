import { describe, expect, it } from "vitest";
import {
  compressToolResult,
  type CompressorOptions,
} from "../../../compressor/result-compressor.js";
import {
  CLONE_REPORT_LIMITS,
  FETCH_REPORT_LIMITS,
  PULL_REPORT_LIMITS,
  clampLines,
  renderStream,
  shapeCloneReport,
  shapeFetchReport,
  shapePullReport,
} from "./git-remote-report.js";

/**
 * Every tool_result is re-cut at 8000 characters when the transcript is
 * rendered, so a cap above that would be a dead number and an oversized
 * fresh result would cost the session its pack budget for good.
 */
const RENDER_CAP_CHARS = 8000;

/** What the tool actually stores: the shaped report through the compressor. */
function summaryOf(
  preview: string,
  report: string,
  limits: Partial<CompressorOptions>,
): string {
  return compressToolResult(
    { tool: "os.git.test", status: "ok", output: `${preview}\n${report}`, details: {} },
    limits,
  ).summary;
}

/** One physical line of a git progress meter, refreshed with carriage returns. */
function progressMeter(label: string, total: number): string {
  const frames: string[] = [];
  for (let percent = 0; percent < 100; percent += 1) {
    frames.push(`${label}:  ${percent}% (${Math.round((total * percent) / 100)}/${total})`);
  }
  frames.push(`${label}: 100% (${total}/${total}), done.`);
  return frames.join("\r");
}

const FETCH_PROGRESS = [
  "remote: Enumerating objects: 18302, done.",
  progressMeter("remote: Counting objects", 18302),
  progressMeter("remote: Compressing objects", 6422),
  progressMeter("Receiving objects", 18302),
  progressMeter("Resolving deltas", 13899),
].join("\n");

describe("renderStream", () => {
  it("keeps only the last frame of a carriage-return-refreshed line", () => {
    const lines = renderStream(progressMeter("Receiving objects", 100));
    expect(lines).toEqual(["Receiving objects: 100% (100/100), done."]);
  });

  it("keeps whatever overwrote the meter, the way a terminal would", () => {
    const lines = renderStream(
      "Receiving objects:  98% (17936/18302)\rremote: Total 18302 (delta 13899), reused 15963",
    );
    expect(lines).toEqual(["remote: Total 18302 (delta 13899), reused 15963"]);
  });

  it("normalises CRLF and drops blank lines", () => {
    expect(renderStream("a\r\n\r\n  \r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("clampLines", () => {
  it("passes a short list through untouched", () => {
    expect(clampLines(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("says how many lines it dropped rather than dropping them silently", () => {
    const clamped = clampLines(["a", "b", "c", "d", "e", "f"], 2, 1);
    expect(clamped).toEqual(["a", "b", "… [omitted 3 lines]", "f"]);
  });
});

describe("shapePullReport", () => {
  // A realistic pull: the tree news is on stdout, where the verdict is
  // followed by a `create mode` block, the refs are on stderr, and the
  // progress meter runs ahead of both.
  const files = Array.from(
    { length: 42 },
    (_, i) => ` src/tools/os/git/file-${i}.ts | 14 +++++++-------`,
  );
  const created = Array.from(
    { length: 9 },
    (_, i) => ` create mode 100644 src/tools/os/git/file-${i}.ts`,
  );
  const stdout = [
    "Updating 3e1a2b4..9f0c7d1",
    "Fast-forward",
    ...files,
    " 42 files changed, 1180 insertions(+), 96 deletions(-)",
    ...created,
  ].join("\n");
  const stderr = [
    FETCH_PROGRESS,
    "From https://github.com/AtomicBot-ai/atomic-agent",
    " * branch            main       -> FETCH_HEAD",
    "   3e1a2b4..9f0c7d1  main       -> origin/main",
  ].join("\n");

  it("keeps the lines that say what changed", () => {
    const summary = summaryOf("git pull --no-progress --ff-only origin", shapePullReport(stdout, stderr), PULL_REPORT_LIMITS);
    expect(summary).toContain("Updating 3e1a2b4..9f0c7d1");
    expect(summary).toContain("Fast-forward");
    // The verdict is the single-line answer, and git buries it between
    // the diffstat rows and the `create mode` block.
    expect(summary).toContain("42 files changed, 1180 insertions(+), 96 deletions(-)");
    expect(summary).toContain("3e1a2b4..9f0c7d1  main       -> origin/main");
  });

  it("counts the mode lines it stops at instead of dropping them quietly", () => {
    expect(shapePullReport(stdout, stderr)).toContain("… [omitted 9 lines below the verdict]");
  });

  it("does not let the progress meter crowd them out", () => {
    const summary = summaryOf("git pull --no-progress --ff-only origin", shapePullReport(stdout, stderr), PULL_REPORT_LIMITS);
    expect(summary).not.toContain("\r");
    expect(summary).not.toMatch(/Receiving objects:  \d{1,2}% /);
    expect(summary).not.toMatch(/Counting objects:  \d{1,2}% /);
  });

  it("counts the diffstat rows it left out", () => {
    expect(shapePullReport(stdout, stderr)).toContain("… [omitted ");
  });

  it("still reports the common no-op case", () => {
    expect(shapePullReport("Already up to date.\n", "")).toBe("Already up to date.");
    expect(shapePullReport("", "")).toBe("(already up to date)");
  });

  it("fits the budget it asks for", () => {
    const summary = summaryOf("git pull --no-progress --ff-only origin", shapePullReport(stdout, stderr), PULL_REPORT_LIMITS);
    expect(summary.split("\n").length).toBeLessThanOrEqual(PULL_REPORT_LIMITS.maxTailLines!);
    expect(PULL_REPORT_LIMITS.maxSummaryLength!).toBeLessThanOrEqual(RENDER_CAP_CHARS);
  });
});

describe("shapeFetchReport", () => {
  const stderr = [
    FETCH_PROGRESS,
    "From https://github.com/AtomicBot-ai/atomic-agent",
    " * [new branch]      fix/git-report -> origin/fix/git-report",
    " + a1b2c3d...d4e5f6a main           -> origin/main  (forced update)",
    " - [deleted]         (none)         -> origin/old-topic",
  ].join("\n");

  it("keeps the refs that moved", () => {
    const summary = summaryOf("git fetch --no-progress --prune origin", shapeFetchReport(stderr), FETCH_REPORT_LIMITS);
    expect(summary).toContain("From https://github.com/AtomicBot-ai/atomic-agent");
    expect(summary).toContain("* [new branch]      fix/git-report -> origin/fix/git-report");
    expect(summary).toContain("+ a1b2c3d...d4e5f6a main           -> origin/main  (forced update)");
    expect(summary).toContain("- [deleted]         (none)         -> origin/old-topic");
    expect(summary).not.toMatch(/Receiving objects:  \d{1,2}% /);
  });

  it("clamps a first fetch of a repo with hundreds of branches and says so", () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => ` * [new branch]      topic-${i} -> origin/topic-${i}`,
    );
    const report = shapeFetchReport(
      ["From https://github.com/AtomicBot-ai/atomic-agent", ...many].join("\n"),
    );
    expect(report).toContain("… [omitted 281 lines]");
    expect(report).toContain("* [new branch]      topic-0 -> origin/topic-0");
    expect(report).toContain("* [new branch]      topic-299 -> origin/topic-299");
  });

  it("still reports the common no-op case", () => {
    expect(shapeFetchReport("")).toBe("(already up to date)");
  });

  it("fits the budget it asks for", () => {
    const summary = summaryOf("git fetch --no-progress origin", shapeFetchReport(stderr), FETCH_REPORT_LIMITS);
    expect(summary.split("\n").length).toBeLessThanOrEqual(FETCH_REPORT_LIMITS.maxTailLines!);
    expect(FETCH_REPORT_LIMITS.maxSummaryLength!).toBeLessThanOrEqual(RENDER_CAP_CHARS);
  });
});

describe("shapeCloneReport", () => {
  // A clone buries its warnings under the meter: they are the last
  // thing it says, which is why this report is weighted the other way.
  const stderr = [
    "Cloning into 'atomic-agent'...",
    FETCH_PROGRESS,
    "warning: remote HEAD refers to nonexistent ref, unable to checkout",
    "warning: You appear to have cloned an empty repository.",
  ].join("\n");

  it("keeps the warnings git leaves at the end", () => {
    const summary = summaryOf("git clone --no-progress -- <url> <dest>", shapeCloneReport(stderr), CLONE_REPORT_LIMITS);
    expect(summary).toContain("warning: remote HEAD refers to nonexistent ref, unable to checkout");
    expect(summary).toContain("warning: You appear to have cloned an empty repository.");
    expect(summary).not.toMatch(/Receiving objects:  \d{1,2}% /);
  });

  it("falls back to a word when git said nothing", () => {
    expect(shapeCloneReport("")).toBe("cloned");
  });

  it("fits the budget it asks for", () => {
    const summary = summaryOf("git clone --no-progress -- <url> <dest>", shapeCloneReport(stderr), CLONE_REPORT_LIMITS);
    expect(summary.split("\n").length).toBeLessThanOrEqual(CLONE_REPORT_LIMITS.maxTailLines!);
    expect(CLONE_REPORT_LIMITS.maxSummaryLength!).toBeLessThanOrEqual(RENDER_CAP_CHARS);
  });
});
