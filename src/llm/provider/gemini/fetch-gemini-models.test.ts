import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGeminiModels } from "./fetch-gemini-models.js";

const GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/models";

// The module cache is keyed by API key and outlives a test, so every
// test uses a key of its own.
describe("fetchGeminiModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists Google's ids the way the chat route takes them, without `models/`", async () => {
    // The OpenAI-compatible list names every model `models/<id>`; the chat
    // route, the provider's default and every saved config say `<id>`.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "models/gemini-3.8-flash", object: "model" },
              { id: "models/gemini-3.5-flash-lite", object: "model" },
              { id: "gemini-3.6-flash", object: "model" },
              { id: "models/gemini-3.6-flash", object: "model" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ids = await fetchGeminiModels("gm-test-list");

    expect(ids).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.8-flash",
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(GEMINI_MODELS_URL);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer gm-test-list",
    });
  });

  it("says what Google said when it refuses the key", async () => {
    // What the models route answered a dummy key on 2026-10-02: a 400,
    // not a 401, so the status alone does not say "key".
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: "Please pass a valid API key",
                status: "INVALID_ARGUMENT",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(fetchGeminiModels("gm-test-refused")).rejects.toThrow(
      "http 400: Please pass a valid API key",
    );
  });
});
