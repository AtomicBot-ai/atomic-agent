import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import { isCloudTextProviderReady } from "./run-local-models-config-wizard.js";

describe("isCloudTextProviderReady", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "startup-gate-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  it("treats an active cloud text provider with an env key as ready", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats an active keyless local preset entry as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama",
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("resolves suffixed preset entry ids to their local preset", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama-2",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama-2",
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats a manual keyless entry with a loopback base URL as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "my-ollama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "my-ollama",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats a native ollama entry without a base URL as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama",
            kind: "ollama",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("does not treat a keyless remote openai-compatible entry as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "groq",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "groq",
            kind: "openai-compatible",
            baseUrl: "https://api.groq.com/openai",
            defaultChatModel: "llama-3.3-70b-versatile",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });

  it("does not treat keyless Ollama Cloud as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama-cloud",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama-cloud",
            kind: "openai-compatible",
            baseUrl: "https://ollama.com",
            defaultChatModel: "qwen3.6:cloud",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });

  it("does not treat an active cloud text provider without a key as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });
});
