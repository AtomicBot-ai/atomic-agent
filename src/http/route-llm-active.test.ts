import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const PROVIDERS = [
  { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:9" },
  {
    id: "openrouter",
    kind: "openrouter",
    apiKey: "k",
    defaultChatModel: "vendor/model-a",
  },
  { id: "no-key", kind: "openrouter", defaultChatModel: "vendor/model-a" },
];

describe("POST /api/llm/active", () => {
  let harness: Harness;
  let configPath: string;

  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    harness = await startTestHarness();
    configPath = join(harness.stateDir, "config.json");
    // Written after boot, as the desktop does before it asks for the
    // switch: the route has to pick up a provider the agent never built.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...USER_CONFIG_DEFAULTS,
          llm: { activeTextProvider: "local-llama", providers: PROVIDERS },
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    await harness.cleanup();
  });

  function post(body: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}/api/llm/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function onDisk(): Record<string, any> {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }

  it("switches the live provider and model without a restart", async () => {
    const response = await post({ providerId: "openrouter", model: "vendor/model-b" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, providerId: "openrouter", model: "vendor/model-b" });
    expect(typeof body.ms).toBe("number");
    expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("openrouter");
    const llm = onDisk().llm;
    expect(llm.activeTextProvider).toBe("openrouter");
    expect(llm.providers.find((p: { id: string }) => p.id === "openrouter").defaultChatModel)
      .toBe("vendor/model-b");
  });

  it("keeps the provider's own model when none is given", async () => {
    const response = await post({ providerId: "openrouter" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "vendor/model-a" });
  });

  it("refuses while a turn is in progress, and changes nothing", async () => {
    vi.spyOn(harness.runtime.turnController, "busySessionIds").mockReturnValue(["s1"]);
    const response = await post({ providerId: "openrouter", model: "vendor/model-b" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("turn_in_progress");
    expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("local-llama");
    expect(onDisk().llm.providers[1].defaultChatModel).toBe("vendor/model-a");
  });

  it("rolls back and answers 500 when the provider cannot be built", async () => {
    vi.spyOn(harness.runtime, "reloadLlmProviders").mockRejectedValue(new Error("boom"));
    const response = await post({ providerId: "openrouter", model: "vendor/model-b" });
    expect(response.status).toBe(500);
    expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("local-llama");
    const llm = onDisk().llm;
    expect(llm.activeTextProvider).toBe("local-llama");
    expect(llm.providers.find((p: { id: string }) => p.id === "openrouter").defaultChatModel)
      .toBe("vendor/model-a");
  });

  it("answers 404 for a provider that is not configured", async () => {
    const response = await post({ providerId: "nope" });
    expect(response.status).toBe(404);
  });

  it("refuses a provider without a key, and a model pin on llama-server", async () => {
    expect((await post({ providerId: "no-key" })).status).toBe(400);
    expect((await post({ providerId: "local-llama", model: "x" })).status).toBe(400);
    expect(harness.runtime.providerRegistry.activeTextProviderId).toBe("local-llama");
  });

  it("validates the body", async () => {
    expect((await post([])).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ providerId: "openrouter", model: 3 })).status).toBe(400);
    expect((await post({ providerId: "openrouter", model: "  " })).status).toBe(400);
  });
});
