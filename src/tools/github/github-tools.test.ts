import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { GithubApi } from "../../github/index.js";
import { GITHUB_NOT_CONNECTED } from "../../github/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import { buildGithubTools } from "./github-tools.js";

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

function fakeApi(): GithubApi & { calls: string[] } {
  const calls: string[] = [];
  const pr = {
    number: 7,
    title: "t",
    state: "open",
    draft: false,
    head: "feat/x",
    base: "main",
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    author: "octo",
    createdAt: "",
  };
  const issue = {
    number: 3,
    title: "bug",
    state: "open",
    htmlUrl: "https://github.com/acme/widgets/issues/3",
    author: "octo",
    labels: ["bug"],
    createdAt: "",
    isPullRequest: false,
  };
  return {
    calls,
    whoami: vi.fn(async () => {
      calls.push("whoami");
      return { login: "octo", name: null, scopes: ["repo"] };
    }),
    getRepo: vi.fn(async () => {
      calls.push("getRepo");
      return {
        fullName: "acme/widgets",
        defaultBranch: "develop",
        private: false,
        htmlUrl: "",
        permissions: { push: true, admin: false },
      };
    }),
    createPullRequest: vi.fn(async (input: unknown) => {
      calls.push(`createPullRequest ${JSON.stringify(input)}`);
      return pr;
    }),
    listPullRequests: vi.fn(async () => {
      calls.push("listPullRequests");
      return [pr];
    }),
    createIssue: vi.fn(async (input: unknown) => {
      calls.push(`createIssue ${JSON.stringify(input)}`);
      return issue;
    }),
    listIssues: vi.fn(async () => {
      calls.push("listIssues");
      return [issue, { ...issue, number: 4, isPullRequest: true }];
    }),
    addIssueComment: vi.fn(async (input: unknown) => {
      calls.push(`addIssueComment ${JSON.stringify(input)}`);
      return { id: 1, htmlUrl: "c" };
    }),
  } as unknown as GithubApi & { calls: string[] };
}

function toolsWith(
  api: GithubApi,
  opts: { gate?: ApprovalGate; token?: string | null } = {},
): Map<string, ToolDefinition> {
  const list = buildGithubTools({
    approvals: opts.gate ?? approveAll(),
    approvalRequired: true,
    resolveToken: () => (opts.token === undefined ? "ghp_x" : opts.token),
    apiFactory: () => api,
  });
  return new Map(list.map((t) => [t.name, t]));
}

describe("github.* tools", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await runGitRaw(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
    await runGitRaw(repo, ["checkout", "-q", "-b", "feat/x"]);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("registers the six tools with the read/write split", () => {
    const tools = toolsWith(fakeApi());
    expect([...tools.keys()].sort()).toEqual([
      "github.issue.comment",
      "github.issue.create",
      "github.issue.list",
      "github.pr.create",
      "github.pr.list",
      "github.whoami",
    ]);
    expect(tools.get("github.whoami")?.readonly).toBe(true);
    expect(tools.get("github.pr.list")?.readonly).toBe(true);
    expect(tools.get("github.issue.list")?.readonly).toBe(true);
    expect(tools.get("github.pr.create")?.readonly).toBe(false);
    expect(tools.get("github.issue.create")?.readonly).toBe(false);
    expect(tools.get("github.issue.comment")?.readonly).toBe(false);
  });

  it("every tool refuses with the hub pointer when there is no token", async () => {
    const tools = toolsWith(fakeApi(), { token: null });
    for (const tool of tools.values()) {
      await expect(
        tool.run({ title: "t", number: 1, body: "b" }, makeCtx(repo)),
      ).rejects.toThrow(GITHUB_NOT_CONNECTED);
    }
  });

  it("whoami reports login and scopes", async () => {
    const tools = toolsWith(fakeApi());
    const result = await tools.get("github.whoami")!.run({}, makeCtx(repo));
    expect(result.summary).toContain("@octo");
    expect(result.details.scopes).toEqual(["repo"]);
  });

  it("resolves the repo from origin and the head/base from git + the API", async () => {
    const api = fakeApi();
    const tools = toolsWith(api);
    const result = await tools
      .get("github.pr.create")!
      .run({ title: "feat: x", body: "why" }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("pull/7");
    expect(api.calls).toContain("getRepo");
    const create = api.calls.find((c) => c.startsWith("createPullRequest"))!;
    expect(JSON.parse(create.replace("createPullRequest ", ""))).toEqual({
      owner: "acme",
      repo: "widgets",
      title: "feat: x",
      head: "feat/x",
      base: "develop",
      body: "why",
      draft: false,
    });
  });

  it("lets explicit repo/head/base override the defaults", async () => {
    const api = fakeApi();
    const tools = toolsWith(api);
    await tools.get("github.pr.create")!.run(
      { title: "t", repo: "other/place", head: "h", base: "b", draft: true },
      makeCtx(repo),
    );
    expect(api.calls).not.toContain("getRepo");
    const create = api.calls.find((c) => c.startsWith("createPullRequest"))!;
    expect(create).toContain('"owner":"other"');
    expect(create).toContain('"head":"h"');
    expect(create).toContain('"draft":true');
  });

  it("does not call the API when approval is denied", async () => {
    const api = fakeApi();
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied"),
    });
    const tools = toolsWith(api, { gate });
    await expect(
      tools.get("github.issue.create")!.run({ title: "t" }, makeCtx(repo)),
    ).rejects.toThrow(/approval denied/);
    await expect(
      tools.get("github.issue.comment")!.run({ number: 3, body: "b" }, makeCtx(repo)),
    ).rejects.toThrow(/approval denied/);
    expect(api.calls.filter((c) => !c.startsWith("getRepo"))).toEqual([]);
  });

  it("asks under the http category with the body as preview", async () => {
    const seen: Array<{ category: string; preview?: string; tool: string }> = [];
    const gate = new ApprovalGate({
      emit: (req) => {
        seen.push({ category: req.category, preview: req.preview, tool: req.tool });
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tools = toolsWith(fakeApi(), { gate });
    await tools
      .get("github.issue.create")!
      .run({ title: "t", body: "the body", labels: ["bug"] }, makeCtx(repo));
    expect(seen).toEqual([
      { category: "http", preview: "the body", tool: "github.issue.create" },
    ]);
  });

  it("lists issues without pull requests", async () => {
    const tools = toolsWith(fakeApi());
    const result = await tools.get("github.issue.list")!.run({}, makeCtx(repo));
    expect(result.details.count).toBe(1);
    expect(result.summary).toContain("#3 [open] bug {bug}");
  });

  it("refuses a non-GitHub origin and a bad slug with a pointer to `repo`", async () => {
    await runGitRaw(repo, ["remote", "set-url", "origin", "https://gitlab.com/a/b.git"]);
    const tools = toolsWith(fakeApi());
    await expect(tools.get("github.pr.list")!.run({}, makeCtx(repo))).rejects.toThrow(
      /not on github\.com/,
    );
    await expect(
      tools.get("github.pr.list")!.run({ repo: "nope" }, makeCtx(repo)),
    ).rejects.toThrow(/owner\/name/);
  });

  it("validates arguments before touching the API", async () => {
    const api = fakeApi();
    const tools = toolsWith(api);
    await expect(tools.get("github.pr.create")!.run({}, makeCtx(repo))).rejects.toThrow(
      /`title`/,
    );
    await expect(
      tools.get("github.issue.comment")!.run({ body: "b" }, makeCtx(repo)),
    ).rejects.toThrow(/`number`/);
    await expect(
      tools.get("github.pr.list")!.run({ state: "weird" }, makeCtx(repo)),
    ).rejects.toThrow(/`state`/);
    expect(api.calls).toEqual([]);
  });
});
