import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "./config-cache.js";
import { getUserConfigPath } from "./config-file.js";
import { addCustomModel } from "./custom-models-store.js";
import { getConfig } from "./index.js";
import { readModelSamplingSetting, writeModelSamplingSetting } from "./model-sampling-store.js";
import { listLocalModels, type LocalModelDef } from "../local-llm/catalog/models-catalog.js";

const CUSTOM = {
  id: "custom-fixture",
  name: "Fixture",
  filename: "w.gguf",
  huggingFaceUrl: "https://huggingface.co/a/b/resolve/main/w.gguf",
  fileSizeGb: 1,
  sizeLabel: "1 GB",
  description: "d",
  maxContextLength: 0,
  contextLabel: "auto",
  minRamGb: 1,
  recommendedRamGb: 2,
  family: "custom",
  supportsVision: false,
} as LocalModelDef;

describe("model sampling store (ATO-2482)", () => {
  let stateDir: string;
  const previous = process.env.ATOMIC_AGENT_STATE_DIR;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sampling-store-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = previous;
    resetConfigCache();
  });

  function file(): { localModels: Record<string, unknown> } {
    return JSON.parse(readFileSync(getUserConfigPath(stateDir), "utf8"));
  }

  it("writes a curated model's set to the override map and drops it on reset", () => {
    writeModelSamplingSetting("qwen-3.5-4b", { temperature: 0.6, noThinking: { temperature: 0.5 } });
    expect(file().localModels.modelSamplingOverrides).toEqual({
      "qwen-3.5-4b": { temperature: 0.6, noThinking: { temperature: 0.5 } },
    });
    expect(getConfig().localModels.modelSamplingOverrides?.["qwen-3.5-4b"]?.temperature).toBe(0.6);
    expect(readModelSamplingSetting("qwen-3.5-4b")).toMatchObject({ temperature: 0.6 });
    writeModelSamplingSetting("qwen-3.5-4b", null);
    expect(file().localModels).not.toHaveProperty("modelSamplingOverrides");
    expect(readModelSamplingSetting("qwen-3.5-4b")).toBeNull();
  });

  it("keeps an added model's set on its own entry and in the live catalog", () => {
    addCustomModel(CUSTOM);
    writeModelSamplingSetting("custom-fixture", { topK: 30 });
    const entry = (file().localModels.customModels as Array<Record<string, unknown>>)[0];
    expect(entry?.sampling).toEqual({ topK: 30 });
    expect(file().localModels).not.toHaveProperty("modelSamplingOverrides");
    expect(listLocalModels().find((m) => m.id === "custom-fixture")?.sampling).toEqual({ topK: 30 });
    writeModelSamplingSetting("custom-fixture", {});
    expect((file().localModels.customModels as Array<Record<string, unknown>>)[0]).not.toHaveProperty("sampling");
  });
});
