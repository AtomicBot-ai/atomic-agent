import { describe, expect, it } from "vitest";

import { buildGrammar } from "./grammar/build-grammar.js";
import type { LlamaServerClient } from "./llama-server-client.js";
import { ModelProfileManager } from "./model-profile-manager.js";
import { GEMMA4_PROPS, QWEN3_PROPS } from "./model-profile.fixtures.js";
import { PLAIN_INSTRUCT_PROFILE } from "./model-profile.js";
import type { ModelSamplingDefaults } from "../local-llm/catalog/gguf-sampling.js";

async function managerWith(
  propsQueue: Record<string, unknown>[],
  readings: Record<string, ModelSamplingDefaults | null>,
) {
  const queue = [...propsQueue];
  const llama = {
    async fetchProps() {
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  } as unknown as LlamaServerClient;
  const asked: string[] = [];
  const mgr = new ModelProfileManager({
    llama,
    initialProfile: PLAIN_INSTRUCT_PROFILE,
    initialGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
    initialModelId: null,
    readPrefixReuse: async () => null,
    readSampling: async (path) => {
      asked.push(path);
      return readings[path] ?? null;
    },
  });
  return { mgr, asked };
}

describe("ModelProfileManager model sampling (ATO-2202)", () => {
  it("stamps the sampling read from /props.model_path on the profile", async () => {
    const { mgr, asked } = await managerWith(
      [{ ...QWEN3_PROPS, model_path: "/models/qwen.gguf" }],
      { "/models/qwen.gguf": { temperature: 0.6, topK: 20 } },
    );
    await mgr.refresh();
    expect(asked).toEqual(["/models/qwen.gguf"]);
    expect(mgr.getProfile().sampling).toEqual({ temperature: 0.6, topK: 20 });
  });

  it("leaves sampling off without a model path or a reading", async () => {
    const { mgr, asked } = await managerWith([QWEN3_PROPS], {});
    await mgr.refresh();
    expect(asked).toEqual([]);
    expect(mgr.getProfile().sampling).toBeUndefined();
    const { mgr: silent } = await managerWith(
      [{ ...QWEN3_PROPS, model_path: "/models/plain.gguf" }],
      {},
    );
    await silent.refresh();
    expect(silent.getProfile().sampling).toBeUndefined();
  });

  it("follows a model swapped behind the same profile id", async () => {
    const { mgr } = await managerWith(
      [
        { ...GEMMA4_PROPS, model_path: "/models/a.gguf" },
        { ...GEMMA4_PROPS, model_path: "/models/b.gguf" },
      ],
      {
        "/models/a.gguf": { temperature: 1, topK: 64 },
        "/models/b.gguf": { temperature: 0.7 },
      },
    );
    await mgr.refresh();
    expect(mgr.getProfile().sampling).toEqual({ temperature: 1, topK: 64 });
    await mgr.refresh();
    expect(mgr.getProfile().sampling).toEqual({ temperature: 0.7 });
  });
});
