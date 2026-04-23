import { describe, expect, it } from "vitest";

import {
  detectModelProfile,
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import {
  GEMMA4_PROPS,
  GPT_OSS_PROPS,
  LLAMA3_PROPS,
  QWEN3_PROPS,
} from "./model-profile.fixtures.js";

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
});
