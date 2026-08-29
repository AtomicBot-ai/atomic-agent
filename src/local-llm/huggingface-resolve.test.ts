import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCustomModelDef } from "./huggingface-model-def.js";
import { resolveHuggingFaceGgufChoices } from "./huggingface-resolve.js";

const GB = 1024 * 1024 * 1024;

interface TreeEntry {
  path: string;
  lfs?: { size: number };
  size?: number;
}

/** Stand in for the `/api/models/<repo>/tree/<rev>` response. */
function stubTree(entries: TreeEntry[], status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(entries), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function stubStatus(status: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveHuggingFaceGgufChoices", () => {
  it("offers every servable quant, best-known first", async () => {
    stubTree([
      { path: "Qwen3.5-4B-Q8_0.gguf", lfs: { size: 4 * GB } },
      { path: "Qwen3.5-4B-UD-Q4_K_XL.gguf", lfs: { size: 2.7 * GB } },
      { path: "Qwen3.5-4B-Q5_K_M.gguf", lfs: { size: 3 * GB } },
    ]);
    const resolved = await resolveHuggingFaceGgufChoices("unsloth/Qwen3.5-4B-GGUF");
    expect(resolved.repoId).toBe("unsloth/Qwen3.5-4B-GGUF");
    expect(resolved.choices.map((c) => c.filename)).toEqual([
      "Qwen3.5-4B-UD-Q4_K_XL.gguf",
      "Qwen3.5-4B-Q5_K_M.gguf",
      "Qwen3.5-4B-Q8_0.gguf",
    ]);
    expect(resolved.choices[0]!.sizeLabel).toBe("2.7 GB");
    expect(resolved.hidden).toBeNull();
  });

  it("hides what it cannot serve and says how much it hid", async () => {
    stubTree([
      { path: "model-Q4_K_M.gguf", lfs: { size: 2 * GB } },
      { path: "model-F16.gguf", lfs: { size: 8 * GB } },
      { path: "model-Q4_K_M-00001-of-00002.gguf", lfs: { size: 1 * GB } },
      { path: "mmproj-BF16.gguf", lfs: { size: 0.5 * GB } },
    ]);
    const resolved = await resolveHuggingFaceGgufChoices("owner/repo");
    expect(resolved.choices.map((c) => c.filename)).toEqual(["model-Q4_K_M.gguf"]);
    expect(resolved.hidden).toBe(
      "3 more files hidden: 1 full-precision, 1 multi-part, 1 vision projector",
    );
    expect(resolved.mmproj?.path).toBe("mmproj-BF16.gguf");
  });

  it("collapses to the one file a direct link named", async () => {
    stubTree([
      { path: "model-Q4_K_M.gguf", lfs: { size: 2 * GB } },
      { path: "model-Q8_0.gguf", lfs: { size: 4 * GB } },
    ]);
    const resolved = await resolveHuggingFaceGgufChoices(
      "https://huggingface.co/owner/repo/blob/main/model-Q8_0.gguf",
    );
    expect(resolved.choices.map((c) => c.filename)).toEqual(["model-Q8_0.gguf"]);
  });

  it("refuses a direct link to a shard, quoting why", async () => {
    stubTree([{ path: "model-00001-of-00003.gguf", lfs: { size: 4 * GB } }]);
    await expect(
      resolveHuggingFaceGgufChoices(
        "https://huggingface.co/owner/repo/blob/main/model-00001-of-00003.gguf",
      ),
    ).rejects.toThrow(/one part of a multi-part model/);
  });

  it("refuses a repo that holds no GGUF at all", async () => {
    stubTree([{ path: "model.safetensors", size: 4 * GB }]);
    await expect(resolveHuggingFaceGgufChoices("owner/repo")).rejects.toThrow(
      /No \.gguf files in owner\/repo/,
    );
  });

  it("refuses a repo whose only GGUFs are unservable", async () => {
    stubTree([
      { path: "model-F16.gguf", lfs: { size: 8 * GB } },
      { path: "mmproj-F16.gguf", lfs: { size: 0.5 * GB } },
    ]);
    await expect(resolveHuggingFaceGgufChoices("owner/repo")).rejects.toThrow(
      /none this agent can serve \(2 more files hidden/,
    );
  });

  it("names the gating when Hugging Face refuses the listing", async () => {
    stubStatus(401);
    await expect(resolveHuggingFaceGgufChoices("owner/gated")).rejects.toThrow(
      /gated/,
    );
  });

  it("says the repo does not exist on a 404", async () => {
    stubStatus(404);
    await expect(resolveHuggingFaceGgufChoices("owner/nope")).rejects.toThrow(
      /no repo or revision by that name/,
    );
  });

  it("reports an unreachable host rather than throwing a raw fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(resolveHuggingFaceGgufChoices("owner/repo")).rejects.toThrow(
      /Could not reach huggingface\.co/,
    );
  });

  // The LFS pointer, not the model, is what `size` reports for anything
  // over 10 MB — reading it would put every large model at a few hundred
  // bytes and silence the RAM warning.
  it("prefers the LFS size over the tree entry's own", async () => {
    stubTree([{ path: "model-Q4_K_M.gguf", size: 135, lfs: { size: 6 * GB } }]);
    const resolved = await resolveHuggingFaceGgufChoices("owner/repo");
    expect(resolved.choices[0]!.fileSizeGb).toBeCloseTo(6, 3);
  });
});

describe("buildCustomModelDef", () => {
  it("mints a filesystem-safe id and an advisory RAM envelope", async () => {
    stubTree([{ path: "Qwen3.5-4B-UD-Q4_K_XL.gguf", lfs: { size: 2.7 * GB } }]);
    const resolved = await resolveHuggingFaceGgufChoices("unsloth/Qwen3.5-4B-GGUF");
    const choice = resolved.choices[0]!;
    const def = buildCustomModelDef({
      repoId: resolved.repoId,
      revision: resolved.revision,
      file: { path: choice.path, sizeBytes: choice.sizeBytes },
      mmproj: null,
    });
    expect(def.id).toBe("custom-unsloth-qwen3.5-4b-gguf-qwen3.5-4b-ud-q4_k_xl");
    expect(def.family).toBe("custom");
    expect(def.supportsVision).toBe(false);
    expect(def.huggingFaceUrl).toBe(
      "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q4_K_XL.gguf",
    );
    expect(def.minRamGb).toBe(4);
    expect(def.recommendedRamGb).toBe(7);
    // Zero hands the decision to `resolveEffectiveContextSize`, which
    // fits the window to the device instead of guessing here.
    expect(def.maxContextLength).toBe(0);
  });

  it("carries the projector through when the repo ships one", async () => {
    stubTree([
      { path: "model-Q4_K_M.gguf", lfs: { size: 2 * GB } },
      { path: "mmproj-BF16.gguf", lfs: { size: 0.5 * GB } },
    ]);
    const resolved = await resolveHuggingFaceGgufChoices("owner/repo");
    const choice = resolved.choices[0]!;
    const def = buildCustomModelDef({
      repoId: resolved.repoId,
      revision: resolved.revision,
      file: { path: choice.path, sizeBytes: choice.sizeBytes },
      mmproj: resolved.mmproj,
    });
    expect(def.supportsVision).toBe(true);
    expect(def.mmprojFilename).toBe("mmproj-BF16.gguf");
  });
});
