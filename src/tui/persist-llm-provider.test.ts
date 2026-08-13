import { describe, expect, it } from "vitest";

import {
  dotenvKeyForProviderKind,
  parseAddProviderJson,
} from "./persist-llm-provider.js";

describe("persist-llm-provider", () => {
  it("maps every wizard kind to its dotenv key", () => {
    expect(dotenvKeyForProviderKind("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(dotenvKeyForProviderKind("aimlapi")).toBe("AIMLAPI_API_KEY");
    expect(dotenvKeyForProviderKind("gemini")).toBe("GEMINI_API_KEY");
    expect(dotenvKeyForProviderKind("openai-compatible")).toBe(
      "OPENAI_COMPAT_API_KEY",
    );
  });

  it("parses a bare aimlapi provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "aimlapi",
        kind: "aimlapi",
        defaultChatModel: "openai/gpt-5-2",
      }),
    );
    expect(entry.id).toBe("aimlapi");
    expect(entry.kind).toBe("aimlapi");
  });

  it("parses a bare openrouter provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "openrouter",
        kind: "openrouter",
        defaultChatModel: "openai/gpt-4o-mini",
      }),
    );
    expect(entry.id).toBe("openrouter");
    expect(entry.kind).toBe("openrouter");
  });

  it("parses llm.providers envelope with one entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        llm: {
          providers: [
            {
              id: "cloud",
              kind: "openai-compatible",
              baseUrl: "https://api.example.com/v1",
              defaultChatModel: "gpt-4o",
            },
          ],
        },
      }),
    );
    expect(entry.id).toBe("cloud");
  });
});
