import { describe, expect, it } from "vitest";
import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";

describe("normalizeOpenAiBaseUrl", () => {
  it("strips trailing slashes and an explicit /v1", () => {
    expect(normalizeOpenAiBaseUrl(" https://vllm.example/v1/ ")).toBe(
      "https://vllm.example",
    );
    expect(normalizeOpenAiBaseUrl("https://vllm.example")).toBe(
      "https://vllm.example",
    );
  });

  it("leaves other version segments alone", () => {
    expect(normalizeOpenAiBaseUrl("https://host/api/v2")).toBe(
      "https://host/api/v2",
    );
    expect(normalizeOpenAiBaseUrl("https://host/v10")).toBe("https://host/v10");
  });
});
