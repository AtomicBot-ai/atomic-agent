// Unit tests for verifyProviderKey in main/agent-cli.ts, against the built output.
// Run: npm run build && npm run test:unit
// `fetch` is replaced for each test: nothing here leaves the machine.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyProviderKey } = require("../out/main/agent-cli.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that records each URL and answers every request the same way. */
function answering(status, body, calls) {
  return async (url) => {
    calls.push(String(url));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
}

test("a Perplexity key is checked where Perplexity serves chat, not under /v1", async () => {
  // Both answers are what api.perplexity.ai gave a dummy key on 2026-10-02:
  // 404 under /v1, a 401 naming the key at /chat/completions.
  const calls = [];
  globalThis.fetch = answering(
    401,
    JSON.stringify({ error: { message: "Invalid API key provided.", type: "invalid_api_key", code: 401 } }),
    calls,
  );
  const res = await verifyProviderKey(
    { id: "perplexity", kind: "openai-compatible", baseUrl: "https://api.perplexity.ai", apiKey: "pplx-dummy-check" },
    "sonar",
  );
  assert.deepEqual(calls, ["https://api.perplexity.ai/chat/completions"]);
  assert.deepEqual(res, {
    ok: false,
    checked: true,
    status: 401,
    error: "the provider rejected this key: Invalid API key provided.",
  });
});

test("a stored /v1 finds Perplexity's route; every other root keeps /v1/chat/completions", async () => {
  const cases = [
    ["https://api.perplexity.ai/v1", "https://api.perplexity.ai/chat/completions"],
    ["https://api.perplexity.ai/router", "https://api.perplexity.ai/router/v1/chat/completions"],
    ["https://api.groq.com/openai", "https://api.groq.com/openai/v1/chat/completions"],
    ["https://api.x.ai/v1/", "https://api.x.ai/v1/chat/completions"],
  ];
  for (const [baseUrl, expected] of cases) {
    const calls = [];
    globalThis.fetch = answering(200, JSON.stringify({ choices: [{ message: { content: "pong" } }] }), calls);
    const res = await verifyProviderKey({ id: "p", kind: "openai-compatible", baseUrl, apiKey: "sk-dummy-check" }, "m");
    assert.deepEqual(calls, [expected], baseUrl);
    assert.equal(res.ok, true, baseUrl);
  }
});

test("Gemini's array-wrapped error reaches the person as its sentence", async () => {
  // Byte for byte what Google's OpenAI-compatible chat route answered a
  // dummy key on 2026-10-02.
  const calls = [];
  globalThis.fetch = answering(
    400,
    '[{\n  "error": {\n    "code": 400,\n    "message": "Please pass a valid API key",\n    "status": "INVALID_ARGUMENT"\n  }\n}\n]\n',
    calls,
  );
  const res = await verifyProviderKey({ id: "gemini", kind: "gemini", apiKey: "gm-dummy-check" }, "gemini-3.8-flash");
  assert.deepEqual(calls, ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"]);
  assert.equal(res.status, 400);
  assert.equal(res.error, "the provider answered HTTP 400: Please pass a valid API key");
});
