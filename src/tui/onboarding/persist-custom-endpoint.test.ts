import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  customEndpointKeyWizard,
  freeProviderId,
  providerIdForEndpoint,
  saveCustomOpenAiCompatEndpoint,
} from "./persist-custom-endpoint.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("providerIdForEndpoint", () => {
  it("turns a host into a valid provider id", () => {
    expect(providerIdForEndpoint("https://models.example.com/v1")).toBe(
      "models-example-com",
    );
    expect(providerIdForEndpoint("http://192.168.1.20:8080")).toBe(
      "custom-192-168-1-20-8080",
    );
  });

  it("always starts with a letter, as the config rule requires", () => {
    expect(providerIdForEndpoint("http://192.168.1.20:8080")).toMatch(
      /^[a-z][a-z0-9-]{0,31}$/,
    );
  });
});

describe("freeProviderId", () => {
  it("suffixes a taken id", () => {
    expect(freeProviderId("https://models.example.com", [])).toBe(
      "models-example-com",
    );
    expect(
      freeProviderId("https://models.example.com", ["models-example-com"]),
    ).toBe("models-example-com-2");
  });
});

describe("customEndpointKeyWizard", () => {
  it("opens the provider wizard on the key screen with the URL filled in", () => {
    const wizard = customEndpointKeyWizard("https://models.think.evroc.com");
    expect(wizard.phase).toBe("api_key");
    expect(wizard.kind).toBe("openai-compatible");
    expect(wizard.baseUrlLine).toBe("https://models.think.evroc.com");
    expect(wizard.mode).toBe("add");
  });
});

describe("saveCustomOpenAiCompatEndpoint", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atag-custom-endpoint-"));
    prev = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = dir;
    resetConfigCache();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = prev;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves an OpenAI-compatible endpoint as the active provider", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/v1/models")
        ? jsonResponse({ data: [{ id: "gpt-x" }] })
        : new Response("404", { status: 404 }),
    );
    const saved = await saveCustomOpenAiCompatEndpoint(
      "https://models.example.com/v1",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(saved).not.toBeNull();
    expect(saved!.entry).toMatchObject({
      kind: "openai-compatible",
      baseUrl: "https://models.example.com",
      defaultChatModel: "gpt-x",
    });
    const config = getConfig();
    expect(config.llm?.activeTextProvider).toBe(saved!.entry.id);
    expect(
      config.llm?.providers.find((p) => p.id === saved!.entry.id),
    ).toMatchObject({ kind: "openai-compatible", baseUrl: "https://models.example.com" });
  });

  it("returns null for a llama-server, so the caller keeps its own error", async () => {
    const fetchImpl = vi.fn(async () => new Response("404", { status: 404 }));
    expect(
      await saveCustomOpenAiCompatEndpoint("http://127.0.0.1:9931", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(getConfig().llm?.activeTextProvider).not.toBe("models-example-com");
  });

  it("returns null when the server lists no models", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    expect(
      await saveCustomOpenAiCompatEndpoint("https://empty.example.com", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});
