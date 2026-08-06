import { describe, expect, it } from "vitest";
import {
  isMtpCompanionFile,
  isShardedGguf,
  buildCustomModelDef,
  buildCustomModelId,
  looksLikeHuggingFaceReference,
  parseHuggingFaceModelRef,
  pickDefaultGgufFile,
  pickMmprojFile,
  type HuggingFaceFile,
} from "./huggingface.js";

const GB = 1024 * 1024 * 1024;

describe("sharded and companion-file guards", () => {
  const gg = (path: string, sizeBytes = 1000) => ({ path, sizeBytes });

  it("pickDefaultGgufFile never selects a shard, first part included", () => {
    const picked = pickDefaultGgufFile([
      gg("model-00001-of-00003.gguf", 10),
      gg("model-00002-of-00003.gguf", 10),
      gg("model-q4_k_m.gguf", 5000),
    ]);
    expect(picked?.path).toBe("model-q4_k_m.gguf");
  });

  it("pickDefaultGgufFile skips MTP companion files in the smallest-file fallback", () => {
    const picked = pickDefaultGgufFile([
      gg("model-mtp-draft.gguf", 10),
      gg("MTP/companion.gguf", 12),
      gg("model-iq2_xxs.gguf", 5000),
    ]);
    expect(picked?.path).toBe("model-iq2_xxs.gguf");
  });

  it("isShardedGguf matches every part of a multi-part model", () => {
    expect(isShardedGguf("m-00001-of-00003.gguf")).toBe(true);
    expect(isShardedGguf("m-00003-of-00003.gguf")).toBe(true);
    expect(isShardedGguf("m-q4_k_m.gguf")).toBe(false);
  });

  it("isMtpCompanionFile matches delimited mtp tokens only", () => {
    expect(isMtpCompanionFile("model-mtp.gguf")).toBe(true);
    expect(isMtpCompanionFile("mtp-draft.gguf")).toBe(true);
    expect(isMtpCompanionFile("MTP/x.gguf")).toBe(true);
    expect(isMtpCompanionFile("empty-model.gguf")).toBe(false);
    expect(isMtpCompanionFile("prompt-tuned.gguf")).toBe(false);
  });
});

describe("parseHuggingFaceModelRef", () => {
  it("parses a /resolve/ file URL", () => {
    expect(
      parseHuggingFaceModelRef(
        "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
      ),
    ).toEqual({
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: "Qwen3.5-4B-Q4_K_M.gguf",
    });
  });

  it("parses a /blob/ URL on a non-default revision", () => {
    expect(
      parseHuggingFaceModelRef(
        "https://huggingface.co/org/repo/blob/v2/sub/dir/model.gguf?download=true",
      ),
    ).toEqual({ repoId: "org/repo", revision: "v2", filePath: "sub/dir/model.gguf" });
  });

  it("parses a bare repo page, a tree URL, hf.co and a bare id", () => {
    const expected = { repoId: "org/repo", revision: "main", filePath: null };
    expect(parseHuggingFaceModelRef("https://huggingface.co/org/repo")).toEqual(expected);
    expect(parseHuggingFaceModelRef("https://huggingface.co/org/repo/tree/main")).toEqual(
      expected,
    );
    expect(parseHuggingFaceModelRef("hf.co/org/repo")).toEqual(expected);
    expect(parseHuggingFaceModelRef(" org/repo ")).toEqual(expected);
  });

  it("parses the hf:// scheme, preserving owner case", () => {
    expect(
      parseHuggingFaceModelRef(
        "hf://owao/Nanbeige4.2-3B-GGUF/nanbeige4.2-3b-IQ3_M.gguf",
      ),
    ).toEqual({
      repoId: "owao/Nanbeige4.2-3B-GGUF",
      revision: "main",
      filePath: "nanbeige4.2-3b-IQ3_M.gguf",
    });
    // `new URL()` would lowercase this owner into `qwen`.
    expect(parseHuggingFaceModelRef("hf://Qwen/Qwen3-4B-GGUF").repoId).toBe(
      "Qwen/Qwen3-4B-GGUF",
    );
  });

  it("parses hf:// with a revision and a nested file path", () => {
    expect(parseHuggingFaceModelRef("hf://org/repo@v2/sub/m.gguf")).toEqual({
      repoId: "org/repo",
      revision: "v2",
      filePath: "sub/m.gguf",
    });
    expect(parseHuggingFaceModelRef("hf://models/org/repo")).toEqual({
      repoId: "org/repo",
      revision: "main",
      filePath: null,
    });
  });

  it("accepts a whole pasted `hf download` command", () => {
    const expected = {
      repoId: "owao/Nanbeige4.2-3B-GGUF",
      revision: "main",
      filePath: "nanbeige4.2-3b-IQ3_M.gguf",
    };
    expect(
      parseHuggingFaceModelRef(
        "hf download hf://owao/Nanbeige4.2-3B-GGUF/nanbeige4.2-3b-IQ3_M.gguf",
      ),
    ).toEqual(expected);
    // Two-argument form, and with trailing CLI flags.
    expect(
      parseHuggingFaceModelRef(
        "hf download owao/Nanbeige4.2-3B-GGUF nanbeige4.2-3b-IQ3_M.gguf",
      ),
    ).toEqual(expected);
    expect(
      parseHuggingFaceModelRef(
        "huggingface-cli download owao/Nanbeige4.2-3B-GGUF nanbeige4.2-3b-IQ3_M.gguf --local-dir ./m",
      ),
    ).toEqual(expected);
  });

  it("rejects non-HF URLs, datasets, and incomplete references", () => {
    expect(() => parseHuggingFaceModelRef("https://example.com/org/repo")).toThrow();
    expect(() => parseHuggingFaceModelRef("https://huggingface.co/org")).toThrow();
    expect(() => parseHuggingFaceModelRef("hf://datasets/org/repo")).toThrow(
      /dataset/,
    );
    expect(() => parseHuggingFaceModelRef("hf://org")).toThrow();
    expect(() => parseHuggingFaceModelRef("")).toThrow();
    expect(() => parseHuggingFaceModelRef("hf download")).toThrow();
  });

  it("still rejects free text so the caller can fall back to search", () => {
    // The add-prompt distinguishes reference from query by this throw.
    expect(() => parseHuggingFaceModelRef("qwen3 coder")).toThrow();
    expect(() => parseHuggingFaceModelRef("small vision model")).toThrow();
  });
});

describe("file selection", () => {
  const files: HuggingFaceFile[] = [
    { path: "Model-Q8_0.gguf", sizeBytes: 8 * GB },
    { path: "Model-Q4_K_M.gguf", sizeBytes: 4 * GB },
    { path: "mmproj-F16.gguf", sizeBytes: GB },
    { path: "Model-Q2_K-00002-of-00002.gguf", sizeBytes: GB },
  ];

  it("prefers the 4-bit quant over smaller shards and projectors", () => {
    expect(pickDefaultGgufFile(files)?.path).toBe("Model-Q4_K_M.gguf");
  });

  it("falls back to the smallest non-projector, non-tail-shard file", () => {
    const noQuantHints: HuggingFaceFile[] = [
      { path: "big.gguf", sizeBytes: 9 * GB },
      { path: "small.gguf", sizeBytes: 2 * GB },
      { path: "mmproj.gguf", sizeBytes: GB },
    ];
    expect(pickDefaultGgufFile(noQuantHints)?.path).toBe("small.gguf");
  });

  it("returns null when every candidate is a projector", () => {
    expect(pickDefaultGgufFile([{ path: "mmproj-F16.gguf", sizeBytes: GB }])).toBeNull();
  });

  it("finds the projector", () => {
    expect(pickMmprojFile(files)?.path).toBe("mmproj-F16.gguf");
    expect(pickMmprojFile([{ path: "a.gguf", sizeBytes: GB }])).toBeNull();
  });
});

describe("buildCustomModelId", () => {
  it("produces a filesystem-safe, custom-prefixed id", () => {
    const id = buildCustomModelId("unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf");
    expect(id).toBe("custom-unsloth-qwen3.5-4b-gguf-qwen3.5-4b-q4_k_m");
    expect(id).toMatch(/^custom-[a-z0-9._-]+$/);
  });
});

describe("buildCustomModelDef", () => {
  it("wires the download URL, vision fields and RAM estimates", () => {
    const def = buildCustomModelDef({
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      file: { path: "Qwen3.5-4B-Q4_K_M.gguf", sizeBytes: 4 * GB },
      mmproj: { path: "mmproj-F16.gguf", sizeBytes: GB },
    });
    expect(def.huggingFaceUrl).toBe(
      "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    );
    expect(def.filename).toBe("Qwen3.5-4B-Q4_K_M.gguf");
    expect(def.family).toBe("custom");
    expect(def.supportsVision).toBe(true);
    expect(def.mmprojFilename).toBe("mmproj-F16.gguf");
    // Context is left to the auto-fit path rather than guessed.
    expect(def.maxContextLength).toBe(0);
    expect(def.minRamGb).toBe(5);
    expect(def.recommendedRamGb).toBe(8);
  });

  it("omits mmproj fields when the repo has no projector", () => {
    const def = buildCustomModelDef({
      repoId: "org/repo",
      revision: "main",
      file: { path: "m.gguf", sizeBytes: GB / 2 },
      mmproj: null,
    });
    expect(def.supportsVision).toBe(false);
    expect(def.mmprojUrl).toBeUndefined();
    expect(def.sizeLabel).toBe("512 MB");
  });
});

describe("looksLikeHuggingFaceReference", () => {
  it("claims only unambiguous Hugging Face references", () => {
    for (const yes of [
      "hf://owao/Nanbeige4.2-3B-GGUF/x.gguf",
      "hf download hf://org/repo/x.gguf",
      "huggingface-cli download org/repo x.gguf",
      "https://huggingface.co/org/repo",
      "hf.co/org/repo",
    ]) {
      expect(looksLikeHuggingFaceReference(yes)).toBe(true);
    }
  });

  it("leaves llama-server addresses alone", () => {
    // These must stay routable as base URLs — claiming them would
    // silently misconfigure the runtime instead of adding a model.
    for (const no of [
      "http://127.0.0.1:8080",
      "192.168.1.5/api",
      "localhost:8080/v1",
      "owner/name",
      "qwen3 coder",
      "http://myhf.co.internal:8080",
    ]) {
      expect(looksLikeHuggingFaceReference(no)).toBe(false);
    }
  });
});
