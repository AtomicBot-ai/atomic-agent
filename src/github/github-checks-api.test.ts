import { describe, expect, it } from "vitest";
import { GithubApi } from "./github-api.js";
import { CHECKS_MAX_PAGES, fetchChecks } from "./github-checks-api.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function run(id: number, conclusion: string) {
  return { id, name: `job-${id}`, status: "completed", conclusion, app: { slug: "github-actions" } };
}

/** GitHub serving `runs` as check runs, 100 per page, and no commit statuses. */
function apiWith(runs: unknown[]) {
  const pages: number[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname.endsWith("/check-runs")) {
      pages.push(page);
      return json({ total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100) });
    }
    return json({ state: "pending", total_count: 0, statuses: [] });
  }) as typeof fetch;
  return { api: new GithubApi({ token: "ghp_test", fetchImpl }), pages };
}

describe("fetchChecks paging (ATO-2516)", () => {
  it("reads past the first 100 check runs: a red job on page 2 makes the head red", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => run(i + 1, i === 119 ? "failure" : "success"));
    const { api, pages } = apiWith(runs);
    const summary = await fetchChecks(api, { owner: "acme", repo: "widgets" }, "sha1");
    expect(pages).toEqual([1, 2]);
    expect(summary.state).toBe("failure");
    expect(summary.failing.map((i) => i.name)).toEqual(["job-120"]);
    expect(summary.passing).toHaveLength(149);
  });

  it("asks for one page only when everything fits in it", async () => {
    const { api, pages } = apiWith([run(1, "success")]);
    const summary = await fetchChecks(api, { owner: "acme", repo: "widgets" }, "sha1");
    expect(pages).toEqual([1]);
    expect(summary.state).toBe("success");
  });

  it("stops at the page cap however many checks GitHub claims", async () => {
    const runs = Array.from({ length: (CHECKS_MAX_PAGES + 2) * 100 }, (_, i) => run(i + 1, "success"));
    const { api, pages } = apiWith(runs);
    await fetchChecks(api, { owner: "acme", repo: "widgets" }, "sha1");
    expect(pages).toHaveLength(CHECKS_MAX_PAGES);
  });
});
