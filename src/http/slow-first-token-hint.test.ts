import { describe, expect, it } from "vitest";

import type { LocalModelDef } from "../local-llm/index.js";
import { buildSlowFirstTokenHint, runsOnLocalModel, type HintConfig } from "./slow-first-token-hint.js";

/**
 * ATO-1027: what a host may offer when a local model is slow to start —
 * a lighter catalog model, the cloud — read from the config, never acted on.
 */
const model = (id: string, fileSizeGb: number, extra: Partial<LocalModelDef> = {}): LocalModelDef =>
  ({ id, name: `${id} name`, fileSizeGb, family: "qwen", ...extra }) as LocalModelDef;

const MODELS: LocalModelDef[] = [
  model("big-27b", 17.6),
  model("mid-12b", 9.0),
  model("small-9b", 5.3),
  model("tiny-4b", 2.7),
  model("free-27b", 8.0, { uncensored: true }),
  model("custom-mine", 10.0, { family: "custom" }),
];

function config(over: { llm?: unknown; modelId?: string | null; mode?: "managed" | "external" } = {}): HintConfig {
  return {
    ...(over.llm !== undefined ? { llm: over.llm } : {}),
    localModels: {
      mode: over.mode ?? "managed",
      managed: { modelId: over.modelId === undefined ? "big-27b" : over.modelId },
    },
    paths: { localModelsDataDir: "/models" },
  } as unknown as HintConfig;
}

const onDisk = (ids: string[]) => (m: LocalModelDef) => ids.includes(m.id);

describe("buildSlowFirstTokenHint", () => {
  it("offers the largest curated model at most 60% the size, and says whether it is on disk", () => {
    const hint = buildSlowFirstTokenHint(config(), { models: MODELS, isDownloaded: onDisk(["small-9b"]) });
    expect(hint).toEqual({
      modelId: "big-27b",
      lighterModel: { id: "mid-12b", name: "mid-12b name", fileSizeGb: 9.0, downloaded: false },
      cloudAvailable: false,
    });
    const fromMid = buildSlowFirstTokenHint(config({ modelId: "mid-12b" }), { models: MODELS, isDownloaded: onDisk(["small-9b"]) });
    expect(fromMid?.lighterModel).toEqual({ id: "small-9b", name: "small-9b name", fileSizeGb: 5.3, downloaded: true });
  });

  it("has no lighter model for the smallest one, an unknown one or an external server", () => {
    const opts = { models: MODELS, isDownloaded: () => false };
    expect(buildSlowFirstTokenHint(config({ modelId: "tiny-4b" }), opts)?.lighterModel).toBeNull();
    expect(buildSlowFirstTokenHint(config({ modelId: "gone" }), opts)?.lighterModel).toBeNull();
    const external = buildSlowFirstTokenHint(config({ mode: "external" }), opts);
    expect(external).toMatchObject({ modelId: null, lighterModel: null });
  });

  it("counts a keyed cloud provider, not a local one", () => {
    const llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama",
      providers: [
        { id: "local-llama", kind: "llama-server" },
        { id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
      ],
    };
    const opts = { models: MODELS, isDownloaded: () => false };
    expect(buildSlowFirstTokenHint(config({ llm }), opts)?.cloudAvailable).toBe(false);
    const withCloud = {
      ...llm,
      providers: [...llm.providers, { id: "cloud", kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }],
    };
    expect(buildSlowFirstTokenHint(config({ llm: withCloud }), opts)?.cloudAvailable).toBe(true);
  });

  it("is null when the turn is not on a local model", () => {
    const llm = {
      activeTextProvider: "cloud",
      activeEmbeddingProvider: "local-llama",
      providers: [{ id: "cloud", kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" }],
    };
    expect(buildSlowFirstTokenHint(config({ llm }), { models: MODELS })).toBeNull();
  });
});

describe("runsOnLocalModel", () => {
  it("reads the active text provider", () => {
    expect(runsOnLocalModel({ llm: undefined } as never)).toBe(true);
    expect(runsOnLocalModel({ llm: { activeTextProvider: "local-llama", providers: [] } } as never)).toBe(true);
    expect(runsOnLocalModel({ llm: { activeTextProvider: "x", providers: [{ id: "x", kind: "llama-server" }] } } as never)).toBe(true);
    expect(runsOnLocalModel({ llm: { activeTextProvider: "x", providers: [{ id: "x", kind: "openrouter" }] } } as never)).toBe(false);
    expect(runsOnLocalModel({ llm: { activeTextProvider: "x", providers: [] } } as never)).toBe(false);
  });
});
