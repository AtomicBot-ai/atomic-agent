import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "./config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "./config-file.js";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import { getConfig } from "./index.js";
import {
  dotenvKeyForProviderKind,
  LlmRemoveActiveProviderError,
  parseAddProviderJson,
  removeLlmProvider,
  restoreProviderDefaultChatModelInConfig,
  setProviderDefaultChatModelInConfig,
} from "./llm-provider-commands.js";

describe("llm-provider-commands", () => {
  it("maps every credential kind to its dotenv key", () => {
    expect(dotenvKeyForProviderKind("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(dotenvKeyForProviderKind("aimlapi")).toBe("AIMLAPI_API_KEY");
    expect(dotenvKeyForProviderKind("gemini")).toBe("GEMINI_API_KEY");
    expect(dotenvKeyForProviderKind("openai-compatible")).toBe(
      "OPENAI_COMPAT_API_KEY",
    );
  });

  it("parses a bare aimlapi provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "aimlapi",
        kind: "aimlapi",
        defaultChatModel: "openai/gpt-5-2",
      }),
    );
    expect(entry.id).toBe("aimlapi");
    expect(entry.kind).toBe("aimlapi");
  });

  it("parses a bare openrouter provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "openrouter",
        kind: "openrouter",
        defaultChatModel: "openai/gpt-4o-mini",
      }),
    );
    expect(entry.id).toBe("openrouter");
    expect(entry.kind).toBe("openrouter");
  });

  it("parses llm.providers envelope with one entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        llm: {
          providers: [
            {
              id: "cloud",
              kind: "openai-compatible",
              baseUrl: "https://api.example.com/v1",
              defaultChatModel: "gpt-4o",
            },
          ],
        },
      }),
    );
    expect(entry.id).toBe("cloud");
  });
});

/**
 * `restoreProviderDefaultChatModelInConfig` is the undo half of
 * `setProviderDefaultChatModelInConfig`, and the only writer that can
 * express *unset* — which is why it exists and why it is tested here
 * against a real config file rather than only through the callers that
 * happen to use it.
 */
describe("restoreProviderDefaultChatModelInConfig", () => {
  let stateDir: string;

  function write(defaultChatModel?: string): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "cloud",
        activeEmbeddingProvider: "cloud",
        toolTransport: "auto",
        providers: [
          {
            id: "cloud",
            kind: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            ...(defaultChatModel === undefined ? {} : { defaultChatModel }),
          },
          { id: "other", kind: "openrouter", defaultChatModel: "keep/me" },
        ],
      },
    });
    resetConfigCache();
  }

  /** The raw file, to tell "key absent" from "key present as undefined". */
  function rawProvider(id: string): Record<string, unknown> {
    const file = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as { llm: { providers: Array<Record<string, unknown>> } };
    const entry = file.llm.providers.find((p) => p.id === id);
    if (!entry) throw new Error(`no provider ${id} in the written file`);
    return entry;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-persist-llm-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("puts a previous model id back", () => {
    write("was-here");
    setProviderDefaultChatModelInConfig("cloud", "rejected-later");
    restoreProviderDefaultChatModelInConfig("cloud", "was-here");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "cloud")
        ?.defaultChatModel,
    ).toBe("was-here");
  });

  it("removes the key when there was no previous pin", () => {
    // The state `setProviderDefaultChatModelInConfig` cannot reach: it
    // refuses an empty id, so without this function a rollback could
    // only ever overwrite, never clear.
    write();
    expect(() => setProviderDefaultChatModelInConfig("cloud", " ")).toThrow(
      /empty/,
    );
    setProviderDefaultChatModelInConfig("cloud", "rejected-later");
    expect(rawProvider("cloud").defaultChatModel).toBe("rejected-later");

    restoreProviderDefaultChatModelInConfig("cloud", undefined);
    // Deleted outright, not written as `null` or `""` — the config
    // parser and every reader treat those differently from absent.
    expect(rawProvider("cloud")).not.toHaveProperty("defaultChatModel");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "cloud")
        ?.defaultChatModel,
    ).toBeUndefined();
  });

  it("leaves every other provider alone", () => {
    write("was-here");
    restoreProviderDefaultChatModelInConfig("cloud", undefined);
    expect(rawProvider("other").defaultChatModel).toBe("keep/me");
  });

  it("is a no-op for a provider id that is not configured", () => {
    // A rollback path must not throw a second error over the first one
    // it is trying to report.
    write("was-here");
    expect(() =>
      restoreProviderDefaultChatModelInConfig("ghost", "anything"),
    ).not.toThrow();
    expect(rawProvider("cloud").defaultChatModel).toBe("was-here");
  });
});

/**
 * `removeLlmProvider` backs the LLM tab's `d` on a Cloud provider row
 * (reported on Discord: "I can't delete a cloud provider"). Tested
 * against a real config file because the failure it guards against is
 * a file the loader refuses to read back.
 */
describe("removeLlmProvider", () => {
  let stateDir: string;

  function write(
    fallback?: Record<string, unknown>,
    active: { text?: string; embedding?: string } = {},
  ): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: active.text ?? "openrouter",
        activeEmbeddingProvider: active.embedding ?? "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server" },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openai/gpt-4o-mini",
          },
          {
            id: "groq",
            kind: "openai-compatible",
            baseUrl: "https://api.groq.com/openai/v1",
            apiKeyEnvVar: "GROQ_API_KEY",
          },
        ],
        ...(fallback ? { fallback } : {}),
      },
    } as never);
    resetConfigCache();
  }

  function rawLlm(): Record<string, unknown> {
    const file = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as { llm: Record<string, unknown> };
    return file.llm;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-remove-llm-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("drops the provider from llm.providers and persists it", () => {
    write();
    removeLlmProvider("groq");
    expect(getConfig().llm?.providers.map((p) => p.id)).toEqual([
      "local-llama",
      "openrouter",
    ]);
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
  });

  it("drops it from the fallback chain so the config still loads", () => {
    // Before: the id stayed in `llm.fallback.chain`, and the loader
    // rejects a chain id that is not a configured provider, so the next
    // config read threw instead of returning the remaining providers.
    write({
      chain: ["openrouter", "groq"],
      appendLocal: false,
      failureThreshold: 3,
    });
    removeLlmProvider("groq");
    expect(rawLlm().fallback).toEqual({
      chain: ["openrouter"],
      appendLocal: false,
      failureThreshold: 3,
    });
    expect(() => getConfig()).not.toThrow();
    expect(getConfig().llm?.providers.map((p) => p.id)).not.toContain("groq");
  });

  it("omits a chain that ends up empty and keeps the other knobs", () => {
    write({ chain: ["groq"], appendLocal: true });
    removeLlmProvider("groq");
    expect(rawLlm().fallback).toEqual({ appendLocal: true });
    expect(() => getConfig()).not.toThrow();
  });

  it("drops the fallback block when the chain was all it held", () => {
    write({ chain: ["groq"] });
    removeLlmProvider("groq");
    expect(rawLlm()).not.toHaveProperty("fallback");
    expect(() => getConfig()).not.toThrow();
  });

  it("refuses the active text provider by the file it reads, not the cache", () => {
    // Prime the cache with local-llama as the chat provider, then switch
    // to openrouter on disk without resetting it, the way another
    // process (Telegram `/model`, a second TUI) would. Before: the
    // removal went through and silently re-pointed chat at local-llama.
    write(undefined, { text: "local-llama" });
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    const path = getUserConfigPath(stateDir);
    const live = JSON.parse(readFileSync(path, "utf8")) as {
      llm: Record<string, unknown>;
    };
    live.llm.activeTextProvider = "openrouter";
    writeFileSync(path, JSON.stringify(live, null, 2) + "\n", "utf8");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    const before = readFileSync(path);

    expect(() => removeLlmProvider("openrouter")).toThrow(
      LlmRemoveActiveProviderError,
    );
    expect(() => removeLlmProvider("openrouter")).toThrow(
      /openrouter is the active provider; switch/,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("moves the embedding provider back to local-llama when it is removed", () => {
    write(undefined, { embedding: "groq" });
    removeLlmProvider("groq");
    expect(rawLlm().activeEmbeddingProvider).toBe("local-llama");
    expect(rawLlm().activeTextProvider).toBe("openrouter");
  });

  it("refuses the built-in local provider", () => {
    write();
    expect(() => removeLlmProvider("local-llama")).toThrow(/built-in/);
    expect(getConfig().llm?.providers.map((p) => p.id)).toContain(
      "local-llama",
    );
  });
});
