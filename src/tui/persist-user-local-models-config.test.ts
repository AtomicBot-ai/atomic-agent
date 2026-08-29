import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  isLoopbackBaseUrl,
  normalizeLocalLlmBaseUrl,
  persistUserLocalModelsConfig,
  persistUserLocalLlmUrl,
  persistUserRemoteLlmUrls,
  pointsAtManagedDaemon,
} from "./persist-user-local-models-config.js";

describe("normalizeLocalLlmBaseUrl", () => {
  it("adds http when scheme is missing", () => {
    expect(normalizeLocalLlmBaseUrl("127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  it("preserves https", () => {
    expect(normalizeLocalLlmBaseUrl("https://example.com/v1/")).toBe(
      "https://example.com/v1/",
    );
  });

  it("rejects empty input", () => {
    expect(() => normalizeLocalLlmBaseUrl("  ")).toThrow("empty");
  });
});

describe("persistUserLocalLlmUrl", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-local-llm-persist-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("updates localModels.url in the user config file and refreshes the cache", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    persistUserLocalLlmUrl("http://192.168.1.5:7777");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: { url: string; mode: string };
    };
    expect(written.localModels.url).toBe("http://192.168.1.5:7777");
    expect(written.localModels.mode).toBe("external");
    expect(getConfig().localModels.url).toBe("http://192.168.1.5:7777");
  });

  it("keeps the local-llama provider URL synced to the managed port", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          {
            id: "openrouter",
            kind: "openrouter",
            apiKey: "test-key",
            defaultChatModel: "openai/gpt-4o-mini",
          },
        ],
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
      },
    });
    resetConfigCache();

    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { port: 20123 },
    });

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      llm: { providers: Array<{ id: string; url?: string; baseUrl?: string }> };
    };
    const local = written.llm.providers.find(
      (provider) => provider.id === "local-llama",
    );
    expect(local?.url).toBe("http://127.0.0.1:20123");
    expect(local?.baseUrl).toBe("http://127.0.0.1:19092");
  });

  it("persists remote chat and embedding llama.cpp URLs", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();

    persistUserRemoteLlmUrls({
      chatUrl: "http://10.0.0.10:8080",
      embeddingUrl: "http://10.0.0.11:19092",
    });

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: {
        url: string;
        mode: string;
        embeddings: { enabled: boolean; modelId: string | null; url: string };
      };
      memory: { embeddings: { enabled: boolean } };
    };

    expect(written.localModels.mode).toBe("external");
    expect(written.localModels.url).toBe("http://10.0.0.10:8080");
    expect(written.localModels.embeddings.enabled).toBe(true);
    expect(written.localModels.embeddings.modelId).toBe("nomic-embed-text-v1.5");
    expect(written.localModels.embeddings.url).toBe("http://10.0.0.11:19092");
    expect(written.memory.embeddings.enabled).toBe(true);
    expect(getConfig().localModels.embeddings.url).toBe("http://10.0.0.11:19092");
  });

  it("persists remote chat URL without enabling optional embeddings", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();

    persistUserRemoteLlmUrls({
      chatUrl: "http://10.0.0.10:8080",
    });

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: {
        url: string;
        mode: string;
        embeddings: { enabled: boolean; modelId: string | null };
      };
      memory: { embeddings: { enabled: boolean } };
    };

    expect(written.localModels.mode).toBe("external");
    expect(written.localModels.url).toBe("http://10.0.0.10:8080");
    expect(written.localModels.embeddings.enabled).toBe(false);
    expect(written.localModels.embeddings.modelId).toBeNull();
    expect(written.memory.embeddings.enabled).toBe(false);
  });

  it("routes chat at local-llama when an llm block routes elsewhere", () => {
    // Only reachable through the startup gate, i.e. when NO cloud
    // provider is ready (see isCloudTextProviderReady) — e.g. a LAN
    // openai-compatible entry without a key. In that shape the wizard
    // used to write the URL and leave the dead cloud route active, so
    // the saved address was inert.
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "lan-compat",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
          {
            id: "lan-compat",
            kind: "openai-compatible",
            baseUrl: "http://192.168.1.50:8080/v1",
            defaultChatModel: "some-model",
          },
        ],
      },
    });
    resetConfigCache();

    persistUserRemoteLlmUrls({ chatUrl: "http://192.168.1.50:8080" });

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      llm: {
        activeTextProvider: string;
        providers: Array<{ id: string; url?: string }>;
      };
    };
    expect(written.llm.activeTextProvider).toBe("local-llama");
    // syncLocalLlamaProviderUrl must carry the saved URL into the entry
    // the provider registry actually builds from.
    const local = written.llm.providers.find((p) => p.id === "local-llama");
    expect(local?.url).toBe("http://192.168.1.50:8080");
  });

  it("leaves a file without an llm block alone (default route already local)", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();

    persistUserRemoteLlmUrls({ chatUrl: "http://10.0.0.10:8080" });

    const written = JSON.parse(readFileSync(path, "utf8")) as {
      llm?: unknown;
    };
    // No llm block means the runtime synthesizes local-llama as the
    // active route; writing one here would only freeze defaults.
    expect(written.llm).toBeUndefined();
  });
});

describe("isLoopbackBaseUrl", () => {
  it("is true for every on-machine host at any port", () => {
    for (const url of [
      "http://127.0.0.1:9931",
      "http://0.0.0.0:8080",
      "http://localhost:1234",
      "http://LOCALHOST:1234",
      "http://box.localhost:9931",
      "http://[::1]:9931",
      "http://[::1]",
      "localhost:9931", // typed without a scheme
      "127.0.0.1:9931",
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(true);
    }
  });

  it("is false for remote hosts and unparseable input", () => {
    for (const url of [
      "https://api.example.com",
      "http://192.168.1.50:8000",
      "http://notlocalhost.com",
      "http://localhost.evil.com", // suffix trick must not pass
      "",
      "   ",
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(false);
    }
  });
});

describe("pointsAtManagedDaemon", () => {
  it("matches the managed port on every loopback spelling", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(pointsAtManagedDaemon(`http://${host}:19091`, 19091)).toBe(true);
    }
  });

  it("rejects another port, another host, and unparseable input", () => {
    expect(pointsAtManagedDaemon("http://127.0.0.1:8080", 19091)).toBe(false);
    expect(pointsAtManagedDaemon("http://192.168.1.50:19091", 19091)).toBe(false);
    expect(pointsAtManagedDaemon("not a url", 19091)).toBe(false);
  });
});
