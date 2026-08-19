import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import type { UserConfigFile } from "../config/config-schema.js";
import { RunModePersistError, setRunModeInConfig } from "./persist-run-mode.js";

const TWO_LEG_LLM = {
  activeTextProvider: "local-llama",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto" as const,
  providers: [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" },
  ],
};

describe("setRunModeInConfig", () => {
  let stateDir: string;

  const written = (): UserConfigFile =>
    JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as UserConfigFile;

  const seed = (llm: unknown): void => {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      ...(llm ? { llm } : {}),
    } as UserConfigFile);
    resetConfigCache();
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-run-mode-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    seed(TWO_LEG_LLM);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("moves the mode AND the active provider in one write", () => {
    // The load-bearing invariant: `resolveRunMode` only honours a stored
    // fusion while the cloud leg is active, so persisting one key
    // without the other leaves the file disagreeing with the runtime.
    setRunModeInConfig({ mode: "fusion", primaryProviderId: "openrouter" });
    const file = written();
    expect(file.llm?.runMode?.mode).toBe("fusion");
    expect(file.llm?.activeTextProvider).toBe("openrouter");
  });

  it("stores the dial when one is supplied", () => {
    setRunModeInConfig({
      mode: "fusion",
      primaryProviderId: "openrouter",
      cloudShare: 75,
    });
    expect(written().llm?.runMode?.fusion?.cloudShare).toBe(75);
  });

  it("leaves an existing dial alone when none is supplied", () => {
    setRunModeInConfig({
      mode: "fusion",
      primaryProviderId: "openrouter",
      cloudShare: 75,
    });
    setRunModeInConfig({ mode: "local", primaryProviderId: "local-llama" });
    const file = written();
    expect(file.llm?.runMode?.mode).toBe("local");
    expect(file.llm?.runMode?.fusion?.cloudShare).toBe(75);
  });

  it("preserves unrelated runMode keys", () => {
    seed({
      ...TWO_LEG_LLM,
      runMode: { mode: "local", cloudProvider: "openrouter" },
    });
    setRunModeInConfig({ mode: "cloud", primaryProviderId: "openrouter" });
    expect(written().llm?.runMode?.cloudProvider).toBe("openrouter");
  });

  it("preserves the rest of the llm block", () => {
    setRunModeInConfig({ mode: "cloud", primaryProviderId: "openrouter" });
    expect(written().llm?.providers).toHaveLength(2);
    expect(written().llm?.toolTransport).toBe("auto");
  });

  it("writes a file that parses back cleanly", () => {
    setRunModeInConfig({
      mode: "fusion",
      primaryProviderId: "openrouter",
      cloudShare: 40,
    });
    resetConfigCache();
    // A round-trip through the real parser: a write that produced an
    // invalid block would throw here rather than at the next boot.
    expect(() => written()).not.toThrow();
    expect(written().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: { cloudShare: 40 },
    });
  });

  it("refuses a provider that is not configured", () => {
    expect(() =>
      setRunModeInConfig({ mode: "cloud", primaryProviderId: "anthropic" }),
    ).toThrow(RunModePersistError);
  });

  it("refuses to write when there is no llm block at all", () => {
    seed(undefined);
    expect(() =>
      setRunModeInConfig({ mode: "cloud", primaryProviderId: "openrouter" }),
    ).toThrow(/add a provider first/);
  });
});
