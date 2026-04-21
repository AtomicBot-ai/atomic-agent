import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./load-config.js";
import { resetConfigCache } from "./config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import { USER_CONFIG_VERSION } from "./config-schema.js";

describe("loadConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-load-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_LLAMA_API_KEY;
    delete process.env.ATOMIC_AGENT_BROWSER_CHANNEL;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("creates a defaults-only config on first run", () => {
    const config = loadConfig();
    const path = getUserConfigPath(stateDir);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.version).toBe(USER_CONFIG_VERSION);
    expect(config.llama.url).toBe("http://127.0.0.1:8080");
    expect(config.log.level).toBe("info");
    expect(config.agent.approvalRequired).toBe(true);
  });

  it("reads values from an existing user config file", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      version: USER_CONFIG_VERSION,
      llama: { url: "http://llama.internal:4444" },
      log: { level: "debug" },
      agent: {
        tokenBudget: 3000,
        maxSteps: 42,
        toolTimeoutMs: 12_000,
        approvalRequired: false,
      },
    });
    const config = loadConfig();
    expect(config.llama.url).toBe("http://llama.internal:4444");
    expect(config.log.level).toBe("debug");
    expect(config.agent.maxSteps).toBe(42);
    expect(config.agent.toolTimeoutMs).toBe(12_000);
    expect(config.agent.approvalRequired).toBe(false);
  });

  it("keeps non-user-facing knobs on environment variables", () => {
    process.env.ATOMIC_AGENT_LLAMA_API_KEY = "secret";
    process.env.ATOMIC_AGENT_BROWSER_CHANNEL = "msedge";
    const config = loadConfig();
    expect(config.llama.apiKey).toBe("secret");
    expect(config.browser.channel).toBe("msedge");
  });

  it("paths point at the state dir and config file", () => {
    const config = loadConfig();
    expect(config.paths.stateDir).toBe(stateDir);
    expect(config.paths.userConfigFile).toBe(getUserConfigPath(stateDir));
    expect(config.paths.browserProfileDir).toBe(
      join(stateDir, "browser-profile"),
    );
  });
});
