import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import { codexCliAdapter } from "./codex-cli-adapter.js";
import {
  checkCliVersionOnce,
  compareCliVersions,
  minimumCliVersion,
  noteOutdatedCli,
  parseCliVersion,
  resetCliVersionChecks,
  type CliVersionCheckInput,
  type CliVersionVerdict,
} from "./cli-version-check.js";
import type { CliRunOptions, CliRunOutcome, CliRunner } from "./run-cli-completion.js";
import type { CliStreamRunner } from "./stream-cli-completion.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";
import { SubscriptionCliProvider } from "./subscription-cli-provider.js";

afterEach(() => {
  resetCliVersionChecks();
  vi.useRealTimers();
});

const answer = (stdout: string): CliRunOutcome => ({ stdout, stderr: "", exitCode: 0, durationMs: 1 });

function input(run: CliRunner, overrides: Partial<CliVersionCheckInput> = {}): CliVersionCheckInput {
  return {
    cli: "claude",
    productName: "Claude Code",
    binary: "/opt/bin/claude",
    cwd: "/tmp",
    run,
    installHint: "",
    authHint: "",
    stripEnv: [],
    platform: "darwin",
    ...overrides,
  };
}

describe("versions (ATO-1685)", () => {
  it("reads both CLIs' --version output", () => {
    expect(parseCliVersion("2.1.328 (Claude Code)\n")).toBe("2.1.328");
    expect(parseCliVersion("codex-cli 0.172.0")).toBe("0.172.0");
    expect(parseCliVersion("no version here")).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareCliVersions("2.1.9", "2.1.22")).toBeLessThan(0);
    expect(compareCliVersions("0.122.0", "0.122.0")).toBe(0);
    expect(compareCliVersions("0.130.1", "0.122.0")).toBeGreaterThan(0);
  });

  it("asks more of Claude Code on Windows, where older builds need Git for Windows", () => {
    expect(minimumCliVersion("claude", "darwin")).toBe("2.1.22");
    expect(minimumCliVersion("claude", "win32")).toBe("2.1.120");
    expect(minimumCliVersion("codex", "win32")).toBe("0.122.0");
    expect(minimumCliVersion("codex", "linux")).toBe("0.122.0");
  });
});

describe("checkCliVersionOnce (ATO-1685)", () => {
  it("says an old CLI is outdated, with the update command", async () => {
    const run = vi.fn(async (_o: CliRunOptions) => answer("codex-cli 0.121.0"));
    const verdict = await checkCliVersionOnce(
      input(run, { cli: "codex", productName: "Codex", binary: "/opt/bin/codex" }),
    );
    expect(verdict).toMatchObject({ version: "0.121.0", minimum: "0.122.0", outdated: true });
    expect(verdict.message).toContain("Codex 0.121.0 is older than 0.122.0");
    expect(verdict.message).toContain("npm install -g @openai/codex@latest");
    expect(run.mock.calls[0]?.[0]).toMatchObject({ args: ["--version"], timeoutMs: 3_000 });
    expect((run.mock.calls[0]?.[0] as CliRunOptions).input).toBeUndefined();
  });

  it("has nothing to say about a current CLI", async () => {
    const verdict = await checkCliVersionOnce(input(async () => answer("2.1.328 (Claude Code)")));
    expect(verdict).toEqual({ version: "2.1.328", minimum: "2.1.22", outdated: false, message: null });
  });

  it("runs once per process and binary", async () => {
    const run = vi.fn(async (_o: CliRunOptions) => answer("2.1.0 (Claude Code)"));
    await checkCliVersionOnce(input(run));
    await checkCliVersionOnce(input(run));
    expect(run).toHaveBeenCalledTimes(1);
    await checkCliVersionOnce(input(run, { binary: "/other/claude" }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never rejects: a missing or broken CLI is no version", async () => {
    const missing = await checkCliVersionOnce(
      input(async () => {
        throw new SubscriptionCliNotInstalledError("claude");
      }),
    );
    expect(missing).toMatchObject({ version: null, outdated: false, message: null });
  });

  it("gives up at the cap when the CLI never answers", async () => {
    vi.useFakeTimers();
    const pending = checkCliVersionOnce(input(() => new Promise<CliRunOutcome>(() => {})));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ version: null, outdated: false });
  });
});

const outdated: CliVersionVerdict = {
  version: "2.1.0",
  minimum: "2.1.22",
  outdated: true,
  message: "Claude Code 2.1.0 is older than 2.1.22, the oldest version Atomic Agent works with. Update it with `claude update`, then retry.",
};

describe("noteOutdatedCli (ATO-1685)", () => {
  it("puts the sentence in front of a failed run and flags it", () => {
    const err = new SubscriptionCliInvocationError('"claude" exited with code 1: no output', 1);
    noteOutdatedCli(err, outdated);
    expect(err.message.startsWith("Claude Code 2.1.0 is older than 2.1.22")).toBe(true);
    // Still ends with the CLI's own words, which the error report reads.
    expect(err.message.endsWith(": no output")).toBe(true);
    expect((err as unknown as { cliVersionOutdated?: boolean }).cliVersionOutdated).toBe(true);
  });

  it("leaves a sign-in, a spent limit and a current CLI alone", () => {
    const auth = new SubscriptionCliAuthError("claude", "Run /login.");
    const before = auth.message;
    noteOutdatedCli(auth, outdated);
    expect(auth.message).toBe(before);
    const limit = new SubscriptionCliInvocationError("claude reported error: usage limit reached", null, "reported_error");
    noteOutdatedCli(limit, outdated);
    expect(limit.message).not.toContain("older than");
    const plain = new SubscriptionCliInvocationError("boom", 1);
    noteOutdatedCli(plain, { ...outdated, outdated: false, message: null });
    expect(plain.message).toBe("boom");
  });
});

const SUCCESS = JSON.stringify({ subtype: "success", is_error: false, result: "hi", usage: {} });

describe("SubscriptionCliProvider and the version check (ATO-1685)", () => {
  it("checks once before the first turn and says an outdated CLI once", async () => {
    const versionCheck = vi.fn(async (_i: CliVersionCheckInput) => outdated);
    const notices: string[] = [];
    const provider = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      runCliImpl: async () => answer(SUCCESS),
      versionCheck,
      onNotice: (m) => notices.push(m),
    });
    await provider.complete({ prompt: "p" } as never);
    await provider.complete({ prompt: "p" } as never);
    expect(versionCheck).toHaveBeenCalledTimes(1);
    expect(versionCheck.mock.calls[0]?.[0]).toMatchObject({ cli: "claude", productName: "Claude Code" });
    expect(notices).toEqual([outdated.message]);
  });

  it("does not fail a turn on a current CLI, and prefixes a failed run on an old one", async () => {
    const provider = new SubscriptionCliProvider({
      id: "codex-cli",
      descriptor: codexCliAdapter,
      cwd: "/tmp",
      runCliImpl: async () => {
        throw new SubscriptionCliInvocationError("\"codex\" exited with code 2: error: unexpected argument '--ignore-user-config' found", 2);
      },
      versionCheck: async () => ({ ...outdated, message: "Codex 0.121.0 is older than 0.122.0." }),
    });
    await expect(provider.complete({ prompt: "p" } as never)).rejects.toThrow(/^Codex 0\.121\.0 is older than 0\.122\.0\./);
  });

  it("prefixes a failed streamed run too", async () => {
    const streamCliImpl: CliStreamRunner = async function* () {
      yield "";
      throw new SubscriptionCliInvocationError('"claude" exited with code 1: no output', 1);
    };
    const provider = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      streamCliImpl,
      versionCheck: async () => outdated,
    });
    const iterator = provider.completeStream({ prompt: "p" } as never);
    await expect(
      (async () => {
        let next = await iterator.next();
        while (!next.done) next = await iterator.next();
      })(),
    ).rejects.toThrow(/^Claude Code 2\.1\.0 is older than 2\.1\.22/);
  });

  it("is off when a test injects a runner, so no real CLI is spawned", async () => {
    const calls: CliRunOptions[] = [];
    const provider = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      runCliImpl: async (o) => {
        calls.push(o);
        return answer(SUCCESS);
      },
    });
    await provider.complete({ prompt: "p" } as never);
    expect(calls.map((c) => c.args[0])).not.toContain("--version");
    expect(calls).toHaveLength(1);
  });
});
