import { describe, expect, it } from "vitest";

import {
  GOOGLE_CACHE_ROUTE_PREFERENCES,
  applyAnthropicCacheControl,
  isAnthropicHost,
  isAnthropicModel,
  isGoogleModel,
} from "./prompt-cache-control.js";

const EPHEMERAL = { type: "ephemeral" };

describe("model and host detection", () => {
  it("names Anthropic models through a router and directly", () => {
    expect(isAnthropicModel("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(isAnthropicModel("claude-opus-4-1")).toBe(true);
    expect(isAnthropicModel("Anthropic/Claude-3.7")).toBe(true);
    expect(isAnthropicModel("openai/gpt-5")).toBe(false);
    expect(isAnthropicModel("google/gemini-3.8-flash")).toBe(false);
  });

  it("names Anthropic's own host and nothing else", () => {
    expect(isAnthropicHost("https://api.anthropic.com/v1")).toBe(true);
    expect(isAnthropicHost("https://api.anthropic.com")).toBe(true);
    expect(isAnthropicHost("https://openrouter.ai/api")).toBe(false);
    expect(isAnthropicHost("not a url")).toBe(false);
    expect(isAnthropicHost(undefined)).toBe(false);
  });

  it("names Google models on OpenRouter", () => {
    expect(isGoogleModel("google/gemini-3.8-flash")).toBe(true);
    expect(isGoogleModel("Google/gemma-4-31b")).toBe(true);
    expect(isGoogleModel("gemini-3.8-flash")).toBe(false);
    expect(GOOGLE_CACHE_ROUTE_PREFERENCES).toEqual({
      order: ["Google AI Studio", "Google"],
      allow_fallbacks: true,
    });
  });
});

describe("applyAnthropicCacheControl", () => {
  it("marks the system message and the last history message before the tail", () => {
    const messages = [
      { role: "system", content: "prefix" },
      { role: "user", content: "build it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "### respond\nRespond now." },
    ];
    const marked = applyAnthropicCacheControl(messages);
    expect(marked[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "prefix", cache_control: EPHEMERAL }],
    });
    expect(marked[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "ok", cache_control: EPHEMERAL }],
    });
    // Never inside the changing tail, never on the user turn in between.
    expect(marked[1]).toEqual(messages[1]);
    expect(marked[2]).toEqual(messages[2]);
    expect(marked[4]).toEqual(messages[4]);
    // Two breakpoints, well under Anthropic's four.
    expect(JSON.stringify(marked).split("ephemeral")).toHaveLength(3);
  });

  it("skips back over a tool-calls-only assistant message to the nearest text", () => {
    const marked = applyAnthropicCacheControl([
      { role: "system", content: "prefix" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "user", content: "tail" },
    ]);
    expect(marked[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }],
    });
    expect(marked[2]).toEqual({ role: "assistant", content: null, tool_calls: [] });
  });

  it("marks only the system message when there is no history", () => {
    const marked = applyAnthropicCacheControl([
      { role: "system", content: "prefix" },
      { role: "user", content: "tail" },
    ]);
    expect(marked[0]?.content).toEqual([
      { type: "text", text: "prefix", cache_control: EPHEMERAL },
    ]);
    expect(marked[1]).toEqual({ role: "user", content: "tail" });
  });

  it("leaves the flat single-message form untouched", () => {
    const flat = [{ role: "user", content: "everything" }];
    expect(applyAnthropicCacheControl(flat)).toEqual(flat);
  });

  it("marks the last text part of a message already split into parts", () => {
    const marked = applyAnthropicCacheControl([
      {
        role: "system",
        content: [
          { type: "text", text: "a" },
          { type: "image_url", image_url: { url: "data:," } },
          { type: "text", text: "b" },
        ],
      },
      { role: "user", content: "tail" },
    ]);
    expect(marked[0]?.content).toEqual([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "data:," } },
      { type: "text", text: "b", cache_control: EPHEMERAL },
    ]);
  });

  it("does not mutate its input", () => {
    const messages = [
      { role: "system", content: "prefix" },
      { role: "user", content: "hi" },
      { role: "user", content: "tail" },
    ];
    const snapshot = JSON.stringify(messages);
    applyAnthropicCacheControl(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
