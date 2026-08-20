import { describe, expect, it } from "vitest";

import {
  detectModelProfile,
  extractTotalSlots,
  detectVisionSupport,
  GEMMA4_THINK_PROFILE,
  NEMOTRON_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import {
  GEMMA4_PROPS,
  GPT_OSS_PROPS,
  LLAMA3_PROPS,
  NEMOTRON_PROPS,
  QWEN3_PROPS,
} from "./model-profile.fixtures.js";

describe("extractTotalSlots", () => {
  it("reads a positive integer slot count", () => {
    expect(extractTotalSlots({ total_slots: 2 })).toBe(2);
  });

  // Falling back to `null` (and thus the conservative SlotManager default)
  // is deliberate: llama.cpp wraps an out-of-range id into another
  // session's slot rather than erroring, so guessing high corrupts cache
  // affinity silently.
  it("collapses missing, non-numeric, and sub-1 values to null", () => {
    for (const raw of [undefined, null, "2", 0, -1, Number.NaN, Infinity]) {
      expect(extractTotalSlots({ total_slots: raw })).toBeNull();
    }
    expect(extractTotalSlots({})).toBeNull();
  });

  it("truncates a fractional count", () => {
    expect(extractTotalSlots({ total_slots: 2.9 })).toBe(2);
  });
});

describe("detectModelProfile", () => {
  it("detects qwen think profile from props", () => {
    expect(detectModelProfile(QWEN3_PROPS)).toEqual(QWEN_THINK_PROFILE);
  });

  it("falls back to plain profile for llama style instruct templates", () => {
    expect(detectModelProfile(LLAMA3_PROPS)).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  it("detects gemma 4 think profile from channel tags", () => {
    expect(detectModelProfile(GEMMA4_PROPS)).toEqual(GEMMA4_THINK_PROFILE);
  });

  it("detects nemotron think profile from ChatML + enable_thinking", () => {
    expect(detectModelProfile(NEMOTRON_PROPS)).toEqual(NEMOTRON_THINK_PROFILE);
  });

  it("does not classify a non-nemotron ChatML think template as nemotron", () => {
    // Same markers as Nemotron (ChatML + <think> + enable_thinking) but the
    // alias is not nemotron — must stay on the qwen path (or plain if the
    // qwen alias hint also fails). Here the alias carries none of the
    // qwen/nemotron hints, so the result is plain-instruct.
    expect(
      detectModelProfile({
        ...NEMOTRON_PROPS,
        model_alias: "some-other-chatml-think-model",
      }),
    ).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  it("falls back to plain profile for gpt-oss style templates", () => {
    expect(detectModelProfile(GPT_OSS_PROPS)).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  it("reads context window from default_generation_settings.n_ctx", () => {
    const profile = detectModelProfile({
      ...QWEN3_PROPS,
      default_generation_settings: { n_ctx: 32768 },
    });
    expect(profile.id).toBe("qwen-think");
    expect(profile.contextWindow).toBe(32768);
  });

  it("falls back to root-level n_ctx when nested setting is absent", () => {
    const profile = detectModelProfile({
      ...LLAMA3_PROPS,
      n_ctx: 4096,
    });
    expect(profile.id).toBe("plain-instruct");
    expect(profile.contextWindow).toBe(4096);
  });

  it("leaves context window undefined when neither field is present", () => {
    const profile = detectModelProfile(LLAMA3_PROPS);
    expect(profile.contextWindow).toBeUndefined();
  });

  it("ignores non-positive n_ctx values", () => {
    const profile = detectModelProfile({
      ...LLAMA3_PROPS,
      default_generation_settings: { n_ctx: 0 },
      n_ctx: -10,
    });
    expect(profile.contextWindow).toBeUndefined();
  });

  it("defaults vision to absent for text-only props payloads", () => {
    expect(detectModelProfile(QWEN3_PROPS).vision).toEqual({
      supported: false,
      source: "absent",
    });
  });

  it("detects vision via modalities.vision flag (current llama.cpp surface)", () => {
    const profile = detectModelProfile({
      ...GEMMA4_PROPS,
      modalities: { vision: true, audio: false },
    });
    expect(profile.vision).toEqual({
      supported: true,
      source: "modalities.vision",
    });
  });

  it("ignores modalities.audio when vision is false", () => {
    expect(
      detectVisionSupport({ modalities: { vision: false, audio: true } }),
    ).toEqual({
      supported: false,
      source: "absent",
    });
  });

  it("prefers modalities.vision over legacy has_multimodal", () => {
    expect(
      detectVisionSupport({
        modalities: { vision: true },
        has_multimodal: true,
      }),
    ).toEqual({
      supported: true,
      source: "modalities.vision",
    });
  });

  it("detects vision via top-level has_multimodal flag", () => {
    const profile = detectModelProfile({
      ...GEMMA4_PROPS,
      has_multimodal: true,
    });
    expect(profile.vision).toEqual({
      supported: true,
      source: "has_multimodal",
    });
  });

  it("detects vision via legacy `multimodal: true` flag", () => {
    expect(detectVisionSupport({ multimodal: true })).toEqual({
      supported: true,
      source: "multimodal",
    });
  });

  it("detects vision when `mmproj` is a non-null object", () => {
    expect(
      detectVisionSupport({ mmproj: { path: "/tmp/mmproj-F16.gguf" } }),
    ).toEqual({
      supported: true,
      source: "mmproj",
    });
  });

  it("detects vision via default_generation_settings.has_multimodal", () => {
    expect(
      detectVisionSupport({
        default_generation_settings: { has_multimodal: true },
      }),
    ).toEqual({
      supported: true,
      source: "default_generation_settings.has_multimodal",
    });
  });

  it("returns absent for non-object mmproj values", () => {
    expect(detectVisionSupport({ mmproj: null })).toEqual({
      supported: false,
      source: "absent",
    });
    expect(detectVisionSupport({ mmproj: "ignored-string" })).toEqual({
      supported: false,
      source: "absent",
    });
  });
});
