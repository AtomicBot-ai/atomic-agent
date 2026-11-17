// ATO-1466: Help › Report an Issue… — the pure half of renderer/bug-report.js
// (details, body, link, the over-long-link fallback), loaded as CommonJS.
// The log scrubbing itself is main/report-redact.ts scrubForIssue
// (report-redact.test.mjs); here the log arrives already scrubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/bug-report.js");

const ID = "11111111-2222-4333-8444-555555555555";
const FACTS = {
  version: "0.0.9", build: "abc1234", platform: "darwin", arch: "arm64",
  installChannel: "dmg", provider: "openrouter", model: "anthropic/claude-x",
  engine: "Atomic Core", binary: "/Users/alice/.atomic-agent/bin/atomic-agent", home: "/Users/alice",
  supportId: ID,
};

const decodedBody = (url) => new URL(url).searchParams.get("body");

test("the issue names version, OS, surface, channel, provider, model, engine and the support ID", () => {
  const plan = R.bugReportPlan({ text: "It froze.", facts: FACTS, includeId: true, includeLog: false });
  const body = decodedBody(plan.url);
  assert.equal(body, plan.body);
  assert.match(body, /^It froze\./);
  assert.match(body, /Atomic Agent 0\.0\.9 \(abc1234\) · darwin arm64/);
  assert.match(body, /Surface: desktop · installed via dmg/);
  assert.match(body, /Provider: openrouter · model anthropic\/claude-x/);
  assert.match(body, /Engine: Atomic Core/);
  assert.match(body, new RegExp(`Support ID: ${ID}`));
  // The binary path loses the home folder.
  assert.match(body, /Agent: ~\/\.atomic-agent\/bin\/atomic-agent/);
  assert.equal(body.includes("/Users/alice"), false);
  assert.equal(plan.clipboard, null);
  assert.equal(new URL(plan.url).searchParams.get("title"), "[desktop] ");
});

test("the support ID is left out when its switch is off (analytics off starts it off)", () => {
  const body = R.bugReportPlan({ text: "x", facts: FACTS, includeId: false, includeLog: false }).body;
  assert.equal(body.includes(ID), false);
  assert.equal(body.includes("Support ID"), false);
  // No id on the machine: nothing to include even with the switch on.
  const none = R.bugReportPlan({ text: "x", facts: { ...FACTS, supportId: null }, includeId: true, includeLog: false }).body;
  assert.equal(none.includes("Support ID"), false);
});

test("missing facts read as unknown instead of breaking the body", () => {
  const lines = R.bugReportDetailLines({}, true);
  assert.deepEqual(lines, [
    "Atomic Agent ? · ? ?",
    "Surface: desktop · installed via unknown",
    "Provider: none · model none",
    "Engine: unknown",
    "Agent: not started",
  ]);
});

test("the log tail goes in a collapsed block, and a ``` in it cannot end the fence", () => {
  const plan = R.bugReportPlan({ text: "x", facts: FACTS, includeId: true, includeLog: true, log: "line 1\n```\nline 3" });
  assert.match(plan.body, /<details><summary>Log tail/);
  assert.match(plan.body, /```text\nline 1\n` ` `\nline 3\n```/);
  const off = R.bugReportPlan({ text: "x", facts: FACTS, includeId: true, includeLog: false, log: "line 1" });
  assert.equal(off.body.includes("line 1"), false);
});

test("a link over ~8 KB moves the log to the clipboard and says to paste it", () => {
  const log = Array.from({ length: 200 }, (_, i) => `2026-11-12T10:00:${String(i % 60).padStart(2, "0")}Z INFO line ${i} ${"x".repeat(60)}`).join("\n");
  const plan = R.bugReportPlan({ text: "It froze.", facts: FACTS, includeId: true, includeLog: true, log });
  assert.ok(plan.url.length <= R.BUG_REPORT_URL_MAX, `url is ${plan.url.length}`);
  assert.ok(plan.clipboard && plan.clipboard.includes("line 199"));
  const body = decodedBody(plan.url);
  assert.equal(body.includes("line 199"), false);
  assert.ok(body.includes(R.BUG_REPORT_PASTE_NOTE));
  // The details stay in the link.
  assert.ok(body.includes(`Support ID: ${ID}`));
});

test("a text too long on its own is cut to fit, with a mark", () => {
  const plan = R.bugReportPlan({ text: "é".repeat(5000), facts: FACTS, includeId: true, includeLog: false });
  assert.ok(plan.url.length <= R.BUG_REPORT_URL_MAX, `url is ${plan.url.length}`);
  assert.match(plan.body, /cut to fit the link/);
  assert.ok(plan.body.includes("Engine: Atomic Core"));
});

test("bugReportScrubPath: this home and any other user's become ~", () => {
  assert.equal(R.bugReportScrubPath("/Users/bob/x", "/Users/alice"), "~/x");
  assert.equal(R.bugReportScrubPath("/home/eve/bin/a", ""), "~/bin/a");
  assert.equal(R.bugReportScrubPath("C:\\Users\\dan\\AppData\\a.exe", ""), "~\\AppData\\a.exe");
  assert.equal(R.bugReportScrubPath("/opt/atomic/agent", "/Users/alice"), "/opt/atomic/agent");
});
