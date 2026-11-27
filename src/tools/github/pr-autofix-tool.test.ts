import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import {
  AutofixStore,
  GithubApi,
  autofixKey,
  autofixStatePath,
  autofixWorktreeDir,
  enableAutofix,
  recordAutofixPush,
} from "../../github/index.js";
import { makeCtx } from "../os/git/test-helpers.js";
import { buildPrAutofixTool } from "./pr-autofix-tool.js";

// The git layer is replaced so the tool's own push path (approval,
// push, counter) runs without a GitHub checkout; pr-autofix-git.test.ts
// covers the real git half against a local bare origin.
const git = vi.hoisted(() => ({
  requireCheckoutOf: vi.fn(),
  prepareAutofixWorktree: vi.fn(),
  inspectAutofixWorktree: vi.fn(),
  pushAutofixWorktree: vi.fn(),
}));
vi.mock("./pr-autofix-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pr-autofix-git.js")>()),
  ...git,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GitHub with one PR #42 whose head is `headRef`; the repo's default branch is main. */
function api(headRef: string, headSha = "sha1"): GithubApi {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widgets/pulls/42")) {
      return json({
        number: 42,
        title: "Fix lint",
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/42",
        head: { ref: headRef, sha: headSha, repo: { full_name: "acme/widgets" } },
        base: { ref: "release" },
      });
    }
    if (url.endsWith("/repos/acme/widgets")) {
      return json({ full_name: "acme/widgets", default_branch: "main" });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return new GithubApi({ token: "ghp_test", fetchImpl });
}

describe("github.pr.autofix", () => {
  let stateDir: string;
  let asked: string[];
  let requests: ApprovalRequest[];
  let denyGitRemote: boolean;
  let gate: ApprovalGate;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "autofix-tool-"));
    asked = [];
    requests = [];
    denyGitRemote = false;
    gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req.category);
        requests.push(req);
        const approved = !(denyGitRemote && req.category === "git_remote");
        gate.resolve({ approvalId: req.approvalId, approved });
      },
    });
    for (const fn of Object.values(git)) fn.mockReset();
    git.requireCheckoutOf.mockResolvedValue(undefined);
    git.prepareAutofixWorktree.mockImplementation(async (_o: unknown, input: { dir: string }) => ({
      dir: input.dir,
      localBranch: "pr-autofix/42",
      headSha: "sha1",
      created: true,
    }));
    git.inspectAutofixWorktree.mockResolvedValue({ headSha: "fix1" });
    git.pushAutofixWorktree.mockImplementation(async () => {
      // The push must come after its approval, never before.
      expect(asked).toContain("git_remote");
      return "To github.com:acme/widgets.git";
    });
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function tool(headRef = "feat/x", headSha = "sha1") {
    const client = api(headRef, headSha);
    return buildPrAutofixTool(() => client, {
      approvals: gate,
      approvalRequired: true,
      isRemoteSyncEnabled: () => true,
      stateDir: () => stateDir,
      now: () => new Date("2026-11-27T12:00:00Z"),
    });
  }
  const ctx = () => makeCtx(tmpdir());
  const args = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    number: 42,
    repo: "acme/widgets",
    ...extra,
  });

  it("is off by default: push is refused without asking anything", async () => {
    const res = await tool().run(args("push"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/autofix is off/);
    expect(asked).toEqual([]);
  });

  it("enable is the opt-in: it asks under publish and records 0 of 3", async () => {
    const res = await tool().run(args("enable"), ctx());
    expect(res.status).toBe("ok");
    expect(asked).toEqual(["publish"]);
    const state = await new AutofixStore(stateDir).get(autofixKey("acme/widgets", 42));
    expect(state).toMatchObject({ enabled: true, attempts: 0, maxAttempts: 3, headRef: "feat/x" });
    const status = await tool().run(args("status"), ctx());
    expect(status.summary).toContain("on, 0 of 3 attempts used, branch feat/x");
  });

  it("refuses to enable for a PR whose head is the default branch", async () => {
    const res = await tool("main").run(args("enable"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/refusing to push to main/);
    expect(asked).toEqual([]);
    expect(await new AutofixStore(stateDir).get(autofixKey("acme/widgets", 42))).toBeUndefined();
  });

  it("refuses to enable for a PR whose head is its base branch", async () => {
    const res = await tool("release").run(args("enable"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/base branch/);
    expect(asked).toEqual([]);
  });

  it("stops after the cap: a paused PR is refused before any git or approval", async () => {
    const store = new AutofixStore(stateDir);
    let state = enableAutofix("feat/x", 3, new Date());
    let before = "sha1";
    for (const sha of ["f1", "f2", "f3"]) {
      state = recordAutofixPush(state, sha, before, new Date());
      before = sha;
    }
    await store.set(autofixKey("acme/widgets", 42), state);
    // GitHub still reports our last push as the head: no person moved it.
    const res = await tool("feat/x", "f3").run(args("push"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/paused after 3 of 3 attempts/);
    expect(asked).toEqual([]);
    expect(git.pushAutofixWorktree).not.toHaveBeenCalled();
  });

  const wantDir = () => autofixWorktreeDir(stateDir, "acme/widgets", 42);
  const stored = () => new AutofixStore(stateDir).get(autofixKey("acme/widgets", 42));

  it("push asks one git_remote approval naming refs/heads/<PR head>, then pushes and counts 1", async () => {
    await tool().run(args("enable"), ctx());
    const res = await tool().run(args("push"), ctx());
    expect(res.status).toBe("ok");
    const gitRemote = requests.filter((r) => r.category === "git_remote");
    expect(gitRemote).toHaveLength(1);
    expect(gitRemote[0]!.tool).toBe("github.pr.autofix");
    expect(gitRemote[0]!.preview).toContain("git push origin HEAD:refs/heads/feat/x");
    expect(gitRemote[0]!.preview).toContain("commit: fix1");
    expect(gitRemote[0]!.reason).toContain("attempt 1 of 3");
    expect(gitRemote[0]!.reason).toContain("branch feat/x");
    expect(git.pushAutofixWorktree).toHaveBeenCalledTimes(1);
    expect(git.pushAutofixWorktree.mock.calls[0]![1]).toEqual({ dir: wantDir(), target: "feat/x" });
    expect(await stored()).toMatchObject({
      attempts: 1,
      paused: false,
      lastPushedSha: "fix1",
      prevHeadSha: "sha1",
    });
    expect(res.summary).toContain("autofix attempt 1 of 3 pushed to feat/x");
  });

  it("a denied push approval spawns no push and leaves attempts at 0", async () => {
    await tool().run(args("enable"), ctx());
    denyGitRemote = true;
    await expect(tool().run(args("push"), ctx())).rejects.toThrow();
    expect(requests.filter((r) => r.category === "git_remote")).toHaveLength(1);
    expect(git.pushAutofixWorktree).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ attempts: 0, lastPushedSha: null });
  });

  it("push refuses a worktree with no commit on top of the PR head, without asking", async () => {
    await tool().run(args("enable"), ctx());
    git.inspectAutofixWorktree.mockResolvedValue({ headSha: "sha1" });
    const res = await tool().run(args("push"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/no new commit/);
    expect(asked).toEqual(["publish"]);
    expect(git.pushAutofixWorktree).not.toHaveBeenCalled();
  });

  it("ignores a worktreeDir written into state.json: prepare and push use the derived folder", async () => {
    await tool().run(args("enable"), ctx());
    // A hand-edited (or model-written) state file names another folder.
    const elsewhere = join(tmpdir(), "not-the-autofix-worktree");
    const file = autofixStatePath(stateDir);
    const key = autofixKey("acme/widgets", 42);
    const state = await stored();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ [key]: { ...state, worktreeDir: elsewhere } }), "utf8");

    const prepared = await tool().run(args("prepare"), ctx());
    expect(prepared.status).toBe("ok");
    expect(git.prepareAutofixWorktree.mock.calls[0]![1]).toMatchObject({ dir: wantDir() });

    await tool().run(args("push"), ctx());
    expect(git.inspectAutofixWorktree.mock.calls[0]![0]).toEqual({ number: 42, dir: wantDir() });
    expect(git.pushAutofixWorktree.mock.calls[0]![1]).toEqual({ dir: wantDir(), target: "feat/x" });
    const preview = requests.find((r) => r.category === "git_remote")!.preview!;
    expect(preview).toContain(`from: ${wantDir()}`);
    expect(preview).not.toContain(elsewhere);
  });

  it("disable turns it off again", async () => {
    await tool().run(args("enable"), ctx());
    await tool().run(args("disable"), ctx());
    const res = await tool().run(args("push"), ctx());
    expect(res.summary).toMatch(/autofix is off/);
  });

  it("rejects an unknown action", async () => {
    await expect(tool().run(args("force-push"), ctx())).rejects.toThrow(/`action` must be one of/);
  });
});
