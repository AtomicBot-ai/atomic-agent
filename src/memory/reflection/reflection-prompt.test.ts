import { describe, expect, it } from "vitest";

import {
  REFLECTION_MESSAGE_CHAR_CAP,
  REFLECTION_STABLE_PREFIX,
  buildReflectionPrompt,
} from "./reflection-prompt.js";

describe("buildReflectionPrompt", () => {
  it("keeps the stable prefix byte-identical across calls", () => {
    const a = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
    });
    const b = buildReflectionPrompt({
      userMessage: "another turn",
      assistantReply: "different reply",
    });
    expect(a.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(b.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(a.slice(0, REFLECTION_STABLE_PREFIX.length)).toEqual(
      b.slice(0, REFLECTION_STABLE_PREFIX.length),
    );
  });

  it("injects the USER and ASSISTANT messages into the tail", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "I live in Lisbon",
      assistantReply: "Noted, I'll remember that.",
    });
    expect(prompt).toContain("USER: I live in Lisbon");
    expect(prompt).toContain("ASSISTANT: Noted, I'll remember that.");
    expect(prompt.endsWith("### output\n")).toBe(true);
  });

  it("collapses whitespace and trims each message", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "  multi\n   line   user   ",
      assistantReply: "tab\treply\nhere",
    });
    expect(prompt).toContain("USER: multi line user");
    expect(prompt).toContain("ASSISTANT: tab reply here");
  });

  it("clamps oversized messages to the character cap", () => {
    const huge = "x".repeat(REFLECTION_MESSAGE_CHAR_CAP + 500);
    const prompt = buildReflectionPrompt({
      userMessage: huge,
      assistantReply: "ok",
    });
    const userLine = prompt.match(/USER: (.+)/)?.[1] ?? "";
    expect(userLine.length).toBeLessThanOrEqual(REFLECTION_MESSAGE_CHAR_CAP);
    expect(userLine.endsWith("…")).toBe(true);
  });
});
