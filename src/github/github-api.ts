/**
 * The handful of GitHub REST calls the agent makes, over `fetch`.
 *
 * No SDK: Octokit is a large dependency for six endpoints, and the
 * skill hub already talks to the same API with plain `fetch`
 * (`github-skill-client.ts`). Same posture as the Discord layer —
 * one class, one `request`, typed results narrowed at the edge so a
 * malformed body surfaces as a clear error instead of an `undefined`
 * three calls later.
 */

import { GithubApiError } from "./github-api-types.js";
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GithubApiOptions,
  GithubComment,
  GithubIdentity,
  GithubIssue,
  GithubPullRequest,
  GithubRepo,
} from "./github-api-types.js";

export { GithubApiError } from "./github-api-types.js";
export type {
  CreateIssueInput,
  CreatePullRequestInput,
  GithubApiOptions,
  GithubComment,
  GithubIdentity,
  GithubIssue,
  GithubPullRequest,
  GithubRepo,
} from "./github-api-types.js";
import {
  asRecord,
  parseIssue,
  parsePullRequest,
  readErrorMessage,
} from "./github-api-parse.js";

export const GITHUB_API_BASE = "https://api.github.com";

/** GitHub caps an issue / comment body at this many characters. */
export const GITHUB_BODY_LIMIT = 65_536;

export class GithubApi {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(private readonly opts: GithubApiOptions) {
    this.base = (opts.baseUrl ?? GITHUB_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? "atomic-agent";
  }

  /** Who the token belongs to, and what it may do. */
  async whoami(): Promise<GithubIdentity> {
    const { body, headers } = await this.request("GET", "/user");
    const rec = asRecord(body);
    const login = rec?.login;
    if (typeof login !== "string" || login.length === 0) {
      throw new GithubApiError("GitHub returned a malformed user.", 0);
    }
    const scopesHeader = headers.get("x-oauth-scopes") ?? "";
    const scopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      login,
      name: typeof rec?.name === "string" ? rec.name : null,
      scopes,
    };
  }

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    const { body } = await this.request(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}`,
    );
    const rec = asRecord(body);
    const fullName = rec?.full_name;
    const defaultBranch = rec?.default_branch;
    if (typeof fullName !== "string" || typeof defaultBranch !== "string") {
      throw new GithubApiError("GitHub returned a malformed repository.", 0);
    }
    const perms = asRecord(rec?.permissions);
    return {
      fullName,
      defaultBranch,
      private: rec?.private === true,
      htmlUrl: typeof rec?.html_url === "string" ? rec.html_url : "",
      permissions: {
        push: perms?.push === true,
        admin: perms?.admin === true,
      },
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<GithubPullRequest> {
    const { body } = await this.request(
      "POST",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/pulls`,
      {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.draft === undefined ? {} : { draft: input.draft }),
      },
    );
    return parsePullRequest(body);
  }

  async listPullRequests(input: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    limit?: number;
  }): Promise<GithubPullRequest[]> {
    const limit = clampLimit(input.limit);
    const state = input.state ?? "open";
    const { body } = await this.request(
      "GET",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
    );
    if (!Array.isArray(body)) {
      throw new GithubApiError("GitHub returned a malformed PR list.", 0);
    }
    return body.map(parsePullRequest);
  }

  async createIssue(input: CreateIssueInput): Promise<GithubIssue> {
    const { body } = await this.request(
      "POST",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/issues`,
      {
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.labels === undefined ? {} : { labels: [...input.labels] }),
      },
    );
    return parseIssue(body);
  }

  async listIssues(input: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    labels?: readonly string[];
    limit?: number;
  }): Promise<GithubIssue[]> {
    const limit = clampLimit(input.limit);
    const state = input.state ?? "open";
    const labels =
      input.labels && input.labels.length > 0
        ? `&labels=${encodeURIComponent(input.labels.join(","))}`
        : "";
    const { body } = await this.request(
      "GET",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/issues?state=${state}&per_page=${limit}${labels}`,
    );
    if (!Array.isArray(body)) {
      throw new GithubApiError("GitHub returned a malformed issue list.", 0);
    }
    return body.map(parseIssue);
  }

  /** Comment on an issue or a pull request (same endpoint on GitHub). */
  async addIssueComment(input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }): Promise<GithubComment> {
    const { body } = await this.request(
      "POST",
      `/repos/${enc(input.owner)}/${enc(input.repo)}/issues/${input.number}/comments`,
      { body: input.body },
    );
    const rec = asRecord(body);
    if (typeof rec?.id !== "number") {
      throw new GithubApiError("GitHub returned a malformed comment.", 0);
    }
    return {
      id: rec.id,
      htmlUrl: typeof rec.html_url === "string" ? rec.html_url : "",
    };
  }

  private async request(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ body: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": this.userAgent,
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GithubApiError(`Could not reach GitHub: ${msg}`, 0);
    }
    if (res.status === 401) {
      throw new GithubApiError(
        "GitHub rejected the token (HTTP 401). Check it in the Integrations tab.",
        401,
      );
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const detail = await readErrorMessage(res);
      // Primary limits zero the remaining counter; secondary (abuse)
      // limits arrive as 403 with a Retry-After and a healthy counter.
      const rateLimited =
        remaining === "0" ||
        res.status === 429 ||
        res.headers.has("retry-after");
      throw new GithubApiError(
        rateLimited
          ? `GitHub rate limit reached (HTTP ${res.status}). ${detail}`.trim()
          : `GitHub refused ${method} ${stripQuery(path)} (HTTP 403): ${detail || "the token lacks the required permission"}`,
        res.status,
      );
    }
    if (res.status === 404) {
      throw new GithubApiError(
        `GitHub returned 404 for ${method} ${stripQuery(path)} — the repository does not exist or the token cannot see it.`,
        404,
      );
    }
    if (!res.ok) {
      const detail = await readErrorMessage(res);
      throw new GithubApiError(
        `GitHub returned HTTP ${res.status} for ${method} ${stripQuery(path)}${detail ? `: ${detail}` : "."}`,
        res.status,
      );
    }
    if (res.status === 204) return { body: undefined, headers: res.headers };
    try {
      return { body: await res.json(), headers: res.headers };
    } catch {
      return { body: undefined, headers: res.headers };
    }
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function stripQuery(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : path.slice(0, q);
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}
