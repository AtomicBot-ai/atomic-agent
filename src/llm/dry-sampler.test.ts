import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  USER_CONFIG_DEFAULTS,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
} from "../config/index.js";
import {
  DRY_ALLOWED_LENGTH,
  DRY_BASE,
  DRY_MULTIPLIER,
  DRY_PENALTY_LAST_N,
  drySamplerFields,
} from "./dry-sampler.js";
import { LlamaServerClient } from "./llama-server-client.js";
import { buildOpenAiChatBody } from "./provider/openai/openai-build-body.js";

const DRY_KEYS = [
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
] as const;

function capturingClient(
  bodies: Array<Record<string, unknown>>,
  drySampler?: boolean,
): LlamaServerClient {
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: "x", stop: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new LlamaServerClient({
    baseUrl: "http://127.0.0.1:9999",
    fetchImpl,
    ...(drySampler !== undefined ? { drySampler } : {}),
  });
}

function expectNoDryFields(body: Record<string, unknown> | undefined): void {
  for (const key of DRY_KEYS) expect(body).not.toHaveProperty(key);
}

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

describe("drySamplerFields (ATO-332)", () => {
  it("uses the agreed DRY settings and a fixed, positive 256-token window", () => {
    expect(drySamplerFields()).toEqual({
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: 256,
    });
    expect([DRY_MULTIPLIER, DRY_BASE, DRY_ALLOWED_LENGTH, DRY_PENALTY_LAST_N]).toEqual([0.8, 1.75, 2, 256]);
  });
});

describe("LlamaServerClient with the DRY sampler flag (ATO-332)", () => {
  it("sends the DRY fields with a fixed 256-token window, whatever n_predict is", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = capturingClient(bodies, true);
    await client.complete({ prompt: "p", maxTokens: 2048 });
    await client.complete({ prompt: "p", maxOutputTokens: 12_000 });
    await client.complete({ prompt: "p" });
    // `0` means no cap (n_predict -1); the window must stay positive,
    // since llama-server answers 400 to dry_penalty_last_n -1.
    await client.complete({ prompt: "p", maxTokens: 0 });
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toMatchObject({
      n_predict: 2048,
      dry_multiplier: 0.8,
      dry_base: 1.75,
      dry_allowed_length: 2,
      dry_penalty_last_n: 256,
    });
    expect(bodies[1]?.n_predict).toBe(12_000);
    expect(bodies[3]?.n_predict).toBe(-1);
    for (const body of bodies) expect(body.dry_penalty_last_n).toBe(256);
    // The existing repetition settings stay as they were.
    expect(bodies[0]?.repeat_penalty).toBe(1.1);
    expect(bodies[0]?.repeat_last_n).toBe(256);
  });

  it("reads localModels.drySampler from the config when the client has no override", async () => {
    getConfig().localModels.drySampler = true;
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).complete({ prompt: "p", maxTokens: 512 });
    expect(bodies[0]?.dry_penalty_last_n).toBe(256);
    expect(bodies[0]?.dry_multiplier).toBe(0.8);
  });

  it("keeps the window at 256 when localModels.completionMaxTokens is 0 (no cap)", async () => {
    getConfig().localModels.drySampler = true;
    getConfig().localModels.completionMaxTokens = 0;
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).complete({ prompt: "p" });
    expect(bodies[0]?.n_predict).toBe(-1);
    expect(bodies[0]?.dry_penalty_last_n).toBe(256);
  });

  it("sends no DRY field when the flag is off or absent", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await capturingClient(bodies).complete({ prompt: "p", maxTokens: 512 });
    await capturingClient(bodies, false).complete({ prompt: "p", maxTokens: 512 });
    getConfig().localModels.drySampler = undefined;
    await capturingClient(bodies).complete({ prompt: "p", maxTokens: 512 });
    // An explicit `false` on the client wins over a config that says on.
    getConfig().localModels.drySampler = true;
    await capturingClient(bodies, false).complete({ prompt: "p", maxTokens: 512 });
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expectNoDryFields(body);
  });
});

// Regression guard: the OpenAI-compatible body builder (Ollama, cloud)
// does not read the flag today; this pins that it never starts to.
describe("OpenAI-compatible bodies stay free of DRY fields (regression guard)", () => {
  it("never carries DRY fields, even with localModels.drySampler on", () => {
    getConfig().localModels.drySampler = true;
    expectNoDryFields(buildOpenAiChatBody({ prompt: "hi", maxTokens: 512 }, "qwen3.5:4b", false));
    expectNoDryFields(buildOpenAiChatBody({ prompt: "hi", maxTokens: 512 }, "gpt-5-2", true));
  });
});

describe("localModels.drySampler config", () => {
  it("defaults to off, also for a file written before the field existed", () => {
    expect(USER_CONFIG_DEFAULTS.localModels.drySampler).toBe(false);
    expect(parseUserConfigFile({}).localModels.drySampler).toBe(false);
    expect(parseUserConfigFile({ version: 77, localModels: { thinking: "on" } }).localModels.drySampler).toBe(false);
  });

  it("accepts a boolean and rejects anything else", () => {
    expect(parseUserConfigFile({ localModels: { drySampler: true } }).localModels.drySampler).toBe(true);
    expect(parseUserConfigFile({ localModels: { drySampler: "on" } }).localModels.drySampler).toBe(true);
    expect(() => parseUserConfigFile({ localModels: { drySampler: 3 } })).toThrow(/localModels\.drySampler/);
  });
});
