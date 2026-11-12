import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHISPER_MODEL,
  formatModelSize,
  resolveWhisperModel,
  WHISPER_MODEL_ENV,
  WHISPER_MODELS,
  whisperModelById,
  whisperModelUrl,
} from "./whisper-models.js";

const DATA = "/state/models";

describe("whisper model resolution (ATO-702)", () => {
  it("defaults to the multilingual base model, from the official repository", () => {
    expect(DEFAULT_WHISPER_MODEL).toBe("base");
    const r = resolveWhisperModel(DATA, undefined, { env: {}, fileExists: () => false });
    expect(r).toEqual({
      kind: "download",
      model: whisperModelById("base"),
      path: join(DATA, "whisper", "ggml-base.bin"),
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    });
  });

  it("is ready when the file is already in the models folder", () => {
    const path = join(DATA, "whisper", "ggml-small.bin");
    expect(resolveWhisperModel(DATA, "small", { env: {}, fileExists: (p) => p === path })).toEqual({ kind: "ready", path, label: "small" });
  });

  it("refuses an unknown model id and lists the known ones", () => {
    const r = resolveWhisperModel(DATA, "huge", { env: {}, fileExists: () => true });
    expect(r.kind).toBe("error");
    expect(r.kind === "error" ? r.reason : "").toContain("tiny, base, small");
  });

  it("uses the configured model file unless the call names a model", () => {
    const env = { [WHISPER_MODEL_ENV]: "/m/ggml-custom.bin" };
    expect(resolveWhisperModel(DATA, undefined, { env, fileExists: () => true })).toEqual({ kind: "ready", path: "/m/ggml-custom.bin", label: "/m/ggml-custom.bin" });
    expect(resolveWhisperModel(DATA, undefined, { env, fileExists: () => false }).kind).toBe("error");
    expect(resolveWhisperModel(DATA, "tiny", { env, fileExists: () => false }).kind).toBe("download");
  });

  it("has only multilingual models with a size for the approval", () => {
    for (const m of WHISPER_MODELS) {
      expect(m.file).not.toMatch(/\.en\.bin$/);
      expect(m.sizeMb).toBeGreaterThan(0);
      expect(whisperModelUrl(m)).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-/);
    }
    expect(formatModelSize(142)).toBe("142 MB");
    expect(formatModelSize(1620)).toBe("1.6 GB");
  });
});
