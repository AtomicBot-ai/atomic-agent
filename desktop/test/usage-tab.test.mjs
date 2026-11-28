// ATO-2442: Settings › Usage (renderer/usage-tab.js) over the agent's usage report,
// with its loading, error and empty states, and its hooks in renderer.js and index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";

const require = createRequire(import.meta.url);

const asks = [];
let answer = null;
globalThis.BR = { usageReport: async (q) => { asks.push(q); return typeof answer === "function" ? answer(q) : answer; } };
globalThis.S = { settings: 0, settingsPane: "usage" };
globalThis.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
globalThis.ic = (n) => "<i:" + n + ">";
globalThis.segControl = (items, cur, pre) => items.map(([id, l]) => '<button class="' + (cur === id ? "on" : "") + '" data-act="' + pre + id + '">' + l + "</button>").join("");
// dashBar, dashLegend, DASH_W and DASH_H are not exported: run the file as the window does, as a plain script.
runInThisContext(readFileSync(new URL("../renderer/dashboard-templates.js", import.meta.url), "utf8"));
const U = require("../renderer/usage-tab.js");
const tick = () => new Promise((r) => setTimeout(r, 0));

const REPORT = {
  from: "2026-11-06", to: "2026-11-12", sessions: 3,
  total: { calls: 5, inputTokens: 3_000_000, outputTokens: 1_000_000, cachedTokens: 0, localTokens: 3_000_000, cloudTokens: 1_000_000, planTokens: 0, usd: 1.2, pricedCalls: 2, unpricedCalls: 0 },
  days: [
    { day: "2026-11-11", calls: 2, inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, localTokens: 0, cloudTokens: 1_000_000, planTokens: 0, usd: 1.2, pricedCalls: 2, unpricedCalls: 0, sessions: 1,
      models: [{ billing: "cloud", providerId: "openrouter", model: "gpt-x", calls: 2, inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, localTokens: 0, cloudTokens: 1_000_000, planTokens: 0, usd: 1.2, pricedCalls: 2, unpricedCalls: 0 }] },
    { day: "2026-11-12", calls: 3, inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 0, localTokens: 3_000_000, cloudTokens: 0, planTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0, sessions: 2,
      models: [{ billing: "local", providerId: "local", model: "qwen3-8b", calls: 3, inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 0, localTokens: 3_000_000, cloudTokens: 0, planTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0 }] },
  ],
  savedByLocal: { status: "estimate", estimate: true, usd: 0.9, localInputTokens: 2_000_000, localOutputTokens: 1_000_000, localCachedTokens: 0,
    reference: { provider: "deepseek", model: "deepseek-v4-flash", source: "default", inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  tools: [{ tool: "fs.read", calls: 4, errors: 1, share: 0.8 }, { tool: "shell.run", calls: 1, errors: 0, share: 0.2 }],
  projects: [{ label: "app", calls: 5, inputTokens: 3_000_000, outputTokens: 1_000_000, localTokens: 3_000_000, cloudTokens: 1_000_000, planTokens: 0, usd: 1.2, pricedCalls: 2, unpricedCalls: 0 }],
  breakdownCountedFrom: "2026-11-12",
};

test("numbers read the way the terminal prints them", () => {
  assert.equal(U.usTok(1234), "1.2k");
  assert.equal(U.usTok(3_000_000), "3.0M");
  assert.equal(U.usUsd(0.9), "$0.90");
  assert.equal(U.usUsd(0.003), "$0.003");
  assert.equal(U.usCost({ pricedCalls: 1, unpricedCalls: 1, usd: 2 }), "$2.00+");
  assert.equal(U.usCost({ pricedCalls: 0, unpricedCalls: 1, usd: 0 }), "n/a");
  assert.equal(U.usParseDays("all"), "all");
  assert.equal(U.usParseDays("13"), null);
});

test("models are summed over the window, most tokens first; the chart has one series per kind used", () => {
  const m = U.usModels(REPORT.days);
  assert.deepEqual(m.map((x) => x.model), ["qwen3-8b", "gpt-x"]);
  const spec = U.usChartSpec(REPORT.days);
  assert.deepEqual(spec.labels, ["11-11", "11-12"]);
  assert.deepEqual(spec.series.map((s) => s.name), ["Local", "Cloud"]);
  assert.equal(U.usChartSpec([]), null);
});

test("saved by local is labelled an estimate, and unknown rather than $0 with no price", () => {
  const e = U.usSavedText(REPORT.savedByLocal);
  assert.equal(e.value, "About $0.90");
  assert.match(e.note, /^Estimate: the 3\.0M local tokens at deepseek\/deepseek-v4-flash list prices/);
  assert.deepEqual(U.usSavedText({ status: "unknown", requested: "x/y" }), { value: "Unknown", note: "The built-in price list has no price for x/y." });
  assert.equal(U.usSavedText({ status: "none" }).value, "-");
});

test("loading, then the report: cards, chart, tables by day, model, tool and project", async () => {
  answer = { ok: true, data: REPORT };
  U.US.data = null;
  U.usageTabEntered();
  assert.match(U.usageTab(), /reading usage/);
  await tick(); await tick();
  assert.deepEqual(asks.at(-1), { days: 7, compare: null });
  const html = U.usageTab();
  assert.doesNotMatch(html, /reading usage/);
  for (const t of ["Tokens", "Local share", "Cloud cost", "Saved by local", "Chats", "About $0.90", "fs.read", "shell.run", "openrouter/gpt-x", "local/qwen3-8b (local)", ">app<"]) {
    assert.ok(html.includes(t), t);
  }
  assert.match(html, /<svg class="us-chart" viewBox="0 0 720 340"/);
  assert.match(html, /<rect /);
  assert.match(html, /data-act="usage:days:30"/);
  assert.match(html, /Tools and projects are counted from 2026-11-12/);
  assert.ok(html.indexOf("2026-11-12") < html.indexOf("2026-11-11"), "newest day first in the table");
});

test("an error shows plain words, Try again, and the raw text only under Details", async () => {
  answer = { ok: false, error: "Could not read usage from the agent. It may still be starting; try again in a moment.", detail: "/api/usage → HTTP 500" };
  U.US.data = null;
  U.usageAct("refresh");
  await tick(); await tick();
  const html = U.usageTab();
  assert.match(html, /Could not read usage from the agent/);
  assert.match(html, /data-act="usage:refresh">Try again</);
  assert.match(html, /<details class="us-details"><summary>Details<\/summary><pre>\/api\/usage → HTTP 500<\/pre>/);
  assert.doesNotMatch(html, /reading usage/);
});

test("an empty period says so and points at All; a period switch asks again", async () => {
  answer = () => ({ ok: true, data: { ...REPORT, days: [], tools: [], projects: [], savedByLocal: { status: "none" } } });
  U.usageAct("days:30");
  await tick(); await tick();
  assert.equal(asks.at(-1).days, 30);
  assert.match(U.usageTab(), /No usage yet[\s\S]*No model calls in the last 30 days\. Pick All/);
  U.usageAct("days:all");
  await tick(); await tick();
  assert.equal(asks.at(-1).days, "all");
  assert.match(U.usageTab(), /No model calls are recorded yet/);
});

test("an older answer that lands late does not replace a newer one", async () => {
  let release;
  answer = () => new Promise((r) => { release = r; });
  U.usageAct("days:7");
  const first = release;
  answer = { ok: true, data: REPORT };
  U.usageAct("refresh");
  await tick(); await tick();
  first({ ok: true, data: { ...REPORT, days: [] } });
  await tick();
  assert.match(U.usageTab(), /fs\.read/);
});

test("renderer.js has the Settings section and routes the verbs; index.html loads the tab and its styles", () => {
  const r = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(r, /\['usage','Usage','barchart',\['usage'\]\],/);
  assert.match(r, /SETTINGS_TABS\.splice\(SETTINGS_TABS\.findIndex\(\(t\) => t\[0\] === 'llm'\) \+ 1, 0, \['usage','Usage'\]\);/);
  assert.match(r, /P\.barchart = '/);
  assert.match(r, /else if \(pane === 'usage'\) usageTabEntered\(\);/);
  assert.match(r, /if \(p === 'usage'\) return usageTab\(\);/);
  assert.match(r, /if \(k === 'usage'\) \{ close\(\); usageAct\(a\.slice\(6\)\); return; \}/);
  const idx = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(idx.includes('<link rel="stylesheet" href="css/usage.css">'));
  assert.ok(idx.indexOf('<script src="usage-tab.js"></script>') < idx.indexOf('<script src="renderer.js"></script>'));
});
