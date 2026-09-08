import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import {
  GITHUB_NOT_CONNECTED,
  GithubApi,
  formatRepoSlug,
  resolveGithubToken,
} from "../../github/index.js";
import {
  currentBranch,
  optionalString,
  parseLimit,
  parseState,
  parseStringArray,
  requireNumber,
  requireString,
  resolveRepo,
} from "./github-tool-args.js";

export interface GithubToolsOptions extends DangerousToolOptions {
  /** Test seam; production reads `GITHUB_TOKEN` at call time. */
  resolveToken?: () => string | null;
  /** Test seam; production builds a real client per call. */
  apiFactory?: (token: string) => GithubApi;
}

/**
 * The `github.*` tools: what the agent can do on GitHub once the
 * Integrations hub holds a token.
 *
 * Reads (`whoami`, `pr.list`, `issue.list`) are free. Writes
 * (`pr.create`, `issue.create`, `issue.comment`) go through the
 * approval gate under the `http` category — they are HTTP POSTs to
 * api.github.com, the same thing `os.http.request` would be gated as,
 * and they publish text under the operator's name, which is not
 * something a model should do unobserved below the level that
 * silences HTTP.
 *
 * `repo` is an `owner/name` slug (or a GitHub URL). When omitted the
 * tool reads it from the `origin` remote of the working directory, so
 * "open a PR for this" works without the model guessing the slug.
 */
export function buildGithubTools(
  options: GithubToolsOptions,
): ToolDefinition[] {
  const resolveToken = options.resolveToken ?? (() => resolveGithubToken());
  const apiFactory =
    options.apiFactory ?? ((token: string) => new GithubApi({ token }));

  const client = (): GithubApi => {
    const token = resolveToken();
    if (!token) throw new Error(GITHUB_NOT_CONNECTED);
    return apiFactory(token);
  };

  const whoami: ToolDefinition = {
    name: "github.whoami",
    description:
      "The GitHub account the connected token belongs to, and its scopes. Read-only.",
    readonly: true,
    async run() {
      const me = await client().whoami();
      return compressToolResult({
        tool: "github.whoami",
        status: "ok",
        output: `@${me.login}${me.name ? ` (${me.name})` : ""}${me.scopes.length ? ` — scopes: ${me.scopes.join(", ")}` : ""}`,
        details: { login: me.login, name: me.name, scopes: me.scopes },
      });
    },
  };

  const prList: ToolDefinition = {
    name: "github.pr.list",
    description:
      "List pull requests. Args: `repo` (owner/name; default: origin of the working dir), `state` (open|closed|all, default open), `limit` (default 20). Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, "github.pr.list");
      const prs = await client().listPullRequests({
        ...ref,
        state: parseState(rawArgs.state, "github.pr.list"),
        limit: parseLimit(rawArgs.limit),
      });
      const lines = prs.map(
        (p) =>
          `#${p.number} [${p.draft ? "draft" : p.state}] ${p.title} (${p.head} → ${p.base}, @${p.author})`,
      );
      return compressToolResult({
        tool: "github.pr.list",
        status: "ok",
        output: lines.length
          ? `${formatRepoSlug(ref)}\n${lines.join("\n")}`
          : `${formatRepoSlug(ref)}: no pull requests`,
        details: { repo: formatRepoSlug(ref), count: prs.length, pullRequests: prs },
      });
    },
  };

  const issueList: ToolDefinition = {
    name: "github.issue.list",
    description:
      "List issues. Args: `repo` (owner/name; default: origin of the working dir), `state` (open|closed|all, default open), `labels` (string[]), `limit` (default 20). Pull requests are excluded. Read-only.",
    readonly: true,
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, "github.issue.list");
      const labels = parseStringArray(rawArgs.labels, "github.issue.list", "labels");
      const issues = (
        await client().listIssues({
          ...ref,
          state: parseState(rawArgs.state, "github.issue.list"),
          ...(labels ? { labels } : {}),
          limit: parseLimit(rawArgs.limit),
        })
      ).filter((i) => !i.isPullRequest);
      const lines = issues.map(
        (i) =>
          `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` {${i.labels.join(", ")}}` : ""} (@${i.author})`,
      );
      return compressToolResult({
        tool: "github.issue.list",
        status: "ok",
        output: lines.length
          ? `${formatRepoSlug(ref)}\n${lines.join("\n")}`
          : `${formatRepoSlug(ref)}: no issues`,
        details: { repo: formatRepoSlug(ref), count: issues.length, issues },
      });
    },
  };

  const prCreate: ToolDefinition = {
    name: "github.pr.create",
    description:
      "Open a pull request. Args: `title` (required), `head` (branch with the changes; default: current branch), `base` (default: the repo's default branch), `body` (markdown), `draft` (default false), `repo` (owner/name; default: origin). Push the branch first with os.git.push. May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, "github.pr.create");
      const title = requireString(rawArgs.title, "github.pr.create", "title");
      const body = optionalString(rawArgs.body, "github.pr.create", "body");
      const draft = rawArgs.draft === true;
      const api = client();
      const head =
        optionalString(rawArgs.head, "github.pr.create", "head") ??
        (await currentBranch(ctx));
      const base =
        optionalString(rawArgs.base, "github.pr.create", "base") ??
        (await api.getRepo(ref.owner, ref.repo)).defaultBranch;

      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "github.pr.create",
          category: "http",
          reason: `open ${draft ? "draft " : ""}pull request "${title}" in ${formatRepoSlug(ref)}`,
          preview: `${head} → ${base}\n\n${body ?? "(no body)"}`.slice(0, 2000),
          affectedResources: [`github:${formatRepoSlug(ref)}`],
        },
        ctx.signal,
      );

      const pr = await api.createPullRequest({
        ...ref,
        title,
        head,
        base,
        ...(body === undefined ? {} : { body }),
        draft,
      });
      return compressToolResult({
        tool: "github.pr.create",
        status: "ok",
        output: `opened #${pr.number}: ${pr.htmlUrl}`,
        details: { repo: formatRepoSlug(ref), pullRequest: pr },
      });
    },
  };

  const issueCreate: ToolDefinition = {
    name: "github.issue.create",
    description:
      "File an issue. Args: `title` (required), `body` (markdown), `labels` (string[]), `repo` (owner/name; default: origin). May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, "github.issue.create");
      const title = requireString(rawArgs.title, "github.issue.create", "title");
      const body = optionalString(rawArgs.body, "github.issue.create", "body");
      const labels = parseStringArray(rawArgs.labels, "github.issue.create", "labels");

      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "github.issue.create",
          category: "http",
          reason: `file issue "${title}" in ${formatRepoSlug(ref)}`,
          preview: (body ?? "(no body)").slice(0, 2000),
          affectedResources: [`github:${formatRepoSlug(ref)}`],
        },
        ctx.signal,
      );

      const issue = await client().createIssue({
        ...ref,
        title,
        ...(body === undefined ? {} : { body }),
        ...(labels ? { labels } : {}),
      });
      return compressToolResult({
        tool: "github.issue.create",
        status: "ok",
        output: `filed #${issue.number}: ${issue.htmlUrl}`,
        details: { repo: formatRepoSlug(ref), issue },
      });
    },
  };

  const issueComment: ToolDefinition = {
    name: "github.issue.comment",
    description:
      "Comment on an issue or pull request. Args: `number` (required), `body` (required, markdown), `repo` (owner/name; default: origin). May require approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const ref = await resolveRepo(rawArgs.repo, ctx, "github.issue.comment");
      const number = requireNumber(rawArgs.number, "github.issue.comment", "number");
      const body = requireString(rawArgs.body, "github.issue.comment", "body");

      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "github.issue.comment",
          category: "http",
          reason: `comment on ${formatRepoSlug(ref)}#${number}`,
          preview: body.slice(0, 2000),
          affectedResources: [`github:${formatRepoSlug(ref)}#${number}`],
        },
        ctx.signal,
      );

      const comment = await client().addIssueComment({ ...ref, number, body });
      return compressToolResult({
        tool: "github.issue.comment",
        status: "ok",
        output: `commented: ${comment.htmlUrl}`,
        details: { repo: formatRepoSlug(ref), number, comment },
      });
    },
  };

  return [whoami, prList, issueList, prCreate, issueCreate, issueComment];
}

export function registerGithubTools(
  registry: { register(tool: ToolDefinition): void },
  options: GithubToolsOptions,
): void {
  for (const tool of buildGithubTools(options)) registry.register(tool);
}
