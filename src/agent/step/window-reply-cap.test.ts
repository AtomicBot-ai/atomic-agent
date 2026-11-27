import { describe, expect, it } from "vitest";
import {
  WINDOW_REPLY_HEADROOM_TOKENS,
  windowReplyCap,
  type WindowReplyCapInput,
} from "./window-reply-cap.js";

function input(over: Partial<WindowReplyCapInput> = {}): WindowReplyCapInput {
  return {
    modelMode: "local",
    toolTransport: "grammar",
    configuredCap: 16_384,
    stepCapSet: false,
    contextWindow: 32_768,
    promptTokens: 20_000,
    ...over,
  };
}

describe("windowReplyCap (ATO-1581)", () => {
  it("holds a 32K window's reply to the room the prompt leaves, below the 16,384 cap", () => {
    // Reserve on 32K is now 8,192, so a full prompt leaves less than the cap.
    expect(windowReplyCap(input({ promptTokens: 24_000 }))).toBe(
      32_768 - 24_000 - WINDOW_REPLY_HEADROOM_TOKENS,
    );
  });

  it("leaves the cap alone when it already fits the window", () => {
    expect(windowReplyCap(input({ promptTokens: 4_000 }))).toBeNull();
  });

  it("never raises a cap", () => {
    expect(windowReplyCap(input({ configuredCap: 2_048, promptTokens: 24_000 }))).toBeNull();
  });

  it("keeps a cap the step chose, a cloud or native link, and a configured 0", () => {
    expect(windowReplyCap(input({ stepCapSet: true, promptTokens: 24_000 }))).toBeNull();
    expect(windowReplyCap(input({ modelMode: "cloud", promptTokens: 24_000 }))).toBeNull();
    expect(windowReplyCap(input({ toolTransport: "native_tools", promptTokens: 24_000 }))).toBeNull();
    expect(windowReplyCap(input({ configuredCap: 0, promptTokens: 24_000 }))).toBeNull();
  });

  it("does nothing without a known window or prompt estimate, or when the prompt fills it", () => {
    expect(windowReplyCap(input({ contextWindow: null }))).toBeNull();
    expect(windowReplyCap(input({ promptTokens: 0 }))).toBeNull();
    expect(windowReplyCap(input({ promptTokens: 32_500 }))).toBeNull();
  });
});
