// Unit tests for main/linear-key-check.ts (ATO-2464), against the built
// output. Run: npm run build && npm run test:unit
//
// The Linear tab's key is checked with one `viewer` query before it is
// saved. `fetch` is a stub; every key is a dummy. The checks: the request is
// that one query with the key as Linear expects it, a refusal is `rejected`,
// anything else that is not an answer is `unreachable`, no answer carries the
// key or Linear's own words, and the .env guard takes the two Linear names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../out/main/linear-key-check.js");
const cli = require("../out/main/agent-cli.js");

const KEY = "lin_api_dummy0123456789abcdefghijklmnop";
const OAUTH = "lin_oauth_dummy0123456789abcdefghijklmn";

function answering(status, body, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
const clean = (res) => assert.ok(!JSON.stringify(res).includes("lin_"), "no key in the answer: " + JSON.stringify(res));

test("a good key: one viewer query, the key as the bare Authorization value, the user back", async () => {
  const calls = [];
  const res = await C.checkLinearKey({ key: KEY, fetchImpl: answering(200, { data: { viewer: { id: "u1", name: "Nadia" } } }, calls) });
  assert.deepEqual(res, { ok: true, viewer: { id: "u1", name: "Nadia" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, C.LINEAR_GRAPHQL_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, KEY);
  assert.match(String(calls[0].init.body), /viewer \{ id name \}/);
});

test("an OAuth token goes in as a bearer token", async () => {
  const calls = [];
  await C.checkLinearKey({ key: OAUTH, fetchImpl: answering(200, { data: { viewer: { id: "app", name: "" } } }, calls) });
  assert.equal(calls[0].init.headers.authorization, `Bearer ${OAUTH}`);
});

test("refusals are rejected, failures unreachable, a bad shape never leaves the machine", async () => {
  const calls = [];
  for (const [status, body] of [[401, {}], [400, { errors: [{ message: "Authentication required " + KEY, extensions: { code: "AUTHENTICATION_ERROR" } }] }]]) {
    const res = await C.checkLinearKey({ key: KEY, fetchImpl: answering(status, body, calls) });
    assert.deepEqual(res, { ok: false, reason: "rejected" });
    clean(res);
  }
  for (const [status, body] of [[500, "oops"], [200, { data: {} }], [502, {}]]) {
    assert.deepEqual(await C.checkLinearKey({ key: KEY, fetchImpl: answering(status, body, calls) }), { ok: false, reason: "unreachable" });
  }
  const offline = await C.checkLinearKey({ key: KEY, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND api.linear.app"); } });
  assert.deepEqual(offline, { ok: false, reason: "unreachable" });
  const before = calls.length;
  for (const bad of ["", "short", "two words in a key that is long", 42, KEY + "\n"]) {
    assert.deepEqual(await C.checkLinearKey({ key: bad, fetchImpl: answering(200, {}, calls) }), { ok: false, reason: "invalid" });
  }
  assert.equal(calls.length, before, "no request for a malformed key");
});

test("the window may write LINEAR_API_KEY and LINEAR_WEBHOOK_SECRET, one line, shaped like a secret", () => {
  assert.equal(cli.desktopDotenvError("LINEAR_API_KEY", KEY), null);
  assert.equal(cli.desktopDotenvError("LINEAR_WEBHOOK_SECRET", "lin_wh_dummy0123456789abcdefghij"), null);
  assert.equal(cli.desktopDotenvError("LINEAR_API_KEY", null), null, "null removes it");
  assert.equal(cli.desktopDotenvError("LINEAR_API_KEY", "short"), C.LINEAR_KEY_INVALID);
  assert.equal(cli.desktopDotenvError("LINEAR_WEBHOOK_SECRET", "two words here and more words"), C.LINEAR_SECRET_INVALID);
  assert.equal(cli.desktopDotenvError("LINEAR_API_KEY", KEY + "\nPATH=/tmp/evil"), "value must be one line");
  assert.match(String(cli.desktopDotenvError("LINEAR_OAUTH_REFRESH_TOKEN", KEY)), /may be written from the desktop/);
});
