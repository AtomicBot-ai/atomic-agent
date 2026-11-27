import { describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import type { CompletionRequest, CompletionResult } from "../llm/provider/completion-types.js";
import { fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import type { BuiltSpecs, ModelSpec } from "../llm/toolcall-bench/index.js";
import { councilPriceLookup } from "./council-pricing.js";
import { COUNCIL_MAX_QUESTION_CHARS, runRuntimeCouncil } from "./council-service.js";
import { PLAIN_COMPLETE_MAX_TIMEOUT_MS, type PlainCompleteInput } from "./plain-complete.js";

const CONFIG = {
  localModels: { url: "http://127.0.0.1:8080" },
  llm: {
    activeTextProvider: "local",
    activeEmbeddingProvider: "local",
    providers: [
      { id: "local", kind: "llama-server" },
      {
        id: "or",
        kind: "openrouter",
        userModels: [{ id: "pricey", kind: "chat", pricing: { input: 100, output: 100 } }],
      },
    ],
    toolTransport: "auto",
  },
} as unknown as AtomicAgentConfig;

function result(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: null,
  };
}

function harness() {
  const plain: PlainCompleteInput[] = [];
  const cloud: CompletionRequest[] = [];
  const built: string[][] = [];
  const completePlain = vi.fn(async (input: PlainCompleteInput) => {
    plain.push(input);
    return { ok: true as const, text: `local answer ${plain.length}` };
  });
  const build = vi.fn(async (_config: AtomicAgentConfig, specs: readonly ModelSpec[]): Promise<BuiltSpecs> => {
    built.push(specs.map((s) => s.spec));
    const providers = new Map(
      specs.map((s) => [
        s.spec,
        fakeProvider("p", "native_tools", async (request) => {
          cloud.push(request);
          return result("cloud answer");
        }),
      ]),
    );
    return { providers, refused: [] };
  });
  return { plain, cloud, built, completePlain, build };
}

describe("runRuntimeCouncil (ATO-2432)", () => {
  it("sends the chat's own model through completePlain and builds only the others", async () => {
    const h = harness();
    const res = await runRuntimeCouncil(
      { question: "Which db?", models: "local*2,or:cheap", rank: false, chairman: null },
      { config: CONFIG, completePlain: h.completePlain, build: h.build },
    );
    expect(res.ok).toBe(true);
    expect(h.built).toEqual([["or:cheap"]]);
    // Two local answers at their Self-MoA temperatures, then the judge (the first seat, local).
    expect(h.plain.slice(0, 2).map((p) => p.temperature)).toEqual([undefined, 0.7]);
    expect(h.plain.every((p) => p.timeoutMs === PLAIN_COMPLETE_MAX_TIMEOUT_MS)).toBe(true);
    expect(h.plain).toHaveLength(3);
    expect(h.cloud).toHaveLength(1);
    expect(res.ok && res.report?.answers.map((a) => a.model)).toEqual(["local #1", "local #2", "or:cheap"]);
  });

  it("seats the chat's model three times when no models are named", async () => {
    const h = harness();
    const res = await runRuntimeCouncil(
      { question: "q", rank: false, chairman: null },
      { config: CONFIG, completePlain: h.completePlain, build: h.build },
    );
    expect(res.ok && res.report?.seats.map((s) => s.id)).toEqual(["local #1", "local #2", "local #3"]);
    expect(h.build).not.toHaveBeenCalled();
    expect(res.ok && res.forecast.free).toEqual(["local"]);
  });

  it("stops before any request when the forecast is over max_usd", async () => {
    const h = harness();
    const forecasts: string[] = [];
    const res = await runRuntimeCouncil(
      { question: "q", models: "or:pricey*3", maxUsd: 0.01, onForecast: (line) => forecasts.push(line) },
      { config: CONFIG, completePlain: h.completePlain, build: h.build },
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/over the \$0\.01 limit; nothing was sent/);
    expect(forecasts).toHaveLength(1);
    expect(h.build).not.toHaveBeenCalled();
    expect(h.completePlain).not.toHaveBeenCalled();
  });

  it("only forecasts on forecastOnly", async () => {
    const h = harness();
    const res = await runRuntimeCouncil(
      { question: "q", models: "or:pricey*2", forecastOnly: true },
      { config: CONFIG, completePlain: h.completePlain, build: h.build },
    );
    expect(res.ok && res.report).toBeUndefined();
    expect(res.ok && res.forecast.maxUsd).toBeGreaterThan(0);
    expect(h.build).not.toHaveBeenCalled();
  });

  it("refuses an empty or overlong question and a bad seat list", async () => {
    const deps = { config: CONFIG };
    expect(await runRuntimeCouncil({ question: "  " }, deps)).toEqual({ ok: false, reason: "nothing to ask" });
    const long = await runRuntimeCouncil({ question: "x".repeat(COUNCIL_MAX_QUESTION_CHARS + 1) }, deps);
    expect(long.ok).toBe(false);
    expect((await runRuntimeCouncil({ question: "q", models: "a*0" }, deps)).ok).toBe(false);
  });
});

describe("councilPriceLookup", () => {
  it("prices userModels, frees the local link and calls the rest unknown", () => {
    const priceOf = councilPriceLookup(CONFIG);
    expect(priceOf("local")).toEqual({ kind: "free" });
    expect(priceOf("or:pricey")).toEqual({ kind: "priced", pricing: { input: 100, output: 100 } });
    expect(priceOf("nope")).toEqual({ kind: "unknown" });
  });
});
