// ATO-1111: main/agent-memory-sample.ts, against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/agent-memory-sample.js");

// The exact shape src/cli/serve-memory-guard.ts formatMemoryLine writes (its unit test pins the same line).
const LINE = "[atomic-agent] memory warn rss_mb=2048 heap_mb=1024 heap_limit_mb=4096 total_mb=16384";

test("serve's memory line parses to numbers", () => {
  assert.deepEqual(M.parseAgentMemoryLine(LINE), { verdict: "warn", rssMb: 2048, heapMb: 1024, heapLimitMb: 4096, totalMb: 16384 });
});

test("any other line is not a sample", () => {
  assert.equal(M.parseAgentMemoryLine("[atomic-agent] serve listening on http://127.0.0.1:1 (auth=bearer)"), null);
  assert.equal(M.parseAgentMemoryLine("[atomic-agent] memory guard: closing the agent cleanly"), null);
  assert.equal(M.parseAgentMemoryLine(""), null);
});

test("the tracker keeps the newest sample and forgets it when a new agent starts", () => {
  const t = new M.AgentMemoryTracker();
  assert.equal(t.latest(), null);
  t.observe(LINE);
  t.observe("some unrelated line");
  assert.equal(t.latest().rssMb, 2048);
  t.observe(LINE.replace("rss_mb=2048", "rss_mb=3000").replace("warn", "exit"));
  assert.equal(t.latest().rssMb, 3000);
  assert.equal(t.latest().verdict, "exit");
  t.reset();
  assert.equal(t.latest(), null);
});
