// Unit tests for main/telegram-token-check.ts (ATO-426, U-77), against the
// built output. Run: npm run build && npm run test:unit
//
// The Telegram tab's token is checked with one getMe before it is saved.
// `fetch` is a stub here; every token is a dummy. The checks that matter:
// the request is the Bot API's getMe for that token and nothing else, a
// 401 / 404 is a rejection (the window will not save), anything else that
// is not a 200 is "could not check" (the window saves with a warning), and
// no answer ever carries the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../out/main/telegram-token-check.js");

const TOKEN = "123456789:AAF1xYzDummyTokenValue_0123456789abcd";

/** A fetch that records each call and answers with `status` / `body`. */
function answering(status, body, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
function noToken(res) {
  assert.ok(!JSON.stringify(res).includes(TOKEN), "the answer never carries the token: " + JSON.stringify(res));
}

test("the shape rule matches the renderer's: digits, a colon, a long code", () => {
  assert.equal(C.telegramTokenValueError(TOKEN), null);
  for (const bad of ["", "desktop smoke:token #1", "123456789", "123456789:short", "123456789:AAF1/../x_0123456789abcdefghijklmnop", "123456789:AAF1?x=1_0123456789abcdefghijklmnop", 42, null]) {
    assert.equal(C.telegramTokenValueError(bad), C.TELEGRAM_TOKEN_INVALID, String(bad));
  }
});

test("a good token: one GET to /bot<token>/getMe, the bot's username and id come back", async () => {
  const calls = [];
  const res = await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(200, { ok: true, result: { id: 123456789, is_bot: true, username: "my_bot" } }, calls) });
  assert.deepEqual(res, { ok: true, username: "my_bot", botId: 123456789 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, C.TELEGRAM_API_BASE + "/bot" + TOKEN + "/getMe");
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].init.signal, "a timeout rides on the request");
  const base = [];
  await C.checkTelegramToken({ token: TOKEN, baseUrl: "http://127.0.0.1:1/api", fetchImpl: answering(200, { ok: true, result: {} }, base) });
  assert.equal(base[0].url, "http://127.0.0.1:1/api/bot" + TOKEN + "/getMe");
  // A bot without a username (not possible in Telegram, but the reply is not trusted) is still ok.
  assert.deepEqual(await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(200, { ok: true, result: {} }, []) }), { ok: true, username: null, botId: null });
});

test("401 and 404 are Telegram rejecting the token; the error names the status, never the token", async () => {
  for (const status of [401, 404]) {
    const res = await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(status, { ok: false, error_code: status, description: "Unauthorized" }, []) });
    assert.equal(res.ok, false);
    assert.equal(res.rejected, true, String(status));
    assert.equal(res.status, status);
    assert.equal(res.error, "Telegram did not accept the token (HTTP " + status + ").");
    noToken(res);
  }
});

test("an unshaped value is rejected without any request", async () => {
  const calls = [];
  const res = await C.checkTelegramToken({ token: "desktop smoke:token #1", fetchImpl: answering(200, { ok: true, result: {} }, calls) });
  assert.deepEqual(res, { ok: false, rejected: true, status: 0, error: C.TELEGRAM_TOKEN_INVALID });
  assert.equal(calls.length, 0, "a `/`, `?` or space never reaches the URL");
});

test("offline, a timeout, a 5xx and an unreadable reply are 'could not check', not a rejection", async () => {
  const down = await C.checkTelegramToken({ token: TOKEN, fetchImpl: async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.telegram.org") }); } });
  assert.equal(down.ok, false);
  assert.equal(down.rejected, false);
  assert.equal(down.error, "Could not reach Telegram: getaddrinfo ENOTFOUND api.telegram.org.");
  noToken(down);
  const slow = await C.checkTelegramToken({ token: TOKEN, fetchImpl: async () => { const e = new Error("x"); e.name = "TimeoutError"; throw e; } });
  assert.equal(slow.rejected, false);
  assert.equal(slow.error, "Could not reach Telegram: the request timed out.");
  const five = await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(502, "Bad Gateway", []) });
  assert.equal(five.rejected, false);
  assert.equal(five.status, 502);
  assert.match(five.error, /^Telegram returned HTTP 502/);
  const junk = await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(200, "<html>", []) });
  assert.equal(junk.rejected, false);
  assert.equal(junk.error, "Telegram returned a reply that is not JSON.");
  const notOk = await C.checkTelegramToken({ token: TOKEN, fetchImpl: answering(200, { ok: false, description: "Bad Request: something" }, []) });
  assert.equal(notOk.rejected, false);
  assert.equal(notOk.error, "Telegram did not confirm the bot: Bad Request: something.");
  for (const r of [slow, five, junk, notOk]) noToken(r);
});
