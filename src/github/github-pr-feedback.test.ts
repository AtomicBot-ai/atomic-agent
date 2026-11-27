import { describe, expect, it } from "vitest";
import { GithubApi } from "./github-api.js";
import {
  FEEDBACK_MAX_ITEMS,
  fetchPrFeedback,
  parseIssueComments,
  parseReviewComments,
  parseReviews,
  selectFeedback,
} from "./github-pr-feedback.js";

const member = { login: "lena", type: "User" };

function inline(id: number, createdAt: string, over: Record<string, unknown> = {}) {
  return {
    id,
    body: `rename x (${id})`,
    path: "src/a.ts",
    line: 7,
    position: 3,
    user: member,
    author_association: "MEMBER",
    created_at: createdAt,
    html_url: `https://github.com/acme/widgets/pull/42#discussion_r${id}`,
    ...over,
  };
}

describe("PR review feedback (ATO-2516)", () => {
  it("keeps team reviews that ask for changes or comment, with a body", () => {
    const raw = parseReviews([
      { id: 1, state: "CHANGES_REQUESTED", body: "please add a test", user: member, author_association: "OWNER", submitted_at: "2026-11-27T10:00:00Z" },
      { id: 2, state: "APPROVED", body: "lgtm", user: member, author_association: "OWNER", submitted_at: "2026-11-27T10:01:00Z" },
      { id: 3, state: "COMMENTED", body: "", user: member, author_association: "OWNER", submitted_at: "2026-11-27T10:02:00Z" },
    ]);
    const picked = selectFeedback(raw, null);
    expect(picked.items.map((i) => [i.id, i.kind, i.reviewState])).toEqual([[1, "review", "CHANGES_REQUESTED"]]);
  });

  it("leaves out outsiders, bots and outdated comments, and counts them", () => {
    const raw = parseReviewComments([
      inline(10, "2026-11-27T10:00:00Z"),
      inline(11, "2026-11-27T10:01:00Z", { author_association: "NONE" }),
      inline(12, "2026-11-27T10:02:00Z", { user: { login: "codecov[bot]", type: "Bot" } }),
      inline(13, "2026-11-27T10:03:00Z", { position: null }),
    ]);
    const picked = selectFeedback(raw, null);
    expect(picked.items.map((i) => i.id)).toEqual([10]);
    expect(picked.items[0]).toMatchObject({ path: "src/a.ts", line: 7, author: "lena" });
    expect(picked.leftOut).toEqual({ outsideTeam: 1, bots: 1, outdated: 1, overCap: 0 });
  });

  it("keeps only feedback newer than since, and reports the newest time", () => {
    const raw = [
      ...parseReviewComments([inline(20, "2026-11-27T10:00:00Z")]),
      ...parseIssueComments([
        { id: 21, body: "also fix the typo", user: member, author_association: "COLLABORATOR", created_at: "2026-11-27T11:00:00Z" },
      ]),
    ];
    const picked = selectFeedback(raw, "2026-11-27T10:00:00Z");
    expect(picked.items.map((i) => i.id)).toEqual([21]);
    expect(picked.newestAt).toBe("2026-11-27T11:00:00Z");
    expect(selectFeedback(raw, "2026-11-27T11:00:00Z").items).toEqual([]);
    expect(selectFeedback(raw, "2026-11-27T11:00:00Z").newestAt).toBeNull();
  });

  it("caps the list at the newest items, oldest first", () => {
    const raw = parseReviewComments(
      Array.from({ length: FEEDBACK_MAX_ITEMS + 5 }, (_, i) =>
        inline(100 + i, new Date(Date.UTC(2026, 10, 27, 10, i)).toISOString()),
      ),
    );
    const picked = selectFeedback(raw, null);
    expect(picked.items).toHaveLength(FEEDBACK_MAX_ITEMS);
    expect(picked.items[0]!.id).toBe(105);
    expect(picked.leftOut.overCap).toBe(5);
  });

  it("reads the three lists of the PR and passes since to GitHub", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input).replace("https://api.github.com", "");
      seen.push(url);
      const body = url.includes("/pulls/42/comments") ? [inline(30, "2026-11-27T12:00:00Z")] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const api = new GithubApi({ token: "ghp_test", fetchImpl });
    const fb = await fetchPrFeedback(api, { owner: "acme", repo: "widgets" }, 42, "2026-11-27T11:00:00Z");
    expect(fb.items.map((i) => i.id)).toEqual([30]);
    expect(seen.some((u) => u.startsWith("/repos/acme/widgets/pulls/42/reviews"))).toBe(true);
    expect(seen.some((u) => u.startsWith("/repos/acme/widgets/issues/42/comments") && u.includes("since=2026-11-27T11%3A00%3A00Z"))).toBe(true);
  });
});
