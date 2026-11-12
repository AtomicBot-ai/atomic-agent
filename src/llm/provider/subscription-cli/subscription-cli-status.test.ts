import { describe, expect, it } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import { codexCliAdapter } from "./codex-cli-adapter.js";
import type { CliRunOptions, CliRunner } from "./run-cli-completion.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";
import { checkSubscriptionCli, configuredSubscriptionBinPath } from "./subscription-cli-status.js";

/** A fake CLI: `--version` and `login status` answer from the table; nothing is spawned. */
function fakeRunner(answers: Record<string, string | Error>): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = async (o: CliRunOptions) => {
    calls.push([...o.args]);
    const a = answers[o.args.join(" ")];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unexpected argv ${o.args.join(" ")}`);
    return { stdout: a, stderr: "", exitCode: 0, durationMs: 1 };
  };
  return { run, calls };
}

const notInstalled = (bin: string) => new SubscriptionCliNotInstalledError(bin, "install it", "X");
const noFiles = { exists: () => false, readText: () => null, home: "/Users/nadia", platform: "darwin" as const, env: {} };

describe("checkSubscriptionCli (ATO-1200)", () => {
  it("missing: the binary is not there, and the install command is the fix", async () => {
    const { run } = fakeRunner({ "--version": notInstalled("codex") });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "missing", installed: false, version: null, fix: "npm install -g @openai/codex" });
  });

  it("missing Claude on Windows gets the PowerShell installer", async () => {
    const { run } = fakeRunner({ "--version": notInstalled("claude") });
    const r = await checkSubscriptionCli(claudeCliAdapter, { run, ...noFiles, platform: "win32", env: { PATH: "" } });
    expect(r.fix).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("Codex signed out: `codex login status` exits non-zero", async () => {
    const { run, calls } = fakeRunner({
      "--version": "codex-cli 0.46.0\n",
      "login status": new SubscriptionCliAuthError("Not logged in", "codex login"),
    });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "signed_out", version: "0.46.0", signedIn: false, loginCheck: "command", fix: "codex login" });
    expect(calls).toEqual([["--version"], ["login", "status"]]);
  });

  it("Codex ready: signed in with ChatGPT", async () => {
    const { run } = fakeRunner({ "--version": "codex-cli 0.46.0", "login status": "Logged in using ChatGPT" });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "ready", signedIn: true, fix: null, version: "0.46.0" });
  });

  it("Codex on an API key is not the plan, and the key never reaches the report", async () => {
    const { run } = fakeRunner({ "--version": "codex-cli 0.46.0", "login status": "Logged in using an API key - sk-proj-SECRET123" });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "signed_out", apiKeyLogin: true, fix: "codex login" });
    expect(JSON.stringify(r)).not.toContain("SECRET123");
  });

  it("a login check that hangs is unknown, not signed out", async () => {
    const { run } = fakeRunner({
      "--version": "codex-cli 0.46.0",
      "login status": new SubscriptionCliInvocationError('"codex" timed out after 5000ms', null),
    });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "unknown", installed: true, signedIn: null });
  });

  it("a login check that crashes or is refused is unknown, not signed out", async () => {
    for (const failure of [
      new SubscriptionCliInvocationError('"codex" exited with code 134: Abort trap', 134),
      new Error("EACCES: permission denied"),
    ]) {
      const { run } = fakeRunner({ "--version": "codex-cli 0.46.0", "login status": failure });
      const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
      expect(r).toMatchObject({ state: "unknown", signedIn: null, fix: null });
    }
  });

  it("Claude never runs a turn: only --version, then its account file", async () => {
    const { run, calls } = fakeRunner({ "--version": "2.1.3 (Claude Code)" });
    const files: Record<string, string> = { "/Users/nadia/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "x" } }) };
    const r = await checkSubscriptionCli(claudeCliAdapter, {
      run, platform: "darwin", env: {}, home: "/Users/nadia",
      exists: (p) => p in files, readText: (p) => files[p] ?? null,
    });
    expect(calls).toEqual([["--version"]]);
    expect(r).toMatchObject({ state: "ready", version: "2.1.3", signedIn: true, loginCheck: "file" });
    expect(JSON.stringify(r)).not.toContain("emailAddress");
  });

  it("Claude with no account file is signed out", async () => {
    const { run } = fakeRunner({ "--version": "2.1.3 (Claude Code)" });
    const r = await checkSubscriptionCli(claudeCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "signed_out", signedIn: false, loginCheck: "file" });
  });

  it("Claude with an unreadable account file says it can't verify the login, and spends nothing", async () => {
    const { run, calls } = fakeRunner({ "--version": "2.1.3 (Claude Code)" });
    const r = await checkSubscriptionCli(claudeCliAdapter, {
      run, platform: "darwin", env: {}, home: "/Users/nadia",
      exists: (p) => p === "/Users/nadia/.claude.json", readText: () => "{not json",
    });
    expect(calls).toEqual([["--version"]]);
    expect(r).toMatchObject({ state: "unknown", signedIn: null, loginCheck: "none" });
    expect(r.message).toMatch(/Can't verify the login/);
  });

  it("a --version that fails is installed-but-unknown, never missing", async () => {
    const { run } = fakeRunner({ "--version": new SubscriptionCliInvocationError("exit 3", 3) });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(r).toMatchObject({ state: "unknown", installed: true });
  });

  it("names, never values, of a set billing variable", async () => {
    const { run } = fakeRunner({ "--version": "codex-cli 0.46.0", "login status": "Logged in using ChatGPT" });
    const r = await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles, env: { OPENAI_API_KEY: "sk-live-xyz" } });
    expect(r.billingEnvSet).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(r)).not.toContain("sk-live-xyz");
  });

  it("strips the billing variables from the child, as a turn would", async () => {
    let strip: readonly string[] | undefined;
    const run: CliRunner = async (o) => { strip = o.stripEnv; return { stdout: "0.46.0", stderr: "", exitCode: 0, durationMs: 1 }; };
    await checkSubscriptionCli(codexCliAdapter, { run, ...noFiles });
    expect(strip).toEqual(codexCliAdapter.billingEnvKeys);
  });
});

describe("configuredSubscriptionBinPath", () => {
  const providers = [
    { id: "a", subscriptionCli: { cli: "codex", binPath: "/a/codex" } },
    { id: "b", subscriptionCli: { cli: "codex", binPath: "/b/codex" } },
    { id: "c", subscriptionCli: { cli: "claude" } },
  ];
  it("prefers the entry being edited, else the first with a path", () => {
    expect(configuredSubscriptionBinPath(providers, "codex", "b")).toBe("/b/codex");
    expect(configuredSubscriptionBinPath(providers, "codex", null)).toBe("/a/codex");
    expect(configuredSubscriptionBinPath(providers, "claude")).toBeUndefined();
    expect(configuredSubscriptionBinPath(undefined, "codex")).toBeUndefined();
  });
});
