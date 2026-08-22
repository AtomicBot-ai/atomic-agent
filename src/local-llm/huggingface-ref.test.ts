import { describe, expect, it } from "vitest";

import { parseHuggingFaceModelRef } from "./huggingface-ref.js";

describe("parseHuggingFaceModelRef", () => {
  const accepted: {
    name: string;
    input: string;
    repoId: string;
    revision: string;
    filePath: string | null;
  }[] = [
    {
      name: "a bare owner/repo id",
      input: "unsloth/Qwen3.5-4B-GGUF",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: null,
    },
    {
      name: "the repo page URL",
      input: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: null,
    },
    {
      name: "a repo URL with a trailing query string",
      input: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF?library=llama-cpp",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: null,
    },
    {
      name: "a URL with no scheme",
      input: "huggingface.co/Qwen/Qwen3.5-4B-GGUF",
      repoId: "Qwen/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: null,
    },
    {
      name: "the hf.co short host",
      input: "hf.co/Qwen/Qwen3.5-4B-GGUF",
      repoId: "Qwen/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: null,
    },
    {
      name: "a /tree/ URL on a branch",
      input: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/refs-pr-2",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "refs-pr-2",
      filePath: null,
    },
    {
      name: "a /blob/ URL naming one .gguf",
      input:
        "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/blob/main/Qwen3.5-4B-UD-Q4_K_XL.gguf",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    },
    {
      name: "a /resolve/ URL naming one .gguf in a folder",
      input:
        "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Q4_K_M/model.gguf",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: "Q4_K_M/model.gguf",
    },
    {
      name: "an hf:// reference with a revision",
      input: "hf://Qwen/Qwen3.5-4B-GGUF@v1.0/model-Q4_K_M.gguf",
      repoId: "Qwen/Qwen3.5-4B-GGUF",
      revision: "v1.0",
      filePath: "model-Q4_K_M.gguf",
    },
    {
      name: "a pasted two-argument hf download command",
      input: "hf download unsloth/Qwen3.5-4B-GGUF Qwen3.5-4B-Q4_K_M.gguf --local-dir .",
      repoId: "unsloth/Qwen3.5-4B-GGUF",
      revision: "main",
      filePath: "Qwen3.5-4B-Q4_K_M.gguf",
    },
  ];

  for (const row of accepted) {
    it(`accepts ${row.name}`, () => {
      expect(parseHuggingFaceModelRef(row.input)).toEqual({
        repoId: row.repoId,
        revision: row.revision,
        filePath: row.filePath,
      });
    });
  }

  // Owners are case-sensitive on Hugging Face, and `new URL` lowercases a
  // hostname — so an `hf://` reference must never go through it.
  it("keeps the owner's case in an hf:// reference", () => {
    expect(parseHuggingFaceModelRef("hf://Qwen/Qwen3.5-4B-GGUF").repoId).toBe(
      "Qwen/Qwen3.5-4B-GGUF",
    );
  });

  const rejected: { name: string; input: string; message: RegExp }[] = [
    { name: "empty input", input: "   ", message: /repo id or a huggingface\.co URL/ },
    { name: "a plain search phrase", input: "qwen coder 30b", message: /Not a Hugging Face URL/ },
    // `new URL` reads a bare word as a hostname, so this lands on the
    // wrong-host branch rather than the unparseable one. Either way it
    // is refused, and the message still quotes what was typed.
    { name: "one bare word", input: "qwen", message: /Not a huggingface\.co URL: "qwen"/ },
    {
      name: "a URL on another host",
      input: "https://example.com/owner/repo",
      message: /Not a huggingface\.co URL/,
    },
    {
      name: "a huggingface.co URL naming no repo",
      input: "https://huggingface.co/unsloth",
      message: /names no repo/,
    },
    {
      name: "a /blob/ URL with no file after the revision",
      input: "https://huggingface.co/owner/repo/blob/main",
      message: /names no file/,
    },
    {
      name: "a dataset in hf:// form",
      input: "hf://datasets/owner/repo",
      message: /not a model repo/,
    },
  ];

  for (const row of rejected) {
    it(`rejects ${row.name}`, () => {
      expect(() => parseHuggingFaceModelRef(row.input)).toThrow(row.message);
    });
  }
});
