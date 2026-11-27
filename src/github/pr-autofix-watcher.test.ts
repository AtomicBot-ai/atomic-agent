import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskStatus } from "../tasks/task-types.js";
import { GithubApi } from "./github-api.js";
import { enableAutofix, recordAutofixPush } from "./pr-autofix-guard.js";
import { AutofixStore, autofixKey } from "./pr-autofix-store.js";
import { startWatch } from "./pr-autofix-watch-state.js";
import { PrAutofixWatcher, WATCH_SCAN_MS, buildWatchRoundMessage } from "./pr-autofix-watcher.js";

const KEY = autofixKey("acme/widgets", 42);
const T0 = Date.parse("2026-11-27T12:00:00Z");

interface Gh {
  prState: string;
  headSha: string;
  mergeable: boolean | null;
  conclusion: string;
  comments: unknown[];
  calls: string[];
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeGithub(gh: Gh): GithubApi {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input).replace("https://api.github.com", "");
    gh.calls.push(url);
    if (url === "/repos/acme/widgets/pulls/42") {
      return json({
        number: 42,
        state: gh.prState,
        mergeable: gh.mergeable,
        mergeable_state: gh.mergeable === false ? "dirty" : "clean",
        head: { ref: "feat/x", sha: gh.headSha, repo: { full_name: "acme/widgets" } },
        base: { ref: "main" },
      });
    }
    if (url.includes("/check-runs")) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: "lint", status: "completed", conclusion: gh.conclusion }] });
    }
    if (url.includes("/status?")) return json({ total_count: 0, statuses: [] });
    if (url.includes("/pulls/42/comments")) return json(gh.comments);
    return json([]);
  }) as typeof fetch;
  return new GithubApi({ token: "ghp_test", fetchImpl });
}

describe("PrAutofixWatcher (ATO-2516)", () => {
  let stateDir: string;
  let gh: Gh;
  let tasks: Array<{ id: string; sessionId: string | null; userMessage: string; notify: string | null }>;
  let statuses: Map<string, TaskStatus>;
  let connected: boolean;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "autofix-watcher-"));
    gh = { prState: "open", headSha: "sha1", mergeable: true, conclusion: "success", comments: [], calls: [] };
    tasks = [];
    statuses = new Map();
    connected = true;
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const store = () => new AutofixStore(stateDir);
  const watcher = () =>
    new PrAutofixWatcher({
      stateDir: () => stateDir,
      client: () => (connected ? fakeGithub(gh) : null),
      createTask: (input) => {
        const id = `t${tasks.length + 1}`;
        tasks.push({ id, ...input });
        statuses.set(id, "pending");
        return { id };
      },
      taskStatus: (id) => statuses.get(id) ?? null,
    });
  async function seed(over: { paused?: boolean } = {}) {
    let state = enableAutofix("feat/x", 3, new Date(T0));
    if (over.paused) {
      for (const sha of ["a", "b", "c"]) state = recordAutofixPush(state, sha, "sha1", new Date(T0));
      gh.headSha = "c";
    }
    state = { ...state, watch: startWatch({ sessionId: "chat-1", notify: "telegram", everyMinutes: 10 }, new Date(T0)) };
    await store().set(KEY, state);
  }

  it("a green, clean PR with no new comments files nothing and calls no model", async () => {
    await seed();
    await watcher().tick(T0 + 1);
    expect(tasks).toEqual([]);
    expect((await store().get(KEY))?.watch?.lastPollAt).not.toBeNull();
  });

  it("failing CI files one round in the watching chat, with the report target", async () => {
    await seed();
    gh.conclusion = "failure";
    await watcher().tick(T0 + 1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ sessionId: "chat-1", notify: "telegram" });
    expect(tasks[0]!.userMessage).toContain("CI is failing on sha1");
    expect((await store().get(KEY))?.watch).toMatchObject({ ciHandledSha: "sha1", taskId: "t1" });
  });

  it("the same red head is handed over once; a new red head is a new round", async () => {
    await seed();
    gh.conclusion = "failure";
    const w = watcher();
    await w.tick(T0 + 1);
    statuses.set("t1", "completed");
    await w.tick(T0 + 11 * 60_000);
    expect(tasks).toHaveLength(1);
    gh.headSha = "sha2";
    await w.tick(T0 + 22 * 60_000);
    expect(tasks).toHaveLength(2);
  });

  it("never stacks a round on one still open", async () => {
    await seed();
    gh.conclusion = "failure";
    const w = watcher();
    await w.tick(T0 + 1);
    gh.headSha = "sha2";
    await w.tick(T0 + 11 * 60_000);
    expect(tasks).toHaveLength(1);
  });

  it("a merge conflict and new team review comments are rounds too; outsiders are not", async () => {
    await seed();
    gh.comments = [
      { id: 7, body: "drop this", user: { login: "eve" }, author_association: "NONE", created_at: "2026-11-27T12:05:00Z", position: 1 },
    ];
    const w = watcher();
    await w.tick(T0 + 1);
    expect(tasks).toEqual([]);
    gh.mergeable = false;
    gh.comments.push({ id: 8, body: "rename x", user: { login: "lena" }, author_association: "MEMBER", created_at: "2026-11-27T12:06:00Z", position: 1 });
    await w.tick(T0 + 11 * 60_000);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.userMessage).toContain("merge conflict with main");
    expect(tasks[0]!.userMessage).toContain('"since": "2026-11-27T12:00:00.000Z"');
    expect(tasks[0]!.userMessage).not.toContain("rename x");
    expect((await store().get(KEY))?.watch?.feedbackSeenAt).toBe("2026-11-27T12:06:00Z");
  });

  it("a paused PR files nothing, and a closed PR stops its watch", async () => {
    await seed({ paused: true });
    gh.conclusion = "failure";
    const w = watcher();
    await w.tick(T0 + 1);
    expect(tasks).toEqual([]);
    gh.prState = "closed";
    await w.tick(T0 + 11 * 60_000);
    expect((await store().get(KEY))?.watch).toBeUndefined();
  });

  it("polls each PR at its own interval and reads state at most once a minute", async () => {
    await seed();
    const w = watcher();
    await w.tick(T0 + 1);
    const after = gh.calls.length;
    await w.tick(T0 + 1 + WATCH_SCAN_MS - 1);
    await w.tick(T0 + 5 * 60_000);
    expect(gh.calls.length).toBe(after);
  });

  it("does nothing while GitHub is not connected or offline", async () => {
    await seed();
    connected = false;
    gh.conclusion = "failure";
    await watcher().tick(T0 + 1);
    expect(tasks).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("puts no GitHub text in the round message", () => {
    const msg = buildWatchRoundMessage({
      slug: "acme/widgets",
      number: 42,
      pr: { headRef: "feat/x", headSha: "abcdef123", baseRef: "main" },
      reasons: ["ci", "review"],
      feedbackSince: "2026-11-27T12:00:00.000Z",
    });
    expect(msg).toContain("pr-autofix skill");
    expect(msg).toContain('github.pr.autofix "push"');
    expect(msg).not.toContain("merge conflict");
  });
});
