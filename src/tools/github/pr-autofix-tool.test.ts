import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../approval/approval-gate.js";
import {
  AutofixStore,
  GithubApi,
  autofixKey,
  enableAutofix,
  recordAutofixPush,
} from "../../github/index.js";
import { makeCtx } from "../os/git/test-helpers.js";
import { buildPrAutofixTool } from "./pr-autofix-tool.js";

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
  let gate: ApprovalGate;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "autofix-tool-"));
    asked = [];
    gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req.category);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
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
    for (const sha of ["f1", "f2", "f3"]) state = recordAutofixPush(state, sha, new Date());
    await store.set(autofixKey("acme/widgets", 42), state);
    // GitHub still reports our last push as the head: no person moved it.
    const res = await tool("feat/x", "f3").run(args("push"), ctx());
    expect(res.status).toBe("error");
    expect(res.summary).toMatch(/paused after 3 of 3 attempts/);
    expect(asked).toEqual([]);
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
