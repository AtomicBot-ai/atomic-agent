import { describe, expect, it } from "vitest";
import type { GgufMetadata } from "../catalog/gguf-metadata.js";
import {
  DRAFT_COMPUTE_RESERVE_BYTES,
  decideDraftLaunch,
  draftFlagsMissing,
  draftModelPreferenceProblem,
  draftRetryOptions,
  draftVocabProblem,
  resolveDraftCandidate,
  type DraftLaunchInput,
} from "./draft-model.js";

const GIB = 1024 ** 3;

function header(keys: GgufMetadata["keys"], tokens?: number): GgufMetadata {
  return {
    version: 3, tensorCount: 1, architecture: "gemma4", contextLength: null, blockCount: null, embeddingLength: null,
    headCount: null, headCountKv: null, keyLength: null, valueLength: null, keyLengthSwa: null, valueLengthSwa: null,
    slidingWindow: null, slidingWindowPattern: null, fullAttentionInterval: null, recurrentLayerPattern: null,
    hasRecurrentState: false, keys, ...(tokens === undefined ? {} : { arrayLengths: { "tokenizer.ggml.tokens": tokens } }),
    truncated: false,
  };
}

function launch(over: Partial<DraftLaunchInput> = {}): DraftLaunchInput {
  return {
    candidate: { id: "gemma-4-e4b", path: "/m/gemma-4-e4b/e4b.gguf", sizeBytes: 4 * GIB },
    explicit: false,
    engine: "llama-server",
    device: "Metal0",
    targetRecurrent: false,
    vocabProblem: null,
    contextSize: 65_536,
    kvBudgetBytes: 20 * GIB,
    mainKvBytes: 8 * GIB,
    draftKvBytes: 2 * GIB,
    pinnedDevice: "Metal0",
    ...over,
  };
}

describe("draftModelPreferenceProblem", () => {
  it("accepts off, auto, ids and absolute .gguf paths only", () => {
    expect(draftModelPreferenceProblem("off")).toBeNull();
    expect(draftModelPreferenceProblem("auto")).toBeNull();
    expect(draftModelPreferenceProblem("gemma-4-e4b")).toBeNull();
    expect(draftModelPreferenceProblem(process.platform === "win32" ? "D:\\d.gguf" : "/d.gguf")).toBeNull();
    expect(draftModelPreferenceProblem("")).not.toBeNull();
    expect(draftModelPreferenceProblem("rel/d.gguf")).not.toBeNull();
    expect(draftModelPreferenceProblem(process.platform === "win32" ? "D:\\d.bin" : "/d.bin")).toMatch(/\.gguf/);
  });
});

describe("resolveDraftCandidate", () => {
  const lookup = (id: string) =>
    id === "gemma-4-e4b"
      ? { known: true, path: "/m/e4b.gguf", sizeBytes: 4 * GIB }
      : id === "gemma-4-12b"
        ? { known: true, path: null, sizeBytes: 0 }
        : { known: false, path: null, sizeBytes: 0 };
  const deps = { lookup, statFile: (p: string) => (p === "/x/d.gguf" ? 123 : null) };
  const paired = { id: "gemma-4-31b", draftModelId: "gemma-4-e4b" };

  it("is nothing at all when off, so the launch is unchanged", () => {
    expect(resolveDraftCandidate("off", paired, deps)).toBeNull();
    expect(resolveDraftCandidate(undefined, paired, deps)).toBeNull();
  });
  it("auto takes the catalog pairing", () => {
    expect(resolveDraftCandidate("auto", paired, deps)).toEqual({
      candidate: { id: "gemma-4-e4b", path: "/m/e4b.gguf", sizeBytes: 4 * GIB },
    });
    expect(resolveDraftCandidate("auto", { id: "qwen-3.5-9b" }, deps)).toEqual({ skip: expect.stringMatching(/no draft model is paired/) });
  });
  it("says how to get a draft that is not downloaded", () => {
    expect(resolveDraftCandidate("gemma-4-12b", paired, deps)).toEqual({
      skip: "draft model gemma-4-12b is not downloaded; run 'atomic-agent models pull gemma-4-12b'",
    });
  });
  it("takes an operator's file and refuses a missing one or the model itself", () => {
    expect(resolveDraftCandidate("/x/d.gguf", paired, deps)).toEqual({ candidate: { id: null, path: "/x/d.gguf", sizeBytes: 123 } });
    expect(resolveDraftCandidate("/x/missing.gguf", paired, deps)).toEqual({ skip: expect.stringMatching(/not found/) });
    expect(resolveDraftCandidate("gemma-4-31b", paired, deps)).toEqual({ skip: expect.stringMatching(/itself/) });
    expect(resolveDraftCandidate("nope", paired, deps)).toEqual({ skip: "unknown draft model nope" });
  });
});

describe("draftVocabProblem", () => {
  it("flags a different tokenizer, start token or a vocabulary more than 128 apart", () => {
    const a = header({ "tokenizer.ggml.model": "gemma4", "tokenizer.ggml.bos_token_id": 2 }, 262_144);
    expect(draftVocabProblem(a, header({ "tokenizer.ggml.model": "gemma4", "tokenizer.ggml.bos_token_id": 2 }, 262_144))).toBeNull();
    expect(draftVocabProblem(a, header({ "tokenizer.ggml.model": "gpt2" }, 262_144))).toMatch(/tokenizer\.ggml\.model/);
    expect(draftVocabProblem(a, header({ "tokenizer.ggml.bos_token_id": 1 }, 262_144))).toMatch(/bos_token_id/);
    expect(draftVocabProblem(a, header({}, 262_144 + 128))).toBeNull();
    expect(draftVocabProblem(a, header({}, 151_936))).toMatch(/151936 tokens/);
  });
});

describe("decideDraftLaunch", () => {
  it("adds the draft on the GPU, sized to the fitted window, when it fits what the window left", () => {
    const d = decideDraftLaunch(launch());
    expect(d.args).toEqual([
      "--model-draft", "/m/gemma-4-e4b/e4b.gguf", "--gpu-layers-draft", "999",
      "--ctx-size-draft", "65536", "--device-draft", "Metal0",
    ]);
    expect(d.draft).toBe("gemma-4-e4b");
    expect(d.reason).toMatch(/^draft: on \(gemma-4-e4b, /);
  });

  it("never takes room from the context: a draft that does not fit the rest stays off", () => {
    // 4 GiB weights + 2 GiB cache + reserve > 20 - 15 GiB left.
    const d = decideDraftLaunch(launch({ mainKvBytes: 15 * GIB }));
    expect(d.args).toEqual([]);
    expect(d.reason).toMatch(/left after the context window/);
    // Exactly enough room is enough.
    const exact = decideDraftLaunch(launch({ kvBudgetBytes: 8 * GIB + 6 * GIB + DRAFT_COMPUTE_RESERVE_BYTES }));
    expect(exact.args).toContain("--model-draft");
  });

  it("stays off under Atomic Core, on the CPU and for a recurrent model, saying why", () => {
    expect(decideDraftLaunch(launch({ engine: "atomic-core" })).reason).toMatch(/Atomic Core/);
    expect(decideDraftLaunch(launch({ device: "cpu" })).reason).toMatch(/needs a GPU/);
    expect(decideDraftLaunch(launch({ targetRecurrent: true })).reason).toMatch(/recurrent state/);
    expect(decideDraftLaunch(launch({ vocabProblem: "x differs" })).reason).toMatch(/x differs/);
    for (const o of [{ engine: "atomic-core" as const }, { device: "cpu" }, { targetRecurrent: true }]) {
      expect(decideDraftLaunch(launch(o)).args).toEqual([]);
    }
  });

  it("with no free figure keeps a named draft (noted) and drops an auto one", () => {
    expect(decideDraftLaunch(launch({ kvBudgetBytes: null, explicit: true })).reason).toMatch(/memory not checked/);
    expect(decideDraftLaunch(launch({ kvBudgetBytes: null, explicit: true })).args).toContain("--model-draft");
    expect(decideDraftLaunch(launch({ kvBudgetBytes: null, explicit: false })).args).toEqual([]);
  });

  it("leaves the draft's device to llama.cpp when the launch pins none", () => {
    expect(decideDraftLaunch(launch({ pinnedDevice: null })).args).not.toContain("--device-draft");
  });
});

describe("draftFlagsMissing", () => {
  it("names the draft flags a build's --help does not list", () => {
    const help = "-md,   --model-draft FNAME\n-ngld, --gpu-layers-draft N\n-cd,   --ctx-size-draft N\n";
    expect(draftFlagsMissing(["--model-draft", "/m", "--gpu-layers-draft", "999", "--ctx-size-draft", "1"], help)).toEqual([]);
    expect(draftFlagsMissing(["--model-draft", "/m", "--device-draft", "Metal0"], help)).toEqual(["--device-draft"]);
    expect(draftFlagsMissing(["--model-draft", "/m"], "--model-draft-x")).toEqual(["--model-draft"]);
  });
});

describe("draftRetryOptions", () => {
  it("retries once without the draft, unless there was none or the caller cancelled", () => {
    expect(draftRetryOptions({ draftModel: "auto" }, ["--model-draft", "/m"], new Error("boom"))).toEqual({ draftModel: "off" });
    expect(draftRetryOptions({ draftModel: "auto" }, [], new Error("boom"))).toBeNull();
    const abort = Object.assign(new Error("stop"), { name: "AbortError" });
    expect(draftRetryOptions({ draftModel: "auto" }, ["--model-draft", "/m"], abort)).toBeNull();
  });
});
