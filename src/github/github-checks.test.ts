import { describe, expect, it } from "vitest";
import {
  parseCheckRuns,
  parseCommitStatuses,
  parsePullRequestHead,
  summarizeChecks,
} from "./github-checks.js";

function run(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  slug = "github-actions",
) {
  return {
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/acme/widgets/actions/runs/1/job/${id}`,
    app: { slug },
  };
}

describe("parseCheckRuns + summarizeChecks", () => {
  it("is success when every finished run passed (skipped and neutral count as passing)", () => {
    const items = parseCheckRuns({
      check_runs: [
        run(1, "lint", "completed", "success"),
        run(2, "docs", "completed", "skipped"),
        run(3, "info", "completed", "neutral"),
      ],
    });
    const s = summarizeChecks(items);
    expect(s.state).toBe("success");
    expect(s.passing).toHaveLength(3);
    expect(s.failing).toEqual([]);
  });

  it("is failure when any run failed, and keeps the Actions job id for its log", () => {
    const s = summarizeChecks(
      parseCheckRuns({
        check_runs: [
          run(10, "lint", "completed", "failure"),
          run(11, "test", "in_progress", null),
          run(12, "ext", "completed", "timed_out", "circleci"),
        ],
      }),
    );
    expect(s.state).toBe("failure");
    expect(s.failing.map((i) => i.name)).toEqual(["lint", "ext"]);
    expect(s.failing[0]!.actionsJobId).toBe(10);
    // Another app's check run id is not an Actions job.
    expect(s.failing[1]!.actionsJobId).toBeNull();
    expect(s.pending.map((i) => i.name)).toEqual(["test"]);
  });

  it("is pending while something runs and nothing failed", () => {
    const s = summarizeChecks(
      parseCheckRuns({
        check_runs: [
          run(1, "lint", "completed", "success"),
          run(2, "test", "queued", null),
        ],
      }),
    );
    expect(s.state).toBe("pending");
    expect(s.pending[0]!.detail).toBe("queued");
  });

  it("counts only the newest run per name, so a green re-run clears an old red one", () => {
    const s = summarizeChecks(
      parseCheckRuns({
        check_runs: [
          run(5, "lint", "completed", "failure"),
          run(9, "lint", "completed", "success"),
        ],
      }),
    );
    expect(s.state).toBe("success");
    expect(s.passing).toHaveLength(1);
  });

  it("is none with no checks at all, and refuses a malformed body", () => {
    expect(summarizeChecks(parseCheckRuns({ check_runs: [] })).state).toBe("none");
    expect(() => parseCheckRuns({ nope: true })).toThrow(/malformed check-run list/);
  });
});

describe("parseCommitStatuses", () => {
  it("ignores the combined state, so a commit with no statuses is not pending", () => {
    const items = parseCommitStatuses({ state: "pending", statuses: [] });
    expect(items).toEqual([]);
    expect(summarizeChecks(items).state).toBe("none");
  });

  it("maps error and failure to failing and keeps the newest status per context", () => {
    const items = parseCommitStatuses({
      statuses: [
        { context: "ci/jenkins", state: "error", target_url: "https://ci/1" },
        { context: "ci/jenkins", state: "success" },
        { context: "deploy", state: "pending" },
      ],
    });
    expect(items.map((i) => [i.name, i.verdict])).toEqual([
      ["ci/jenkins", "failing"],
      ["deploy", "pending"],
    ]);
    expect(summarizeChecks(items).state).toBe("failure");
  });
});

describe("parsePullRequestHead", () => {
  it("reads head ref, sha, head repo and base", () => {
    const pr = parsePullRequestHead({
      number: 42,
      title: "Fix lint",
      state: "open",
      html_url: "https://github.com/acme/widgets/pull/42",
      head: { ref: "feat/x", sha: "abc123", repo: { full_name: "acme/widgets" } },
      base: { ref: "main" },
    });
    expect(pr).toMatchObject({
      number: 42,
      headRef: "feat/x",
      headSha: "abc123",
      headRepo: "acme/widgets",
      baseRef: "main",
    });
  });

  it("reads a deleted fork's head repo as empty", () => {
    const pr = parsePullRequestHead({
      number: 1,
      head: { ref: "x", sha: "s", repo: null },
      base: { ref: "main" },
    });
    expect(pr.headRepo).toBe("");
  });
});
