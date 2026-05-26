import { describe, expect, it } from "vitest";

import { parseAddProviderJson } from "./persist-llm-provider.js";

describe("persist-llm-provider", () => {
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
