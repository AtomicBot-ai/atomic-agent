// ATO-763: main/sentry/exit-reason.ts, against the built output (npm run build first).
// Every line here is made up; none comes from a real person's log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../out/main/sentry/exit-reason.js");

test("the agent's last error lines become one category from the closed list", () => {
  const cases = [
    ["!FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "oom"],
    ["!Error: listen EADDRINUSE: address already in use 127.0.0.1:4317", "port_in_use"],
    ["!telegram: 409 Conflict: terminated by other getUpdates request", "telegram_conflict"],
    ["!SqliteError: database disk image is malformed", "sqlite"],
    ["!Error: EACCES: permission denied, open 'state/config.json'", "permission"],
    ["!Error: ENOENT: no such file or directory, open 'state/skills/x/SKILL.md'", "missing_file"],
    ["!connect ECONNREFUSED 127.0.0.1:19091", "econnrefused"],
    ["!something went wrong in a way nobody listed", "other"],
  ];
  for (const [line, want] of cases) assert.equal(R.lastErrorCategory([line]), want, line);
  for (const c of cases.map((x) => x[1])) assert.ok(R.LAST_ERROR_CATEGORIES.includes(c));
});

test("nothing said is `none`; the newest telling line wins; only the last lines count", () => {
  assert.equal(R.lastErrorCategory([]), "none");
  assert.equal(R.lastErrorCategory(["   "]), "none");
  // The newest line that names a cause decides, even with an unclassified line after it.
  assert.equal(R.lastErrorCategory(["!connect ECONNREFUSED 127.0.0.1:1", "!listen EADDRINUSE", "!bye"]), "port_in_use");
  // An old cause scrolled out of the last LAST_LINES lines no longer counts.
  const old = ["!JavaScript heap out of memory", ...Array.from({ length: R.LAST_LINES }, () => "!plain warning")];
  assert.equal(R.lastErrorCategory(old), "other");
});

test("the answer is only ever a category word, never text from the lines", () => {
  const secret = "!my private prompt about my bank account";
  assert.equal(R.lastErrorCategory([secret]), "other");
});

test("uptime is a bucket", () => {
  assert.equal(R.uptimeBucket(500), "lt_10s");
  assert.equal(R.uptimeBucket(30_000), "lt_1m");
  assert.equal(R.uptimeBucket(5 * 60_000), "lt_10m");
  assert.equal(R.uptimeBucket(30 * 60_000), "lt_1h");
  assert.equal(R.uptimeBucket(2 * 3_600_000), "gte_1h");
  assert.equal(R.uptimeBucket(null), null);
  assert.equal(R.uptimeBucket(-1), null);
});

// ATO-424 / ATO-761: Sentry carried no memory figure, and Windows exit codes only as numbers.
test("free memory at the exit is a bucket, never the figure", () => {
  const MB = 1_048_576;
  assert.equal(R.freeMemoryBucket(100 * MB), "lt_512m");
  assert.equal(R.freeMemoryBucket(700 * MB), "lt_1g");
  assert.equal(R.freeMemoryBucket(1500 * MB), "lt_2g");
  assert.equal(R.freeMemoryBucket(3000 * MB), "lt_4g");
  assert.equal(R.freeMemoryBucket(8192 * MB), "gte_4g");
  assert.equal(R.freeMemoryBucket(null), null);
  assert.equal(R.freeMemoryBucket(-1), null);
});

test("the Windows status codes seen in Sentry get a word", () => {
  assert.equal(R.windowsExitStatus(3221225626), "insufficient_resources");
  assert.equal(R.windowsExitStatus(0xc0000017), "no_memory");
  assert.equal(R.windowsExitStatus(0xc00000fd), "stack_overflow");
  assert.equal(R.windowsExitStatus(1073807364), "killed_from_outside");
  assert.equal(R.windowsExitStatus(1), null);
  assert.equal(R.windowsExitStatus(null), null);
});
