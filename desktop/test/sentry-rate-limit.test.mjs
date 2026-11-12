// ATO-1286: main/sentry/rate-limit.ts and its use in main/sentry/client.ts,
// against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the key is the envelope's fingerprint plus the normalized message", () => {
  const ev = { type: "TypeError", tags: { source: "renderer" }, frames: [{ filename: "app.js", lineno: 3 }] };
  const fp = E.fingerprintOf(ev);
  assert.deepEqual(fp, ["{{ default }}", "TypeError", "renderer", "", "", "app.js"]);
  assert.equal(R.sentryGroupingKey(fp, "boom"), R.sentryGroupingKey([...fp], "boom"));
  assert.notEqual(
    R.sentryGroupingKey(fp, "boom"),
    R.sentryGroupingKey(E.fingerprintOf({ ...ev, type: "RangeError" }), "boom"),
  );
  // Same file, different bug: its own budget. The fingerprint is unchanged.
  assert.notEqual(R.sentryGroupingKey(fp, "x is not a function"), R.sentryGroupingKey(fp, "y is undefined"));
  // Two copies of one failure that differ only in a port, path or count share it.
  assert.equal(
    R.sentryGroupingKey(fp, "connect ECONNREFUSED 127.0.0.1:8093"),
    R.sentryGroupingKey(fp, "connect ECONNREFUSED 127.0.0.1:19091"),
  );
  assert.equal(R.sentryGroupingKey(fp, undefined), R.sentryGroupingKey(fp, 42));
  assert.equal(R.normalizeMessage("open '/Users/ann/x/y.json' failed 3 times"), "open '<path>' failed <n> times");
});

test("reportError sends 10 copies of one failure per install per hour, across launches", () => {
  const root = mkdtempSync(join(tmpdir(), "desk-sentry-report-"));
  const desk = join(root, "desktop");
  const tui = join(root, "tui");
  mkdirSync(desk, { recursive: true });
  mkdirSync(tui, { recursive: true });
  writeFileSync(join(desk, "config.json"), JSON.stringify({ analytics: { enabled: true } }));
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  const envelopes = [];
  try {
    process.env.ATOMIC_AGENT_INSTALL_ID_FILE = join(root, "install-id");
    process.env.ATOMIC_DESKTOP_SENTRY_DSN = "https://pub@o1.ingest.sentry.io/7";
    delete process.env.DO_NOT_TRACK;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/envelope/")) envelopes.push(String(init.body));
      return { ok: true, status: 200 };
    };
    const CORE = require("../out/main/analytics/core.js");
    CORE.initAnalytics({ stateDir: desk, tuiStateDir: tui, freshState: true, testRun: false });
    assert.equal(CORE.sendingAllowed(), true);

    const clientPath = require.resolve("../out/main/sentry/client.js");
    let client = require(clientPath);
    const MESSAGE = "Cannot read properties of undefined (reading 'x')";
    const bug = (line, message = MESSAGE) => ({
      source: "renderer",
      name: "TypeError",
      message,
      stack: `TypeError: ${message}\n    at paint (app://./renderer.js:${line}:5)`,
    });

    // One failure from four lines of renderer.js: four session signatures
    // (3 each, 12 attempts), so the per-session caps let all of them through
    // and only the per-install limiter can stop the last two.
    for (const line of [10, 11, 12, 13]) {
      for (let i = 0; i < 3; i += 1) client.reportError(bug(line));
    }
    assert.equal(envelopes.length, 10);
    const fingerprints = new Set(envelopes.map((b) => JSON.stringify(JSON.parse(b.split("\n")[2]).fingerprint)));
    assert.equal(fingerprints.size, 1);

    // A different bug in the same file has the same fingerprint, but its own budget.
    client.reportError(bug(20, "paint is not a function"));
    assert.equal(envelopes.length, 11);

    // A relaunch starts the per-session caps over; the budget is read back
    // from the state file, so the first failure stays dropped.
    delete require.cache[clientPath];
    client = require(clientPath);
    client.reportError(bug(30));
    assert.equal(envelopes.length, 11);
    client.reportError(bug(31, "yet another bug"));
    assert.equal(envelopes.length, 12);
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
