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

/* Backlog 40: a good key on an account with no funds. AI/ML API answers it
   with a 403 that says so; the check read every 403 as a refused key, and the
   setup threw the key away. */
test("AI/ML API's 403 for an empty account is a key that works, with the provider's first sentence", async () => {
  const calls = [];
  globalThis.fetch = answering(
    403,
    JSON.stringify({
      title: "Forbidden",
      status: 403,
      message:
        "You've run out of funds. Please top up your balance or update your payment method to continue: https://aimlapi.com/app/billing",
    }),
    calls,
  );
  const res = await verifyProviderKey({ id: "aimlapi", kind: "aimlapi", apiKey: "aiml-dummy-check" }, "openai/gpt-oss-20b");
  assert.deepEqual(calls, ["https://api.aimlapi.com/v1/chat/completions"]);
  assert.deepEqual(res, {
    ok: true,
    checked: true,
    status: 403,
    noFunds: true,
    error: "Key works, but the account has no funds.",
    detail: "You've run out of funds",
  });
});

test("a 402 and OpenAI's 429 insufficient_quota are an empty account; a rate limit and a refused key are not", async () => {
  const ask = async (status, body) => {
    globalThis.fetch = answering(status, JSON.stringify(body), []);
    return verifyProviderKey({ id: "p", kind: "openai-compatible", baseUrl: "https://api.example.com", apiKey: "sk-dummy-check" }, "m");
  };
  const paid = await ask(402, { error: { message: "Insufficient Balance" } });
  assert.equal(paid.ok, true);
  assert.equal(paid.noFunds, true);
  const quota = await ask(429, {
    error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" },
  });
  assert.equal(quota.ok, true);
  assert.equal(quota.noFunds, true);
  // Gemini's free tier: a per-minute limit in quota and billing words.
  const rate = await ask(429, {
    error: { message: "You exceeded your current quota, please check your plan and billing details. Please retry in 30s." },
  });
  assert.deepEqual(rate, { ok: true, checked: true, status: 429 });
  const refused = await ask(403, { error: { message: "Invalid API key. Check your billing settings." } });
  assert.equal(refused.ok, false);
  assert.equal(refused.noFunds, undefined);
  assert.match(refused.error, /^the provider rejected this key/);
});

test("the key check reads money the way the agent does: rate limits, cooldowns, the key's words and every 401 stay what they were", async () => {
  const ask = async (status, body, headers = {}) => {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    return verifyProviderKey({ id: "p", kind: "openai-compatible", baseUrl: "https://api.example.com", apiKey: "sk-dummy-check" }, "m");
  };
  // A 429 that talks money in a rate limit's words is a rate limit: a key that works.
  for (const message of [
    "Too many requests. Please top up your account to increase your rate limits.",
    "Out of credits for this minute",
  ]) {
    assert.deepEqual(await ask(429, { error: { message } }), { ok: true, checked: true, status: 429 }, message);
  }
  // So is an empty account's 429 that asked for a cooldown.
  assert.deepEqual(
    await ask(429, { error: { message: "insufficient balance" } }, { "retry-after": "30" }),
    { ok: true, checked: true, status: 429 },
  );
  // A 402 that only asked to wait (OpenRouter's in-flight budget) is a key that works too.
  assert.deepEqual(
    await ask(402, { error: { code: "in_flight_budget_exhausted", message: "Too many requests in flight for your balance" } }),
    { ok: true, checked: true, status: 402 },
  );
  // Authentication or token words beside billing words are about the key, and a 401 always is.
  for (const [status, message] of [
    [403, "Authentication failed. Please check your billing details."],
    [403, "Invalid token. Check billing."],
    [401, "Insufficient balance"],
  ]) {
    const res = await ask(status, { error: { message } });
    assert.equal(res.ok, false, message);
    assert.equal(res.noFunds, undefined, message);
  }
});
