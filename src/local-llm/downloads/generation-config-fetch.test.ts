import { describe, expect, it } from "vitest";

import { getLocalModelDef, type LocalModelDef } from "../catalog/models-catalog.js";
import { fetchGenerationConfigBeside, type GenerationConfigDeps } from "./generation-config-fetch.js";

const QWEN = getLocalModelDef("qwen-3.5-4b"); // unsloth/Qwen3.5-4B-GGUF
const WEIGHTS = "/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf";
const GEN = JSON.stringify({ do_sample: true, temperature: 0.6, top_p: 0.95, top_k: 20 });

function deps(over: Partial<GenerationConfigDeps> & { configs?: Record<string, string> }) {
  const asked: string[] = [];
  const written: Array<[string, string]> = [];
  const d: GenerationConfigDeps = {
    exists: () => false,
    readHeaderKeys: async () => ({ "general.architecture": "qwen35" }),
    baseModels: async (id) =>
      id === "unsloth/Qwen3.5-4B-GGUF" ? ["unsloth/Qwen3.5-4B"] : id === "unsloth/Qwen3.5-4B" ? ["Qwen/Qwen3.5-4B"] : [],
    fetchConfig: async (id) => {
      asked.push(id);
      return over.configs?.[id] ?? null;
    },
    writeText: async (path, text) => {
      written.push([path, text]);
    },
    ...over,
  };
  return { d, asked, written };
}

describe("fetchGenerationConfigBeside (ATO-2482)", () => {
  it("walks the repo, then its base models, and saves the first config with sampling", async () => {
    const { d, asked, written } = deps({ configs: { "Qwen/Qwen3.5-4B": GEN } });
    expect(await fetchGenerationConfigBeside(QWEN, WEIGHTS, d)).toBe("saved");
    expect(asked).toEqual(["unsloth/Qwen3.5-4B-GGUF", "unsloth/Qwen3.5-4B", "Qwen/Qwen3.5-4B"]);
    expect(written).toEqual([["/data/models/qwen-3.5-4b/generation_config.json", GEN]]);
  });

  it("asks nothing when the header already names sampling", async () => {
    const { d, asked } = deps({ readHeaderKeys: async () => ({ "general.sampling.temp": 1 }) });
    expect(await fetchGenerationConfigBeside(QWEN, WEIGHTS, d)).toBe("header");
    expect(asked).toEqual([]);
  });

  it("skips greedy or empty configs, and reports none when nothing fits", async () => {
    const { d, written } = deps({
      configs: { "unsloth/Qwen3.5-4B-GGUF": JSON.stringify({ do_sample: false, temperature: 0.1 }), "unsloth/Qwen3.5-4B": "{}" },
    });
    expect(await fetchGenerationConfigBeside(QWEN, WEIGHTS, d)).toBe("none");
    expect(written).toEqual([]);
  });

  it("never writes beside a model added from disk, or over a file already there", async () => {
    const disk = { ...QWEN, id: "custom-disk", family: "custom", localPath: "/Users/me/w.gguf" } as LocalModelDef;
    const { d, asked } = deps({ configs: { "unsloth/Qwen3.5-4B-GGUF": GEN } });
    expect(await fetchGenerationConfigBeside(disk, "/Users/me/w.gguf", d)).toBe("skipped");
    expect(await fetchGenerationConfigBeside(QWEN, WEIGHTS, { ...d, exists: () => true })).toBe("present");
    expect(asked).toEqual([]);
  });
});
