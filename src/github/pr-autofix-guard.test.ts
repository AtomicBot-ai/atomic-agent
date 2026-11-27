import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestHead } from "./github-checks.js";
import {
  AUTOFIX_MAX_ATTEMPTS_CEILING,
  DEFAULT_AUTOFIX_MAX_ATTEMPTS,
  checkAutofixPushTarget,
  decideAttempt,
  enableAutofix,
  recordAutofixPush,
  type AutofixState,
} from "./pr-autofix-guard.js";
import { AutofixStore, autofixKey } from "./pr-autofix-store.js";

const NOW = new Date("2026-11-27T12:00:00Z");

function pr(over: Partial<PullRequestHead> = {}): PullRequestHead {
  return {
    number: 42,
    title: "Fix lint",
    state: "open",
    htmlUrl: "https://github.com/acme/widgets/pull/42",
    headRef: "feat/x",
    headSha: "sha0",
    headRepo: "acme/widgets",
    baseRef: "main",
    ...over,
  };
}

function target(over: Partial<PullRequestHead> = {}, defaultBranch = "main") {
  return checkAutofixPushTarget({
    pr: pr(over),
    repoSlug: "acme/widgets",
    defaultBranch,
    enabledHeadRef: over.headRef ?? "feat/x",
  });
}

describe("checkAutofixPushTarget", () => {
  it("allows the open PR's own head branch", () => {
    expect(target()).toEqual({ ok: true, target: "feat/x" });
  });

  it("refuses the repository's default branch", () => {
    const res = target({ headRef: "release", baseRef: "develop2" }, "release");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/default or a protected branch/);
  });

  it("refuses main and master even when the default branch is something else", () => {
    for (const headRef of ["main", "master"]) {
      const res = target({ headRef, baseRef: "next" }, "trunk-x");
      expect(res.ok, headRef).toBe(false);
    }
  });

  it("refuses the PR's base branch", () => {
    const res = target({ headRef: "staging", baseRef: "staging" });
    expect(!res.ok && res.reason).toMatch(/base branch/);
  });

  it("refuses a fork's branch and a closed PR", () => {
    expect(target({ headRepo: "someone/widgets" }).ok).toBe(false);
    expect(target({ headRepo: "" }).ok).toBe(false);
    expect(target({ state: "closed" }).ok).toBe(false);
  });

  it("refuses when the PR now points at another branch than the one enabled", () => {
    const res = checkAutofixPushTarget({
      pr: pr({ headRef: "feat/y" }),
      repoSlug: "acme/widgets",
      defaultBranch: "main",
      enabledHeadRef: "feat/x",
    });
    expect(!res.ok && res.reason).toMatch(/enable it again/);
  });
});

describe("attempt cap", () => {
  it("is off until enabled", () => {
    const res = decideAttempt(undefined, "sha0", NOW);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/opt-in/);
  });

  it("allows 3 pushes by default, then pauses", () => {
    let state: AutofixState = enableAutofix("feat/x", undefined, NOW);
    expect(state.maxAttempts).toBe(DEFAULT_AUTOFIX_MAX_ATTEMPTS);
    let remote = "sha0";
    for (let i = 1; i <= 3; i++) {
      const d = decideAttempt(state, remote, NOW);
      expect(d.ok, `attempt ${i}`).toBe(true);
      const before = remote;
      remote = `fix${i}`;
      state = recordAutofixPush(d.state, remote, before, NOW);
      expect(state.attempts).toBe(i);
    }
    expect(state.paused).toBe(true);
    const fourth = decideAttempt(state, remote, NOW);
    expect(fourth.ok).toBe(false);
    expect(!fourth.ok && fourth.reason).toMatch(/paused after 3 of 3/);
  });

  it("restarts the count when a person pushes a new head", () => {
    let state = enableAutofix("feat/x", 1, NOW);
    state = recordAutofixPush(state, "fix1", "sha0", NOW);
    expect(decideAttempt(state, "fix1", NOW).ok).toBe(false);
    const after = decideAttempt(state, "human2", NOW);
    expect(after.ok).toBe(true);
    expect(after.ok && after.resetByHumanPush).toBe(true);
    expect(after.state.attempts).toBe(0);
  });

  it("a lagging GitHub head (still the pre-push sha) is not a person's push: attempts and pause stay", () => {
    let state = enableAutofix("feat/x", 2, NOW);
    state = recordAutofixPush(state, "fix1", "sha0", NOW);
    expect(state.prevHeadSha).toBe("sha0");
    // GET /pulls/N has not caught up with our push yet and still says sha0.
    const lagging = decideAttempt(state, "sha0", NOW);
    expect(lagging.ok).toBe(true);
    expect(lagging.ok && lagging.resetByHumanPush).toBe(false);
    expect(lagging.state.attempts).toBe(1);
    state = recordAutofixPush(lagging.state, "fix2", "sha0", NOW);
    expect(state).toMatchObject({ attempts: 2, paused: true });
    const stillLagging = decideAttempt(state, "sha0", NOW);
    expect(stillLagging.ok).toBe(false);
    expect(!stillLagging.ok && stillLagging.reason).toMatch(/paused after 2 of 2/);
    expect(stillLagging.state).toMatchObject({ attempts: 2, paused: true });
  });

  it("a third sha (neither our push nor the head before it) resets the count and the pause", () => {
    let state = enableAutofix("feat/x", 1, NOW);
    state = recordAutofixPush(state, "fix1", "sha0", NOW);
    expect(state.paused).toBe(true);
    const moved = decideAttempt(state, "human2", NOW);
    expect(moved.ok).toBe(true);
    expect(moved.ok && moved.resetByHumanPush).toBe(true);
    expect(moved.state).toMatchObject({ attempts: 0, paused: false, lastPushedSha: null, prevHeadSha: null });
  });

  it("clamps maxAttempts to 1..ceiling and resets on re-enable", () => {
    expect(enableAutofix("b", 0, NOW).maxAttempts).toBe(1);
    expect(enableAutofix("b", 99, NOW).maxAttempts).toBe(AUTOFIX_MAX_ATTEMPTS_CEILING);
    const paused = recordAutofixPush(enableAutofix("b", 1, NOW), "s", "s0", NOW);
    expect(paused.paused).toBe(true);
    const again = enableAutofix("b", 1, NOW);
    expect(again).toMatchObject({ attempts: 0, paused: false, enabled: true, lastPushedSha: null, prevHeadSha: null });
  });
});

describe("AutofixStore", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps state per PR across store instances", async () => {
    dir = await mkdtemp(join(tmpdir(), "autofix-store-"));
    const key = autofixKey("Acme/Widgets", 42);
    expect(key).toBe("acme/widgets#42");
    await new AutofixStore(dir).set(key, enableAutofix("feat/x", 2, NOW));
    const read = await new AutofixStore(dir).get(key);
    expect(read).toMatchObject({ enabled: true, maxAttempts: 2, headRef: "feat/x" });
    expect(await new AutofixStore(dir).get(autofixKey("acme/widgets", 7))).toBeUndefined();
  });
});
