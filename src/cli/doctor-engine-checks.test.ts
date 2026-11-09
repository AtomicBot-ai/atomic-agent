import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import { runEngineChecks, verifyTargetForEntry, type EngineProbes } from "./doctor-engine-checks.js";

// resolveLlmProviderApiKey (src/config/resolve-llm-api-key.ts) falls back to
// these env vars when a provider entry carries no inline apiKey, so an
// OPENROUTER_API_KEY exported in the shell would turn the keyless cases below
// from `warn` into `ok`. Clear them for the suite and restore on teardown.
const PROVIDER_KEY_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
] as const;
const savedProviderKeyEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const name of PROVIDER_KEY_ENV_VARS) {
    savedProviderKeyEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterAll(() => {
  for (const [name, value] of savedProviderKeyEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function cfg(over: { mode?: string; modelId?: string | null; active?: string; providers?: unknown[] } = {}): AtomicAgentConfig {
  return {
    paths: { localModelsDataDir: "/data/models" },
    localModels: {
      mode: over.mode ?? "managed",
      url: "http://127.0.0.1:19091",
      managed: { modelId: over.modelId === undefined ? "qwen-3.5-4b" : over.modelId, port: 19091, engine: "atomic-core" },
    },
    llm: {
      activeTextProvider: over.active ?? "local-llama",
      activeEmbeddingProvider: "local-llama",
      providers: over.providers ?? [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }],
    },
  } as unknown as AtomicAgentConfig;
}

function probes(over: Partial<EngineProbes> = {}): EngineProbes {
  return {
    daemonStatus: async () => ({ running: false, pid: null, port: 19091, healthy: false, loading: false }),
    backendInstalled: () => true,
    modelDownloaded: () => true,
    minRamGb: () => 6,
    totalRamGb: () => 32,
    portFree: async () => true,
    reachable: async () => true,
    verifyKey: async () => ({ status: "ok", probedModel: "m", httpStatus: 200, detail: "", latencyMs: 1 }),
    ...over,
  };
}

const by = (fs: Awaited<ReturnType<typeof runEngineChecks>>, check: string) => fs.find((f) => f.check === check);

describe("doctor engine checks (ATO-577)", () => {
  it("a healthy stopped install is all ok", async () => {
    const fs = await runEngineChecks(cfg(), probes());
    expect(fs.every((f) => f.status === "ok")).toBe(true);
    expect(by(fs, "server")?.message).toContain("port 19091 is free");
  });

  it("a missing engine, model and a taken port fail with the command that fixes them", async () => {
    const fs = await runEngineChecks(cfg(), probes({ backendInstalled: () => false, modelDownloaded: () => false, portFree: async () => false }));
    expect(by(fs, "engine")).toMatchObject({ status: "fail", message: expect.stringContaining("atag models update") });
    expect(by(fs, "model")).toMatchObject({ status: "fail", message: expect.stringContaining("atag models pull qwen-3.5-4b") });
    expect(by(fs, "server")).toMatchObject({ status: "fail", message: expect.stringContaining("taken by another program") });
  });

  it("too little memory is a warning", async () => {
    const fs = await runEngineChecks(cfg(), probes({ totalRamGb: () => 4 }));
    expect(by(fs, "memory")?.status).toBe("warn");
  });

  it("a server that rejects the key fails", async () => {
    const fs = await runEngineChecks(cfg(), probes({ daemonStatus: async () => ({ running: true, pid: 1, port: 19091, healthy: false, loading: false, authMismatch: true }) }));
    expect(by(fs, "server")?.status).toBe("fail");
  });

  it("external mode asks the server", async () => {
    const fs = await runEngineChecks(cfg({ mode: "external" }), probes({ reachable: async () => false }));
    expect(fs).toEqual([expect.objectContaining({ check: "engine", status: "fail" })]);
  });

  it("an active cloud provider gets its key tested; a rejected key fails", async () => {
    const cloud = { id: "or", kind: "openrouter", apiKey: "sk-test", defaultChatModel: "x/y" };
    const seen: string[] = [];
    const fs = await runEngineChecks(cfg({ active: "or", providers: [cloud] }), probes({
      verifyKey: async (t) => { seen.push(t.baseUrl); return { status: "invalid_key", probedModel: null, httpStatus: 401, detail: "", latencyMs: 1 }; },
    }));
    expect(seen).toEqual(["https://openrouter.ai/api"]);
    expect(by(fs, "key")).toMatchObject({ status: "fail", message: expect.stringContaining("rejected the key (HTTP 401)") });
    expect(by(fs, "engine")).toBeUndefined();
  });

  it("no key is a warning; a provider kind doctor cannot test is not called keyless", async () => {
    const noKey = await runEngineChecks(cfg({ active: "or", providers: [{ id: "or", kind: "openrouter" }] }), probes());
    expect(by(noKey, "key")).toMatchObject({ status: "warn", message: expect.stringContaining("no API key") });
    const cli = await runEngineChecks(cfg({ active: "cc", providers: [{ id: "cc", kind: "subscription-cli" }] }), probes());
    expect(by(cli, "key")).toMatchObject({ status: "ok", message: expect.stringContaining("does not test") });
  });

  it("an own (custom) model is not called on disk", async () => {
    const fs = await runEngineChecks(cfg({ modelId: "my-hf-model" }), probes({ modelDownloaded: () => null }));
    expect(by(fs, "model")?.status).toBe("warn");
  });

  it("a loopback openai-compatible server is not tested", () => {
    expect(verifyTargetForEntry({ id: "c", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k" })).toBeNull();
    expect(verifyTargetForEntry({ id: "c", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", apiKey: "k" })?.baseUrl).toBeTruthy();
  });
});
