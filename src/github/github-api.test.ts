import { describe, expect, it, vi } from "vitest";

import { GithubApi, GithubApiError } from "./github-api.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  respond: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    const res = respond(call);
    return new Response(
      res.body === undefined ? null : JSON.stringify(res.body),
      { status: res.status, headers: res.headers ?? {} },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN = `ghp_${"A".repeat(36)}`;

describe("GithubApi", () => {
  it("sends a bearer token, the API version and a user agent", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { login: "octo", name: "Octo Cat" },
      headers: { "x-oauth-scopes": "repo, workflow" },
    }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    const me = await api.whoami();
    expect(me).toEqual({ login: "octo", name: "Octo Cat", scopes: ["repo", "workflow"] });
    expect(calls[0]?.url).toBe("https://api.github.com/user");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(calls[0]?.headers["User-Agent"]).toBe("atomic-agent");
  });

  it("reads an empty scopes header as no scopes (fine-grained PAT)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { login: "octo" } }));
    const me = await new GithubApi({ token: TOKEN, fetchImpl }).whoami();
    expect(me.scopes).toEqual([]);
    expect(me.name).toBeNull();
  });

  it("posts a pull request and narrows the response", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 201,
      body: {
        number: 7,
        title: "feat: x",
        state: "open",
        draft: true,
        head: { ref: "feat/x" },
        base: { ref: "main" },
        html_url: "https://github.com/a/b/pull/7",
        user: { login: "octo" },
        created_at: "2026-01-01T00:00:00Z",
      },
    }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    const pr = await api.createPullRequest({
      owner: "a",
      repo: "b",
      title: "feat: x",
      head: "feat/x",
      base: "main",
      body: "why",
      draft: true,
    });
    expect(pr.number).toBe(7);
    expect(pr.draft).toBe(true);
    expect(pr.htmlUrl).toBe("https://github.com/a/b/pull/7");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.github.com/repos/a/b/pulls");
    expect(calls[0]?.body).toEqual({
      title: "feat: x",
      head: "feat/x",
      base: "main",
      body: "why",
      draft: true,
    });
  });

  it("lists issues with state, labels and a clamped limit", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: [
        {
          number: 1,
          title: "bug",
          state: "open",
          html_url: "u",
          user: { login: "x" },
          labels: [{ name: "bug" }, { name: "p1" }],
          created_at: "",
        },
        { number: 2, title: "pr", state: "open", pull_request: {} },
      ],
    }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    const issues = await api.listIssues({
      owner: "a",
      repo: "b",
      state: "all",
      labels: ["bug", "p1"],
      limit: 500,
    });
    expect(issues[0]?.labels).toEqual(["bug", "p1"]);
    expect(issues[0]?.isPullRequest).toBe(false);
    expect(issues[1]?.isPullRequest).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/a/b/issues?state=all&per_page=100&labels=bug%2Cp1",
    );
  });

  it("comments on an issue", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: 99, html_url: "c" },
    }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    const c = await api.addIssueComment({ owner: "a", repo: "b", number: 5, body: "hi" });
    expect(c).toEqual({ id: 99, htmlUrl: "c" });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/a/b/issues/5/comments");
  });

  it("turns 401 into a message that points at the hub", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    await expect(api.whoami()).rejects.toMatchObject({
      name: "GithubApiError",
      status: 401,
      message: expect.stringContaining("Integrations tab"),
    });
  });

  it("surfaces GitHub's validation errors on 422", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 422,
      body: {
        message: "Validation Failed",
        errors: [{ message: "A pull request already exists for a:feat/x." }],
      },
    }));
    const api = new GithubApi({ token: TOKEN, fetchImpl });
    await expect(
      api.createPullRequest({ owner: "a", repo: "b", title: "t", head: "h", base: "b" }),
    ).rejects.toThrow(/already exists/);
  });

  it("distinguishes a rate limit from a permission refusal on 403", async () => {
    const limited = fakeFetch(() => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(
      new GithubApi({ token: TOKEN, fetchImpl: limited.fetchImpl }).whoami(),
    ).rejects.toThrow(/rate limit/);

    const forbidden = fakeFetch(() => ({
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
      headers: { "x-ratelimit-remaining": "4999" },
    }));
    await expect(
      new GithubApi({ token: TOKEN, fetchImpl: forbidden.fetchImpl }).getRepo("a", "b"),
    ).rejects.toThrow(/not accessible/);
  });

  it("explains a 404 as 'does not exist or the token cannot see it'", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    await expect(
      new GithubApi({ token: TOKEN, fetchImpl }).getRepo("a", "b"),
    ).rejects.toThrow(/cannot see it/);
  });

  it("wraps a network failure and never echoes the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await new GithubApi({ token: TOKEN, fetchImpl })
      .whoami()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as Error).message).toContain("Could not reach GitHub");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("rejects a malformed user body", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { nope: true } }));
    await expect(new GithubApi({ token: TOKEN, fetchImpl }).whoami()).rejects.toThrow(
      /malformed user/,
    );
  });
});
