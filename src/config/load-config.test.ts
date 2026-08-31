import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./load-config.js";
import { resetConfigCache } from "./config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import {
  ENV_DEFAULTS,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
} from "./config-schema.js";

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
    delete process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS;
    delete process.env.ATOMIC_AGENT_BROWSER_CHANNEL;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
    delete process.env.ATOMIC_LOADCONFIG_TEST_KEY;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("creates a defaults-only config on first run", () => {
    const config = loadConfig();
    const path = getUserConfigPath(stateDir);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.version).toBe(USER_CONFIG_VERSION);
    expect(config.localModels.url).toBe("http://127.0.0.1:8080");
    expect(config.localModels.completionMaxTokens).toBe(8192);
    expect(config.log.level).toBe("info");
    expect(config.agent.approvalLevel).toBe(1);
  });

  it("maps ATOMIC_AGENT_LLAMA_MAX_TOKENS to completionMaxTokens with bounds", () => {
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "8192";
    resetConfigCache();
    expect(loadConfig().localModels.completionMaxTokens).toBe(8192);
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "10";
    resetConfigCache();
    expect(loadConfig().localModels.completionMaxTokens).toBe(64);
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "999999999";
    resetConfigCache();
    expect(loadConfig().localModels.completionMaxTokens).toBe(131_072);
  });

  it("clamps ATOMIC_AGENT_SKILLS_CATALOG_BUDGET to a positive range", () => {
    // The budget multiplies into the skill catalog's char cap; 0 or a
    // negative value would collapse the catalog, so the loader clamps.
    expect(loadConfig().skills.catalogTokenBudget).toBe(
      ENV_DEFAULTS.SKILLS_CATALOG_BUDGET,
    );
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "0";
    resetConfigCache();
    expect(loadConfig().skills.catalogTokenBudget).toBe(1);
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "-64";
    resetConfigCache();
    expect(loadConfig().skills.catalogTokenBudget).toBe(1);
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "999999999";
    resetConfigCache();
    expect(loadConfig().skills.catalogTokenBudget).toBe(100_000);
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "2048";
    resetConfigCache();
    expect(loadConfig().skills.catalogTokenBudget).toBe(2048);
  });

  it("reads localModels.completionMaxTokens from the user config file", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        completionMaxTokens: 8192,
      },
    });
    resetConfigCache();
    expect(loadConfig().localModels.completionMaxTokens).toBe(8192);
  });

  it("ATOMIC_AGENT_LLAMA_MAX_TOKENS overrides the file value", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        completionMaxTokens: 8192,
      },
    });
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "16384";
    resetConfigCache();
    expect(loadConfig().localModels.completionMaxTokens).toBe(16_384);
  });

  it("reads values from an existing user config file", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        url: "http://llama.internal:4444",
      },
      log: { level: "debug" },
      agent: {
        ...USER_CONFIG_DEFAULTS.agent,
        tokenBudget: 3000,
        maxSteps: 42,
        toolTimeoutMs: 12_000,
        approvalLevel: 5,
      },
    });
    const config = loadConfig();
    expect(config.localModels.url).toBe("http://llama.internal:4444");
    expect(config.log.level).toBe("debug");
    expect(config.agent.maxSteps).toBe(42);
    expect(config.agent.toolTimeoutMs).toBe(12_000);
    expect(config.agent.approvalLevel).toBe(5);
  });

  it("keeps non-user-facing knobs on environment variables", () => {
    process.env.ATOMIC_AGENT_LLAMA_API_KEY = "secret";
    process.env.ATOMIC_AGENT_BROWSER_CHANNEL = "msedge";
    const config = loadConfig();
    expect(config.localModels.apiKey).toBe("secret");
    expect(config.browser.channel).toBe("msedge");
  });

  it("paths point at the state dir and config file", () => {
    const config = loadConfig();
    expect(config.paths.stateDir).toBe(stateDir);
    expect(config.paths.userConfigFile).toBe(getUserConfigPath(stateDir));
    expect(config.paths.browserProfileDir).toBe(
      join(stateDir, "browser-profile"),
    );
    expect(config.paths.tracesDir).toBe(join(stateDir, "traces"));
  });

  it("tracing.trace defaults expose the per-session NDJSON dir", () => {
    const config = loadConfig();
    expect(config.tracing.trace.enabled).toBeNull();
    expect(config.tracing.trace.dir).toBe(join(stateDir, "traces"));
    expect(config.tracing.trace.maxBytesPerSession).toBe(10 * 1024 * 1024);
  });

  it("honours user-pinned tracing.trace.enabled", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      tracing: { trace: { enabled: false, maxBytesPerSession: 4096 } },
    });
    const config = loadConfig();
    expect(config.tracing.trace.enabled).toBe(false);
    expect(config.tracing.trace.maxBytesPerSession).toBe(4096);
  });

  it("overrides localModels.url to localhost when mode is managed", () => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        url: "http://127.0.0.1:8080",
        mode: "managed",
        managed: {
          ...USER_CONFIG_DEFAULTS.localModels.managed,
          port: 19_000,
        },
      },
    });
    resetConfigCache();
    const config = loadConfig();
    expect(config.localModels.mode).toBe("managed");
    expect(config.localModels.url).toBe("http://127.0.0.1:19000");
    expect(config.paths.localModelsDataDir).toBe(join(stateDir, "models"));
  });

  it("carries the .env load outcome as config.dotenv", () => {
    delete process.env.ATOMIC_LOADCONFIG_TEST_KEY;
    writeFileSync(
      join(stateDir, ".env"),
      "ATOMIC_LOADCONFIG_TEST_KEY=from-file\n",
      "utf8",
    );

    const config = loadConfig();

    expect(config.dotenv.path).toBe(join(stateDir, ".env"));
    expect(config.dotenv.exists).toBe(true);
    expect(config.dotenv.loaded).toContain("ATOMIC_LOADCONFIG_TEST_KEY");
    expect(config.dotenv.error).toBeNull();
    expect(process.env.ATOMIC_LOADCONFIG_TEST_KEY).toBe("from-file");
  });

  it("reports an unreadable .env in config.dotenv.error without throwing", () => {
    // A directory named `.env` is the portable stand-in for a file that
    // exists but cannot be read: readFileSync fails with EISDIR on POSIX
    // and an access-denied flavour on Windows. Real EPERM needs ACL
    // tricks that do not survive root test runs or CI images.
    mkdirSync(join(stateDir, ".env"));

    const config = loadConfig();

    expect(config.dotenv.exists).toBe(false);
    expect(config.dotenv.loaded).toEqual([]);
    expect(config.dotenv.error).not.toBeNull();
    expect(config.dotenv.error?.code).toMatch(/^(EISDIR|EACCES|EPERM)$/);
    expect(config.dotenv.error?.attempts).toBeGreaterThanOrEqual(1);
  });

  it("uses localModelsDataDir override when set", () => {
    const override = join(stateDir, "custom-local-llm");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        managed: {
          ...USER_CONFIG_DEFAULTS.localModels.managed,
          dataDirOverride: override,
        },
      },
    });
    resetConfigCache();
    expect(loadConfig().paths.localModelsDataDir).toBe(override);
  });

  it("resolves grammarsDir without consulting the working directory", () => {
    // The Ctrl+N "new terminal window" spawn starts the agent by absolute
    // path from the operator's home, so cwd holds no `grammars/` and the
    // old cwd-relative default died on ENOENT tool-call.gbnf. Standing in
    // an empty temp dir reproduces exactly that shape.
    const elsewhere = mkdtempSync(join(tmpdir(), "atomic-cwd-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      resetConfigCache();
      const grammarsDir = loadConfig().paths.grammarsDir;
      expect(grammarsDir.startsWith(elsewhere)).toBe(false);
      expect(existsSync(join(grammarsDir, "tool-call.gbnf"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("still lets ATOMIC_AGENT_GRAMMARS_DIR win over the packaged copy", () => {
    const override = join(stateDir, "custom-grammars");
    mkdirSync(override);
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = override;
    resetConfigCache();
    expect(loadConfig().paths.grammarsDir).toBe(override);
  });
});
