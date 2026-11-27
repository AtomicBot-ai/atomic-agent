import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GithubApi } from "../../github/index.js";
import { makeCtx } from "../os/git/test-helpers.js";
import { buildPrChecksTool } from "./pr-checks-tool.js";

type Route = (url: string) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A GitHub that serves one PR (#42, head sha1) and whatever `extra` adds. */
function apiWith(checkRuns: unknown[], extra: Route = () => undefined) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url.replace("https://api.github.com", ""));
    const routed = extra(url);
    if (routed) return routed;
    if (url.endsWith("/repos/acme/widgets/pulls/42")) {
      return json({
        number: 42,
        title: "Fix lint",
        state: "open",
        head: { ref: "feat/x", sha: "sha1aaaaaaa", repo: { full_name: "acme/widgets" } },
        base: { ref: "main" },
      });
    }
    if (url.includes("/commits/sha1aaaaaaa/check-runs")) return json({ check_runs: checkRuns });
    if (url.includes("/commits/sha1aaaaaaa/status")) return json({ state: "pending", statuses: [] });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  const api = new GithubApi({ token: "ghp_test", fetchImpl });
  return { tool: buildPrChecksTool(() => api), seen };
}

const failingLint = {
  id: 101,
  name: "lint",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/acme/widgets/actions/runs/9/job/101",
  app: { slug: "github-actions" },
};

describe("github.pr.checks", () => {
  it("reports a green PR without fetching any log", async () => {
    const { tool, seen } = apiWith([{ ...failingLint, conclusion: "success" }]);
    const res = await tool.run({ number: 42, repo: "acme/widgets" }, makeCtx(tmpdir()));
    expect(res.status).toBe("ok");
    expect(res.details.state).toBe("success");
    expect(res.summary).toContain("acme/widgets#42 feat/x @sha1aaa: success");
    expect(seen.some((u) => u.includes("/logs"))).toBe(false);
  });

  it("names the failing check and shows the tail of its Actions log", async () => {
    const log = [
      "2026-11-27T10:00:00.0000000Z Run npm run lint",
      "2026-11-27T10:00:01.0000000Z ##[error]src/a.ts:3:7 'unused' is defined but never used",
      "2026-11-27T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const { tool, seen } = apiWith([failingLint], (url) =>
      url.endsWith("/actions/jobs/101/logs") ? new Response(log) : undefined,
    );
    const res = await tool.run({ number: 42, repo: "acme/widgets" }, makeCtx(tmpdir()));
    expect(res.details.state).toBe("failure");
    expect(res.details.failing).toEqual(["lint"]);
    expect(res.summary).toContain("FAIL lint (failure)");
    expect(res.summary).toContain("--- log: lint (job 101)");
    expect(res.summary).toContain("src/a.ts:3:7 'unused' is defined but never used");
    expect(res.summary).not.toContain("2026-11-27T10:00:01");
    expect(seen).toContain("/repos/acme/widgets/actions/jobs/101/logs");
  });

  it("still reports the red check when its log is gone", async () => {
    const { tool } = apiWith([failingLint]);
    const res = await tool.run({ number: 42, repo: "acme/widgets" }, makeCtx(tmpdir()));
    expect(res.details.state).toBe("failure");
    expect(res.summary).toMatch(/--- log: lint: not available/);
  });

  it("skips logs when asked and says pending while a job runs", async () => {
    const { tool, seen } = apiWith([
      failingLint,
      { ...failingLint, id: 102, name: "test", status: "in_progress", conclusion: null },
    ]);
    const res = await tool.run({ number: 42, repo: "acme/widgets", logs: false }, makeCtx(tmpdir()));
    expect(res.details.pending).toEqual(["test"]);
    expect(res.summary).toContain("WAIT test (in_progress)");
    expect(seen.some((u) => u.includes("/logs"))).toBe(false);
  });

  it("requires a PR number before calling GitHub", async () => {
    const { tool, seen } = apiWith([]);
    await expect(tool.run({ repo: "acme/widgets" }, makeCtx(tmpdir()))).rejects.toThrow(/`number`/);
    expect(seen).toEqual([]);
  });
});
