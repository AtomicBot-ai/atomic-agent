import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { AutofixStore, GithubApi, autofixKey, autofixWorktreeDir } from "../../github/index.js";
import { makeCtx } from "../os/git/test-helpers.js";
import { buildPrAutofixTool } from "./pr-autofix-tool.js";

// ATO-2516: merge-base, the read grant on the worktree and the watch
// turn-on. The git layer is replaced, as in pr-autofix-tool.test.ts.
const git = vi.hoisted(() => ({
  requireCheckoutOf: vi.fn(),
  prepareAutofixWorktree: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  inspectAutofixWorktree: vi.fn(),
  pushAutofixWorktree: vi.fn(),
}));
vi.mock("./pr-autofix-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pr-autofix-git.js")>()),
  ...git,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function api(): GithubApi {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widgets/pulls/42")) {
      return json({
        number: 42,
        title: "Fix lint",
        state: "open",
        head: { ref: "feat/x", sha: "sha1", repo: { full_name: "acme/widgets" } },
        base: { ref: "release" },
      });
    }
    if (url.endsWith("/repos/acme/widgets")) return json({ full_name: "acme/widgets", default_branch: "main" });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return new GithubApi({ token: "ghp_test", fetchImpl });
}

describe("github.pr.autofix: conflicts, read scope and the watch (ATO-2516)", () => {
  let stateDir: string;
  let asked: string[];
  let gate: ApprovalGate;
  let watcherOn: boolean;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "autofix-watch-tool-"));
    asked = [];
    watcherOn = true;
    gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req.category);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    for (const fn of Object.values(git)) fn.mockReset();
    git.requireCheckoutOf.mockResolvedValue(undefined);
    git.prepareAutofixWorktree.mockImplementation(async (_o: unknown, input: { dir: string }) => ({
      dir: input.dir, localBranch: "pr-autofix/42", headSha: "sha1", created: true,
    }));
    git.inspectAutofixWorktree.mockResolvedValue({ headSha: "fix1" });
    git.pushAutofixWorktree.mockResolvedValue("pushed");
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const tool = () =>
    buildPrAutofixTool(() => api(), {
      approvals: gate,
      approvalRequired: true,
      isRemoteSyncEnabled: () => true,
      isWatcherAvailable: () => watcherOn,
      stateDir: () => stateDir,
      now: () => new Date("2026-11-27T12:00:00Z"),
    });
  const ctx = () => ({ ...makeCtx(tmpdir()), sessionId: "chat-1" });
  const args = (action: string, extra: Record<string, unknown> = {}) => ({ action, number: 42, repo: "acme/widgets", ...extra });
  const key = autofixKey("acme/widgets", 42);
  const dir = () => autofixWorktreeDir(stateDir, "acme/widgets", 42);

  it("prepare lets this session read in the autofix worktree without a read-scope question", async () => {
    await tool().run(args("enable"), ctx());
    expect(gate.readScopeGrants.rootsFor("chat-1")).toEqual([]);
    await tool().run(args("prepare"), ctx());
    expect(gate.readScopeGrants.rootsFor("chat-1")).toEqual([dir()]);
  });

  it("merge-base merges the PR's base into the worktree and names the conflicted files", async () => {
    await tool().run(args("enable"), ctx());
    git.mergeBaseIntoWorktree.mockResolvedValue({ status: "conflict", conflicted: ["src/a.ts"], headSha: "sha1" });
    const res = await tool().run(args("merge-base"), ctx());
    expect(res.status).toBe("ok");
    expect(git.mergeBaseIntoWorktree.mock.calls[0]![1]).toEqual({ dir: dir(), baseRef: "release", headRef: "feat/x" });
    expect(res.summary).toContain("conflicts in: src/a.ts");
    expect(res.summary).toContain('"all": true');
    // Merging is local: no push approval, no attempt counted.
    expect(asked).toEqual(["publish"]);
    expect((await new AutofixStore(stateDir).get(key))?.attempts).toBe(0);
  });

  it("merge-base is refused while autofix is off, before any git", async () => {
    const res = await tool().run(args("merge-base"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/autofix is off/);
    expect(git.mergeBaseIntoWorktree).not.toHaveBeenCalled();
  });

  it("watch needs autofix enabled first", async () => {
    const res = await tool().run(args("watch"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/enable it first/);
    expect(await new AutofixStore(stateDir).get(key)).toBeUndefined();
  });

  it("watch is refused when background tasks are off", async () => {
    await tool().run(args("enable"), ctx());
    watcherOn = false;
    const res = await tool().run(args("watch"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/background tasks on/);
    expect((await new AutofixStore(stateDir).get(key))?.watch).toBeUndefined();
  });

  it("watch records the chat, the interval and the report target; unwatch drops it", async () => {
    await tool().run(args("enable"), ctx());
    const res = await tool().run(args("watch", { everyMinutes: 1, notify: "telegram" }), ctx());
    expect(res.status).toBe("ok");
    const watch = (await new AutofixStore(stateDir).get(key))?.watch;
    expect(watch).toMatchObject({ sessionId: "chat-1", notify: "telegram", everyMs: 5 * 60_000, feedbackSeenAt: "2026-11-27T12:00:00.000Z" });
    expect(res.summary).toContain("watched every 5 min, reports here and by telegram");
    await tool().run(args("unwatch"), ctx());
    const after = await new AutofixStore(stateDir).get(key);
    expect(after?.watch).toBeUndefined();
    expect(after?.enabled).toBe(true);
  });

  it("a push keeps the watcher's bookkeeping written after the tool read the state", async () => {
    await tool().run(args("enable"), ctx());
    await tool().run(args("watch"), ctx());
    const store = new AutofixStore(stateDir);
    // The watcher marks a round between the tool's read and its write.
    git.inspectAutofixWorktree.mockImplementation(async () => {
      await store.update(key, (cur) => (cur?.watch ? { ...cur, watch: { ...cur.watch, ciHandledSha: "sha1", taskId: "t-9" } } : cur));
      return { headSha: "fix1" };
    });
    await tool().run(args("push"), ctx());
    const after = await store.get(key);
    expect(after).toMatchObject({ attempts: 1, watch: { ciHandledSha: "sha1", taskId: "t-9" } });
  });

  it("disable stops the watch too", async () => {
    await tool().run(args("enable"), ctx());
    await tool().run(args("watch"), ctx());
    await tool().run(args("disable"), ctx());
    const after = await new AutofixStore(stateDir).get(key);
    expect(after).toMatchObject({ enabled: false });
    expect(after?.watch).toBeUndefined();
  });

  it("re-enabling a paused PR keeps its watch", async () => {
    await tool().run(args("enable"), ctx());
    await tool().run(args("watch"), ctx());
    await tool().run(args("enable"), ctx());
    expect((await new AutofixStore(stateDir).get(key))?.watch?.sessionId).toBe("chat-1");
  });
});
