import { describe, expect, it } from "vitest";

import { geminiModelFromNotFound, geminiNotFoundSentence, isGeminiOpenAiCompatUrl } from "./gemini-openai-compat.js";

describe("isGeminiOpenAiCompatUrl (ATO-1282)", () => {
  it("knows Google's endpoint by its host, whatever the path", () => {
    expect(isGeminiOpenAiCompatUrl("https://generativelanguage.googleapis.com")).toBe(true);
    expect(isGeminiOpenAiCompatUrl("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")).toBe(true);
    expect(isGeminiOpenAiCompatUrl("https://GenerativeLanguage.googleapis.com/v1beta/openai")).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isGeminiOpenAiCompatUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isGeminiOpenAiCompatUrl("https://generativelanguage.googleapis.com.evil.example")).toBe(false);
    expect(isGeminiOpenAiCompatUrl("not a url")).toBe(false);
  });
});

describe("geminiNotFoundSentence (ATO-1282)", () => {
  const body = "models/gemini-9-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.";

  it("names the model Gemini could not find", () => {
    expect(geminiModelFromNotFound(body)).toBe("gemini-9-flash");
    expect(geminiNotFoundSentence('"gemini"', body)).toBe(
      '"gemini" answered 404: the model "gemini-9-flash" is not available on Gemini. ' +
        "Check the model id against the Gemini model list, or pick another model.",
    );
  });

  it("still says what to do when the body names no model", () => {
    expect(geminiModelFromNotFound("Not Found")).toBeNull();
    // A 404 that names no model (wrong base path, typo) is not told as a missing model.
    expect(geminiNotFoundSentence('"gemini"', "Not Found")).toBe(
      '"gemini" answered 404 (not found). The model id or the base URL is likely wrong.',
    );
  });
});
