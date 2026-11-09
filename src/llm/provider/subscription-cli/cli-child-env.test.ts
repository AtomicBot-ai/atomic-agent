import { describe, expect, it } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import { cliChildEnv, withBinaryDirOnPath } from "./cli-child-env.js";
import { codexCliAdapter } from "./codex-cli-adapter.js";

describe("cliChildEnv", () => {
  it("drops the listed variables and keeps everything else", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-agent",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    };
    expect(
      cliChildEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"], base),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("matches without regard to case, as Windows does", () => {
    const base = { Path: "C:\\bin", Anthropic_Api_Key: "sk-ant-agent" };
    expect(cliChildEnv(["ANTHROPIC_API_KEY"], base)).toEqual({
      Path: "C:\\bin",
    });
  });

  it("never mutates the agent's own environment", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-agent" };
    cliChildEnv(["ANTHROPIC_API_KEY"], base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-agent");
  });

  it("hands the environment back whole when nothing is listed", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-agent" };
    expect(cliChildEnv(undefined, base)).toBe(base);
    expect(cliChildEnv([], base)).toBe(base);
  });
});

describe("billingEnvKeys", () => {
  it("keeps claude on the subscription it is signed in with", () => {
    // Any of these makes `claude` bill per token or talk to another
    // endpoint instead of the /login subscription (ATO-176).
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(claudeCliAdapter.billingEnvKeys).toContain(key);
    }
    // The subscription's own long-lived token must still reach it.
    expect(claudeCliAdapter.billingEnvKeys).not.toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  it("keeps codex on the ChatGPT login", () => {
    expect(codexCliAdapter.billingEnvKeys).toContain("OPENAI_API_KEY");
    expect(codexCliAdapter.billingEnvKeys).toContain("CODEX_API_KEY");
  });
});

describe("withBinaryDirOnPath (ATO-756)", () => {
  it("appends a pathed CLI's folder, so its `env node` shebang finds node", () => {
    const env = { PATH: "/usr/bin:/bin", HOME: "/Users/n" };
    expect(withBinaryDirOnPath(env, "/opt/homebrew/bin/claude", "darwin")).toEqual({
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: "/Users/n",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("leaves a bare name, and a folder already on PATH, alone", () => {
    const env = { PATH: "/usr/bin:/opt/homebrew/bin" };
    expect(withBinaryDirOnPath(env, "claude", "darwin")).toBe(env);
    expect(withBinaryDirOnPath(env, "/opt/homebrew/bin/claude", "darwin")).toBe(env);
  });

  it("uses Windows' Path key and separator", () => {
    expect(
      withBinaryDirOnPath({ Path: "C:\\Windows" }, "C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd", "win32"),
    ).toEqual({ Path: "C:\\Windows;C:\\Users\\n\\AppData\\Roaming\\npm" });
  });
});
