import { describe, expect, it } from "vitest";

import {
  isOllamaCloudHost,
  isOllamaCloudModel,
  isOllamaDaemon,
  needsThinkTagSafe,
  neutralizeThinkTags,
  neutralizeThinkTagsInMessage,
} from "./think-tag-safe.js";

describe("isOllamaCloudHost (issue #283)", () => {
  it("is Ollama's hosted API only", () => {
    expect(isOllamaCloudHost("https://ollama.com")).toBe(true);
    expect(isOllamaCloudHost("https://ollama.com/v1")).toBe(true);
    expect(isOllamaCloudHost("https://api.ollama.com")).toBe(true);
    expect(isOllamaCloudHost("http://localhost:11434")).toBe(false);
    expect(isOllamaCloudHost("http://127.0.0.1:11434")).toBe(false);
    expect(isOllamaCloudHost("https://api.openai.com/v1")).toBe(false);
    expect(isOllamaCloudHost("https://api.deepseek.com")).toBe(false);
    expect(isOllamaCloudHost("https://ollama.com.example.org")).toBe(false);
    expect(isOllamaCloudHost("https://notollama.com")).toBe(false);
    expect(isOllamaCloudHost("not a url")).toBe(false);
    expect(isOllamaCloudHost(undefined)).toBe(false);
  });
});

describe("neutralizeThinkTags", () => {
  it("rewrites the four tags to visible brackets of the same length", () => {
    const text = "a <think> b </think> c <thinking> d </thinking> e";
    const safe = neutralizeThinkTags(text);
    expect(safe).toBe("a [think] b [/think] c [thinking] d [/thinking] e");
    expect(safe.length).toBe(text.length);
  });

  it("plants no invisible characters", () => {
    expect(neutralizeThinkTags("<think></thinking>")).toMatch(/^[\x20-\x7e]*$/);
  });

  it("leaves other text and other tags alone", () => {
    const text = "<div><thinker> <Think> [START-THINK] <think x> plain";
    expect(neutralizeThinkTags(text)).toBe(text);
  });
});

describe("neutralizeThinkTagsInMessage", () => {
  it("rewrites content, content parts and tool-call arguments, never reasoning", () => {
    const message = {
      role: "assistant",
      content: "say <think>",
      reasoning_content: "<think>keep</think>",
      reasoning: "<thinking>keep</thinking>",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "os__fs__write", arguments: "{\"text\":\"</think>\"}" } },
      ],
    };
    expect(neutralizeThinkTagsInMessage(message)).toEqual({
      role: "assistant",
      content: "say [think]",
      reasoning_content: "<think>keep</think>",
      reasoning: "<thinking>keep</thinking>",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "os__fs__write", arguments: "{\"text\":\"[/think]\"}" } },
      ],
    });
    // The input is not mutated.
    expect(message.content).toBe("say <think>");
    expect(message.tool_calls[0]!.function.arguments).toBe("{\"text\":\"</think>\"}");
  });

  it("rewrites the text of content parts and keeps image parts", () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
    const out = neutralizeThinkTagsInMessage({
      role: "user",
      content: [image, { type: "text", text: "what is <thinking>?" }],
    });
    expect(out.content).toEqual([image, { type: "text", text: "what is [thinking]?" }]);
  });

  it("returns the same object when there is nothing to change", () => {
    const message = { role: "user", content: "hello" };
    expect(neutralizeThinkTagsInMessage(message)).toBe(message);
  });
});

describe("Ollama cloud models through a local daemon (ATO-2771)", () => {
  it("knows Ollama's cloud model names", () => {
    expect(isOllamaCloudModel("deepseek-v4-flash:cloud")).toBe(true);
    expect(isOllamaCloudModel("gpt-oss:120b-cloud")).toBe(true);
    expect(isOllamaCloudModel("Qwen3-Coder:480B-Cloud")).toBe(true);
    expect(isOllamaCloudModel("qwen3:8b")).toBe(false);
    expect(isOllamaCloudModel("cloudy:7b")).toBe(false);
    expect(isOllamaCloudModel(undefined)).toBe(false);
  });

  it("finds an Ollama daemon by preset id or by port 11434 on a local address", () => {
    expect(isOllamaDaemon("ollama", "http://localhost:11434")).toBe(true);
    expect(isOllamaDaemon("my-box", "http://127.0.0.1:11434/v1")).toBe(true);
    expect(isOllamaDaemon("lan", "http://192.168.1.20:11434")).toBe(true);
    expect(isOllamaDaemon("ollama", "http://gpu-box.example.net:8000")).toBe(true);
    expect(isOllamaDaemon("lmstudio", "http://127.0.0.1:1234")).toBe(false);
    expect(isOllamaDaemon("vllm", "http://127.0.0.1:8000")).toBe(false);
    expect(isOllamaDaemon("ollama-cloud", "https://ollama.com")).toBe(false);
    expect(isOllamaDaemon("ollama", "https://ollama.com")).toBe(false);
    expect(isOllamaDaemon("remote", "https://example.com:11434")).toBe(false);
    expect(isOllamaDaemon("ollama", undefined)).toBe(false);
  });

  it("neutralizes a cloud model on the local daemon and the hosted API, nothing else", () => {
    const local = "http://127.0.0.1:11434";
    expect(needsThinkTagSafe({ id: "ollama", baseUrl: local, model: "deepseek-v4-flash:cloud" })).toBe(true);
    expect(needsThinkTagSafe({ id: "ollama", baseUrl: local, model: "gpt-oss:120b-cloud" })).toBe(true);
    expect(needsThinkTagSafe({ id: "ollama-cloud", baseUrl: "https://ollama.com", model: "gpt-oss:120b" })).toBe(true);
    // A plain local model on local Ollama stays byte-identical.
    expect(needsThinkTagSafe({ id: "ollama", baseUrl: local, model: "qwen3:8b" })).toBe(false);
    // A `-cloud` name on a server that is not Ollama is not Ollama's cloud.
    expect(needsThinkTagSafe({ id: "llamacpp", baseUrl: "http://127.0.0.1:8080", model: "my-model-cloud" })).toBe(false);
    expect(needsThinkTagSafe({ id: "lmstudio", baseUrl: "http://localhost:1234", model: "gpt-oss:120b-cloud" })).toBe(false);
    expect(needsThinkTagSafe({ id: "openai", baseUrl: "https://api.openai.com/v1", model: "x:cloud" })).toBe(false);
  });
});
