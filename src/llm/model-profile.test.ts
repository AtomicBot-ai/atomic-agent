import { describe, expect, it } from "vitest";

import {
  detectModelProfile,
  extractTotalSlots,
  detectVisionSupport,
  GEMMA4_THINK_PROFILE,
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

  // Nemotron has no profile of its own: its ChatML template is qwen-shaped,
  // so the dedicated detector deliberately maps onto QWEN_THINK_PROFILE. The
  // contract under test is that the Nemotron template yields the think-tags
  // reasoning profile at all — deleting the branch drops it to plain-instruct
  // and silently kills the reasoning channel.
  it("maps the nemotron ChatML + enable_thinking template onto the think-tags profile", () => {
    const profile = detectModelProfile(NEMOTRON_PROPS);
    expect(profile).toEqual(QWEN_THINK_PROFILE);
    expect(profile.reasoningStyle).toBe("think-tags");
  });

  // Pins the alias gate: the Nemotron detector must require a `nemotron`
  // alias, not fire on the template markers alone. An alias carrying none of
  // the qwen/qwq/deepseek-r1/nemotron hints must fall through to plain even
  // though the template is a full ChatML + <think> + enable_thinking match.
  it("requires a nemotron alias — template markers alone do not classify", () => {
    expect(
      detectModelProfile({
        ...NEMOTRON_PROPS,
        model_alias: "some-other-chatml-think-model",
      }),
    ).toEqual(PLAIN_INSTRUCT_PROFILE);
  });

  // Pins branch ordering. This alias satisfies BOTH gates (it contains
  // "qwen" and "nemotron"), which is the only input where the order of the
  // two branches is observable: whichever runs first decides. The qwen
  // branch runs first, so the qwen gate must win. Both branches currently
  // yield QWEN_THINK_PROFILE, so this is pinned on the gate that fired
  // rather than on the returned object.
  it("lets the qwen gate win when an alias matches both the qwen and nemotron hints", () => {
    const alias = "qwen-nemotron-hybrid-think";
    // Guard: the alias really does trip both gates, so the assertion below
    // is about ordering and not about one gate quietly failing to match.
    expect(alias).toContain("qwen");
    expect(alias).toContain("nemotron");
    expect(detectModelProfile({ ...NEMOTRON_PROPS, model_alias: alias })).toEqual(
      QWEN_THINK_PROFILE,
    );
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
