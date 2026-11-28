// ATO-2442: main/usage-report.ts (the checked query and the plain failure words for
// Settings › Usage), against the built output (npm run build first), and its wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const U = require("../out/main/usage-report.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the window may ask for 1 to 400 days or all, and a short model name", () => {
  assert.deepEqual(U.cleanUsageQuery({}), { days: 7, compare: null });
  assert.deepEqual(U.cleanUsageQuery({ days: 30, compare: " deepseek/deepseek-v4-flash " }), { days: 30, compare: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(U.cleanUsageQuery({ days: "all", compare: "" }), { days: "all", compare: null });
  for (const bad of [{ days: 0 }, { days: 401 }, { days: 2.5 }, { days: "30" }, { compare: 5 }, { compare: "a\nb" }, { compare: "x".repeat(201) }]) {
    assert.equal(U.cleanUsageQuery(bad), null, JSON.stringify(bad));
  }
});

test("the query string escapes the model name", () => {
  assert.equal(U.usageQueryString({ days: 7, compare: null }), "?days=7");
  assert.equal(U.usageQueryString({ days: "all", compare: "google/gemini flash" }), "?days=all&compare=google%2Fgemini+flash");
});

test("a failure is plain words, the raw text only behind Details", async () => {
  const ok = await U.usageCall(async () => ({ days: [] }));
  assert.deepEqual(ok, { ok: true, data: { days: [] } });
  const old = await U.usageCall(async () => { throw new Error("/api/usage?days=7 → HTTP 404"); });
  assert.equal(old.ok, false);
  assert.equal(old.unsupported, true);
  assert.match(old.error, /does not keep a usage report yet\. Update the agent/);
  assert.doesNotMatch(old.error, /HTTP|404|api/);
  assert.match(old.detail, /HTTP 404/);
  const down = await U.usageCall(async () => { throw new Error("fetch failed ECONNREFUSED 127.0.0.1"); });
  assert.equal(down.unsupported, false);
  assert.doesNotMatch(down.error, /ECONNREFUSED|127\.0\.0\.1/);
});

test("main, preload and the agent client wire usage:report", () => {
  const main = src("../main/main.ts");
  assert.match(main, /import \{ wireUsageIpc \} from "\.\/usage-ipc\.js";/);
  assert.match(main, /wireUsageIpc\(\{ client \}\);/);
  assert.match(src("../main/usage-ipc.ts"), /ipcMain\.handle\("usage:report"/);
  assert.match(src("../preload/preload.ts"), /usageReport: \(query[^)]*\) => ipcRenderer\.invoke\("usage:report", query\),/);
  assert.match(src("../main/agent-client.ts"), /usageReport = \(query: string\) => this\.json<unknown>\(`\/api\/usage\$\{query\}`\);/);
});
