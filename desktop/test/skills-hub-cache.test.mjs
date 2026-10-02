// Unit tests for main/skills-hub-cache.ts (Д45, the Skills Hub's kept answer), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  SkillsHubCache, hubCacheKey, hubConfigKey, HUB_CACHE_FRESH_MS, HUB_CACHE_MAX_AGE_MS, HUB_CACHE_MAX_ENTRIES,
} = require("../out/main/skills-hub-cache.js");

const ROWS = [
  { identifier: "@pskoett/self-improving-agent", source: "clawhub", downloads: 482149, description: "Captures learnings." },
  { identifier: "anthropics/skills/pdf", source: "github", downloads: null, description: "Reads PDFs." },
];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "aa-hubcache-"));
  return { dir, file: join(dir, "skills-hub-cache.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const answer = (rows, hubError = null) => async () => ({ ok: true, rows, hubError });

test("a query's key ignores case and spacing", () => {
  assert.equal(hubCacheKey("  PDF   Tools "), "pdf tools");
  assert.equal(hubCacheKey(""), "");
});

test("a whole answer is kept, fresh for 15 minutes, then shown stale, then dropped", async () => {
  const s = scratch();
  try {
    let now = 1_800_000_000_000;
    const cache = new SkillsHubCache(s.file, () => now);
    assert.equal(cache.peek("", "c"), null);
    const res = await cache.refresh("", "c", answer(ROWS));
    assert.equal(res.ok, true);
    assert.equal(res.savedAt, now);
    assert.deepEqual(cache.peek("", "c"), { ok: true, rows: ROWS, hubError: null, savedAt: now, fresh: true });
    now += HUB_CACHE_FRESH_MS;
    assert.equal(cache.peek("", "c").fresh, false);
    now += HUB_CACHE_MAX_AGE_MS;
    assert.equal(cache.peek("", "c"), null);
  } finally { s.done(); }
});

test("an answer is kept per config: other taps see nothing", async () => {
  const s = scratch();
  try {
    const cache = new SkillsHubCache(s.file);
    await cache.refresh("pdf", "taps-a", answer(ROWS));
    assert.ok(cache.peek("pdf", "taps-a"));
    assert.equal(cache.peek("pdf", "taps-b"), null);
  } finally { s.done(); }
});

test("asks for one query while one runs share it", async () => {
  const s = scratch();
  try {
    const cache = new SkillsHubCache(s.file);
    let runs = 0;
    const slow = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return { ok: true, rows: ROWS, hubError: null }; };
    const [a, b] = await Promise.all([cache.refresh("Pdf", "c", slow), cache.refresh("pdf ", "c", slow)]);
    assert.equal(runs, 1);
    assert.equal(a, b);
    await cache.refresh("pdf", "c", slow);
    assert.equal(runs, 2, "a finished run is not reused");
  } finally { s.done(); }
});

test("a cut answer never replaces a whole one, is never fresh, and a failure is not kept", async () => {
  const s = scratch();
  try {
    const cache = new SkillsHubCache(s.file);
    await cache.refresh("", "c", answer(ROWS));
    const cut = await cache.refresh("", "c", answer(ROWS.slice(0, 1), "anthropics/skills: GitHub rate limit exceeded"));
    assert.equal(cut.rows.length, 1, "the window still gets what came back");
    assert.equal(cache.peek("", "c").rows.length, 2);
    await cache.refresh("docx", "c", answer(ROWS.slice(1), "clawhub: ClawHub request failed (503)"));
    const kept = cache.peek("docx", "c");
    assert.equal(kept.rows.length, 1);
    assert.equal(kept.fresh, false);
    await cache.refresh("none", "c", answer([], "every source failed"));
    assert.equal(cache.peek("none", "c"), null);
    const failed = await cache.refresh("x", "c", async () => ({ ok: false, error: "no binary" }));
    assert.deepEqual(failed, { ok: false, error: "no binary" });
    assert.equal(cache.peek("x", "c"), null);
  } finally { s.done(); }
});

test("it survives a restart, a corrupt file and bad rows", async () => {
  const s = scratch();
  try {
    await new SkillsHubCache(s.file).refresh("", "c", answer(ROWS));
    assert.equal(new SkillsHubCache(s.file).peek("", "c").rows.length, 2);
    const raw = JSON.parse(readFileSync(s.file, "utf8"));
    raw.entries.bad = { rows: [{ identifier: 3 }], hubError: null, savedAt: Date.now(), config: "c" };
    writeFileSync(s.file, JSON.stringify(raw));
    const reread = new SkillsHubCache(s.file);
    assert.equal(reread.peek("bad", "c"), null);
    assert.equal(reread.peek("", "c").rows.length, 2);
    writeFileSync(s.file, "{ not json");
    assert.equal(new SkillsHubCache(s.file).peek("", "c"), null);
  } finally { s.done(); }
});

test("the browse is kept past the search cap; the oldest searches go", async () => {
  const s = scratch();
  try {
    let now = 1_800_000_000_000;
    const cache = new SkillsHubCache(s.file, () => now);
    await cache.refresh("", "c", answer(ROWS));
    for (let i = 0; i < HUB_CACHE_MAX_ENTRIES + 3; i++) { now += 1000; await cache.refresh(`q${i}`, "c", answer(ROWS)); }
    const entries = Object.keys(JSON.parse(readFileSync(s.file, "utf8")).entries);
    assert.equal(entries.length, HUB_CACHE_MAX_ENTRIES);
    assert.ok(entries.includes(""));
    assert.ok(!entries.includes("q0") && entries.includes(`q${HUB_CACHE_MAX_ENTRIES + 2}`));
    cache.forget("");
    assert.equal(cache.peek("", "c"), null);
  } finally { s.done(); }
});

test("the config key follows skills.taps and skills.clawhub only", () => {
  const s = scratch();
  try {
    mkdirSync(s.dir, { recursive: true });
    const none = hubConfigKey(s.dir);
    const write = (cfg) => writeFileSync(join(s.dir, "config.json"), JSON.stringify(cfg));
    write({ skills: { taps: ["anthropics/skills"], clawhub: { enabled: true } }, llm: { a: 1 } });
    const one = hubConfigKey(s.dir);
    write({ skills: { taps: ["anthropics/skills"], clawhub: { enabled: true } }, llm: { a: 2 } });
    assert.equal(hubConfigKey(s.dir), one, "other keys do not matter");
    write({ skills: { taps: ["openai/skills"], clawhub: { enabled: true } } });
    assert.notEqual(hubConfigKey(s.dir), one);
    assert.notEqual(none, one);
    writeFileSync(join(s.dir, "config.json"), "{ half written");
    assert.equal(hubConfigKey(s.dir), none, "an unreadable config reads as the defaults");
  } finally { s.done(); }
});
