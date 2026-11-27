import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "./config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import { getConfig } from "./index.js";
import {
  setFallbackAppendLocalInConfig,
  setFallbackChainInConfig,
  setFallbackLocalFirstInConfig,
} from "./llm-provider-commands.js";

/**
 * ATO-2434: `llm.fallback.localFirst` gets its own writer for the TUI
 * switch, and every other writer of the `llm.fallback` block keeps it.
 * Run against a real config file: the failure guarded against is a flag
 * dropped (or a block the loader refuses) on the next read.
 */
describe("setFallbackLocalFirstInConfig", () => {
  let stateDir: string;

  function write(fallback?: Record<string, unknown>): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server" },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openai/gpt-4o-mini",
          },
        ],
        ...(fallback ? { fallback } : {}),
      },
    } as never);
    resetConfigCache();
  }

  function rawFallback(): Record<string, unknown> | undefined {
    const file = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as { llm?: { fallback?: Record<string, unknown> } };
    return file.llm?.fallback;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-local-first-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("turns the flag on and keeps the chain, appendLocal and timing knobs", () => {
    write({
      chain: ["openrouter"],
      appendLocal: true,
      failureThreshold: 4,
      cooldownMs: [1000, 2000],
    });
    setFallbackLocalFirstInConfig(true);
    expect(rawFallback()).toEqual({
      chain: ["openrouter"],
      appendLocal: true,
      localFirst: true,
      failureThreshold: 4,
      cooldownMs: [1000, 2000],
    });
    expect(getConfig().llm?.fallback?.localFirst).toBe(true);
  });

  it("turns the flag off again", () => {
    write({ chain: ["openrouter"], localFirst: true });
    setFallbackLocalFirstInConfig(false);
    expect(rawFallback()).toEqual({ chain: ["openrouter"], localFirst: false });
  });

  it("writes the flag when the file has no fallback block yet", () => {
    write();
    setFallbackLocalFirstInConfig(true);
    expect(rawFallback()).toEqual({ localFirst: true });
    expect(() => getConfig()).not.toThrow();
  });

  it("writes a default llm block on a file that has none", () => {
    writeFileSync(getUserConfigPath(stateDir), "{}\n", "utf8");
    resetConfigCache();
    setFallbackLocalFirstInConfig(true);
    expect(rawFallback()).toEqual({ localFirst: true });
  });

  it("is kept by the chain edit the Fallback pane writes", () => {
    write({ chain: ["openrouter"], localFirst: true });
    setFallbackChainInConfig(["openrouter", "local-llama"], false);
    expect(rawFallback()).toMatchObject({
      chain: ["openrouter", "local-llama"],
      appendLocal: false,
      localFirst: true,
    });
  });

  it("is kept by the appendLocal-only write", () => {
    write({ chain: ["openrouter"], localFirst: true, appendLocal: true });
    setFallbackAppendLocalInConfig(false);
    expect(rawFallback()).toMatchObject({ appendLocal: false, localFirst: true });
  });
});
