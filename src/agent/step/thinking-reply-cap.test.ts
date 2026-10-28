import { describe, expect, it } from "vitest";
import {
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
  GEMMA4_THINK_PROFILE,
} from "../../llm/model-profile.js";
import {
  THINKING_REPLY_CAP,
  defaultLocalReplyCap,
  localReplyCapEnvSet,
  thinkingReplyCap,
  type ThinkingReplyCapInput,
} from "./thinking-reply-cap.js";

function input(over: Partial<ThinkingReplyCapInput> = {}): ThinkingReplyCapInput {
  return {
    profile: QWEN_THINK_PROFILE,
    thinkingDisabled: false,
    modelMode: "local",
    toolTransport: "grammar",
    configuredCap: defaultLocalReplyCap(),
    stepCapSet: false,
    envCapSet: false,
    contextWindow: null,
    promptTokens: 4_000,
    ...over,
  };
}

describe("thinkingReplyCap (ATO-1031)", () => {
  it("lifts the untouched default for a local thinking model", () => {
    expect(defaultLocalReplyCap()).toBe(16_384);
    expect(thinkingReplyCap(input())).toBe(THINKING_REPLY_CAP);
    expect(thinkingReplyCap(input({ profile: GEMMA4_THINK_PROFILE }))).toBe(
      THINKING_REPLY_CAP,
    );
  });

  it("leaves a model without thinking, or with thinking off, alone", () => {
    expect(thinkingReplyCap(input({ profile: PLAIN_INSTRUCT_PROFILE }))).toBeNull();
    expect(thinkingReplyCap(input({ thinkingDisabled: true }))).toBeNull();
  });

  it("never touches a cap somebody chose", () => {
    expect(thinkingReplyCap(input({ configuredCap: 8_192 }))).toBeNull();
    expect(thinkingReplyCap(input({ configuredCap: 0 }))).toBeNull();
    // ATO-922: the env override wins over the file, and it wins over this lift.
    expect(thinkingReplyCap(input({ envCapSet: true }))).toBeNull();
    // A truncation retry or a fusion worker already carries its own cap.
    expect(thinkingReplyCap(input({ stepCapSet: true }))).toBeNull();
  });

  it("only applies to a local grammar link", () => {
    expect(thinkingReplyCap(input({ modelMode: "cloud" }))).toBeNull();
    expect(thinkingReplyCap(input({ toolTransport: "native_tools" }))).toBeNull();
  });

  it("stays inside a known window, and gives up when the window leaves no room above the default", () => {
    expect(
      thinkingReplyCap(input({ contextWindow: 30_000, promptTokens: 4_000 })),
    ).toBe(30_000 - 4_000 - 512);
    expect(
      thinkingReplyCap(input({ contextWindow: 16_384, promptTokens: 4_000 })),
    ).toBeNull();
  });

  it("reads the env override as set only when it carries a value", () => {
    expect(localReplyCapEnvSet({})).toBe(false);
    expect(localReplyCapEnvSet({ ATOMIC_AGENT_LLAMA_MAX_TOKENS: " " })).toBe(false);
    expect(localReplyCapEnvSet({ ATOMIC_AGENT_LLAMA_MAX_TOKENS: "4096" })).toBe(true);
  });
});
