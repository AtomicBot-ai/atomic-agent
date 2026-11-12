// ATO-1286: main/sentry/rate-limit.ts, against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const R = require("../out/main/sentry/rate-limit.js");
const E = require("../out/main/sentry/envelope.js");

const HOUR = R.SENTRY_RATE_LIMIT_WINDOW_MS;

/** A hand-moved clock. */
function clock(start = Date.UTC(2026, 10, 12, 10)) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("the limits are 10 per rolling hour", () => {
  assert.equal(R.SENTRY_RATE_LIMIT_MAX_EVENTS, 10);
  assert.equal(HOUR, 60 * 60 * 1000);
});

test("10 identical events pass, the 11th is dropped", () => {
  const c = clock();
  const l = new R.SentryRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(l.shouldSend("same"), true, `event ${i + 1}`);
    c.advance(1000);
  }
  assert.equal(l.shouldSend("same"), false);
});

test("different events are counted independently", () => {
  const c = clock();
  const l = new R.SentryRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) l.shouldSend("a");
  assert.equal(l.shouldSend("a"), false);
  for (let i = 0; i < 10; i += 1) assert.equal(l.shouldSend("b"), true);
  assert.equal(l.shouldSend("b"), false);
});

test("after an hour the event passes again", () => {
  const c = clock();
  const l = new R.SentryRateLimiter({ now: c.now });
  for (let i = 0; i < 10; i += 1) l.shouldSend("same");
  c.advance(HOUR - 1);
  assert.equal(l.shouldSend("same"), false);
  c.advance(1);
  assert.equal(l.shouldSend("same"), true);
});

test("the budget survives a relaunch through the state file, which holds no event text", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-sentry-rl-"));
  try {
    const storePath = join(dir, R.SENTRY_RATE_LIMIT_FILE);
    const c = clock();
    const first = new R.SentryRateLimiter({ now: c.now, storePath });
    for (let i = 0; i < 10; i += 1) first.shouldSend("RendererError boom");
    assert.doesNotMatch(readFileSync(storePath, "utf8"), /RendererError/);
    const second = new R.SentryRateLimiter({ now: c.now, storePath });
    assert.equal(second.shouldSend("RendererError boom"), false);
    c.advance(HOUR);
    const third = new R.SentryRateLimiter({ now: c.now, storePath });
    assert.equal(third.shouldSend("RendererError boom"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key is the envelope's fingerprint, else type + normalized message + top in-app frame", () => {
  const ev = { type: "TypeError", tags: { source: "renderer" }, frames: [{ filename: "app.js", lineno: 3 }] };
  const fp = E.fingerprintOf(ev);
  assert.deepEqual(fp, ["{{ default }}", "TypeError", "renderer", "", "", "app.js"]);
  assert.equal(R.sentryGroupingKey({ fingerprint: fp }), R.sentryGroupingKey({ fingerprint: [...fp] }));
  assert.notEqual(
    R.sentryGroupingKey({ fingerprint: fp }),
    R.sentryGroupingKey({ fingerprint: E.fingerprintOf({ ...ev, type: "RangeError" }) }),
  );
  const ex = (value) => ({ exception: { values: [{ type: "Error", value, stacktrace: { frames: [{ filename: "a.js", function: "f", in_app: true }] } }] } });
  assert.equal(
    R.sentryGroupingKey(ex("connect ECONNREFUSED 127.0.0.1:8093")),
    R.sentryGroupingKey(ex("connect ECONNREFUSED 127.0.0.1:19091")),
  );
  assert.equal(R.normalizeMessage("open '/Users/ann/x/y.json' failed 3 times"), "open '<path>' failed <n> times");
});
