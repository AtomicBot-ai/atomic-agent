import { describe, expect, it } from "vitest";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import {
  NO_SERVER_TEMPLATE,
  resolveServerTemplatePolicy,
  thinkingDisabledOnBuiltPrompt,
} from "./server-template-policy.js";

describe("resolveServerTemplatePolicy", () => {
  it("auto: on for families without a hand-built profile, off for gemma and qwen", () => {
    const auto = { useServerTemplate: "auto", thinking: "auto" } as const;
    expect(resolveServerTemplatePolicy(auto, PLAIN_INSTRUCT_PROFILE)).toEqual({
      useServerTemplate: true,
      enableThinking: undefined,
    });
    expect(resolveServerTemplatePolicy(auto, QWEN_THINK_PROFILE)).toBe(
      NO_SERVER_TEMPLATE,
    );
    expect(resolveServerTemplatePolicy(auto, GEMMA4_THINK_PROFILE)).toBe(
      NO_SERVER_TEMPLATE,
    );
  });

  it("on / off override the family rule", () => {
    expect(
      resolveServerTemplatePolicy(
        { useServerTemplate: "on", thinking: "auto" },
        QWEN_THINK_PROFILE,
      ).useServerTemplate,
    ).toBe(true);
    expect(
      resolveServerTemplatePolicy(
        { useServerTemplate: "off", thinking: "off" },
        PLAIN_INSTRUCT_PROFILE,
      ),
    ).toBe(NO_SERVER_TEMPLATE);
  });

  it("sets the thinking switch only where the template reads it", () => {
    const off = { useServerTemplate: "on", thinking: "off" } as const;
    expect(resolveServerTemplatePolicy(off, QWEN_THINK_PROFILE)).toEqual({
      useServerTemplate: true,
      enableThinking: false,
    });
    expect(
      resolveServerTemplatePolicy(
        { useServerTemplate: "on", thinking: "on" },
        QWEN_THINK_PROFILE,
      ).enableThinking,
    ).toBe(true);
    // A plain template that never mentions enable_thinking: nothing to set.
    expect(
      resolveServerTemplatePolicy(off, PLAIN_INSTRUCT_PROFILE).enableThinking,
    ).toBeUndefined();
    expect(
      resolveServerTemplatePolicy(off, {
        ...PLAIN_INSTRUCT_PROFILE,
        supportsThinkingSwitch: true,
      }).enableThinking,
    ).toBe(false);
  });
});

describe("thinkingDisabledOnBuiltPrompt (F49)", () => {
  it("is true only for off on a profile with a prompt-side disabled marker — qwen-think", () => {
    expect(thinkingDisabledOnBuiltPrompt("off", QWEN_THINK_PROFILE)).toBe(true);
    expect(QWEN_THINK_PROFILE.promptThinkingDisabledMarker).toBe(
      "<think>\n\n</think>\n\n",
    );
  });

  it("leaves on / auto alone", () => {
    expect(thinkingDisabledOnBuiltPrompt("on", QWEN_THINK_PROFILE)).toBe(false);
    expect(thinkingDisabledOnBuiltPrompt("auto", QWEN_THINK_PROFILE)).toBe(
      false,
    );
  });

  it("leaves gemma's turn framing and the plain profile as they are", () => {
    // Gemma 4's disabled marker is the prefilled channel, which the turn
    // framing exists to avoid: no marker, so `off` changes nothing.
    expect(GEMMA4_THINK_PROFILE.promptThinkingDisabledMarker).toBeUndefined();
    expect(thinkingDisabledOnBuiltPrompt("off", GEMMA4_THINK_PROFILE)).toBe(
      false,
    );
    expect(thinkingDisabledOnBuiltPrompt("off", PLAIN_INSTRUCT_PROFILE)).toBe(
      false,
    );
  });
});
