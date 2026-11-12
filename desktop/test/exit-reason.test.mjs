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

// ATO-1111: the exit_status word, and the agent's last memory sample as buckets.
test("exit_status reads 0xC000009A and the memory guard's clean exit apart", () => {
  assert.equal(R.agentExitStatus(3221225626), "insufficient_resources");
  assert.equal(R.agentExitStatus(R.AGENT_MEMORY_GUARD_EXIT_CODE), "memory_guard");
  assert.equal(R.AGENT_MEMORY_GUARD_EXIT_CODE, 86, "must match src/cli/serve-memory-guard.ts MEMORY_GUARD_EXIT_CODE");
  assert.equal(R.agentExitStatus(1), null);
  assert.equal(R.agentExitStatus(undefined), null);
});

test("agent rss and shares are buckets, never the figures", () => {
  assert.equal(R.agentRssBucket(300), "lt_512m");
  assert.equal(R.agentRssBucket(1500), "lt_2g");
  assert.equal(R.agentRssBucket(5000), "lt_8g");
  assert.equal(R.agentRssBucket(9000), "gte_8g");
  assert.equal(R.agentRssBucket(null), null);
  assert.equal(R.shareBucket(3800, 4096), "gte_90");
  assert.equal(R.shareBucket(1024, 4096), "lt_50");
  assert.equal(R.shareBucket(100, 4096), "lt_25");
  assert.equal(R.shareBucket(1, 0), null);
  assert.equal(R.shareBucket(undefined, 4096), null);
});

// ATO-1285: most 0.0.7 exits were "other" / "none". More categories, and code/class/file words.
test("start-up failures seen in agent logs get their own categories", () => {
  const cases = [
    ["!Error: The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115", "native_module"],
    ["!Error: \\?\\C:\\x\\better_sqlite3.node is not a valid Win32 application.", "native_module"],
    ["!Error: EBUSY: resource busy or locked, rename 'state/config.json.tmp'", "file_locked"],
    ["!Error: ENOSPC: no space left on device, write", "disk_full"],
    ["!SyntaxError: Unexpected token } in JSON at position 120", "config_invalid"],
    ["!Error: getaddrinfo ENOTFOUND openrouter.ai", "network"],
    ["!Error [ERR_REQUIRE_ESM]: require() of ES Module not supported", "node_runtime"],
    ["!serve failed: TypeError: Cannot read properties of undefined (reading 'x')", "uncaught"],
  ];
  for (const [line, want] of cases) assert.equal(R.lastErrorCategory([line]), want, line);
  for (const c of cases.map((x) => x[1])) assert.ok(R.LAST_ERROR_CATEGORIES.includes(c));
});

test("a trace's frames do not hide the message above them; a bare trace is uncaught", () => {
  const trace = [
    "!Error: listen EADDRINUSE: address already in use 127.0.0.1:4317",
    "!    at Server.setupListenHandle [as _listen2] (node:net:1872:16)",
    "!    at listenInCluster (node:net:1920:12)",
  ];
  assert.equal(R.lastErrorCategory(trace), "port_in_use");
  assert.equal(R.lastErrorCategory(["!boom", "!    at run (/x/y/serve-command.js:162:7)"]), "uncaught");
});

test("error facts are code, class and our file only, never message text or folders", () => {
  const lines = [
    "!my private prompt about my bank account",
    "!TypeError: Cannot read properties of undefined (reading 'secretThing')",
    "!    at parse (/Users/jane/Secret Project/bank-export-parser.js:3:1)",
    "!    at loadConfig (/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent:88:13)",
    "!    at main (/Applications/Atomic Agent.app/Contents/Resources/agent/atomic-agent:162:7)",
    "!code: 'ERR_INVALID_ARG_TYPE' for EMPLOYEE EXAMPLE",
  ];
  const f = R.lastErrorFacts(lines);
  // The person's own file is skipped; the first frame in our bundle is named.
  assert.deepEqual(f, { err_code: "ERR_INVALID_ARG_TYPE", err_type: "TypeError", err_file: "atomic-agent:88" });
  const all = JSON.stringify(f);
  for (const leak of ["jane", "Secret", "bank", "secretThing", "Users", "EMPLOYEE", "EXAMPLE"]) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(R.lastErrorFacts([]), { err_code: null, err_type: null, err_file: null });
  // Every value fits the report's tag shape (sentry/scrub.ts safeTag).
  for (const v of Object.values(f)) assert.match(v, /^[\w.:-]{1,64}$/);
});

test("a frame's file is named only for our bundle, Node and packages; a person's own file never", () => {
  const file = (frame) => R.lastErrorFacts(["!Error: x", frame]).err_file;
  assert.equal(file("!    at run (/Users/jane/bank-export-parser.js:3:1)"), "outside_app");
  assert.equal(file("!    at C:\\Users\\jane\\my-skill\\index.mjs:9:2"), "outside_app");
  assert.equal(file("!    at x (C:\\Program Files\\Atomic Agent\\resources\\agent\\atomic-agent.exe:12:3)"), "atomic-agent.exe:12");
  assert.equal(file("!    at x (file:///tmp/build/cli.mjs:4410:9)"), "cli.mjs:4410");
  assert.equal(file("!    at Server.setupListenHandle [as _listen2] (node:net:1872:16)"), "node:net:1872");
  assert.equal(file("!    at open (/Users/jane/proj/node_modules/better-sqlite3/lib/database.js:65:9)"), "database.js:65");
  // Only a frame line is a frame: a message that says "at host:port" is not one.
  assert.equal(file("!connect ECONNREFUSED at 127.0.0.1:4317"), null);
  // The errno family is a fixed list.
  assert.equal(R.lastErrorFacts(["!EXAMPLE and EMPLOYEE are words"]).err_code, null);
  assert.equal(R.lastErrorFacts(["!getaddrinfo EAI_AGAIN api.example.com"]).err_code, "EAI_AGAIN");
});

test("lines written are a bucket; each category has plain words or none", () => {
  assert.equal(R.linesBucket(0), "0");
  assert.equal(R.linesBucket(3), "1_5");
  assert.equal(R.linesBucket(40), "6_50");
  assert.equal(R.linesBucket(400), "gt_50");
  assert.equal(R.linesBucket(null), null);
  for (const c of R.LAST_ERROR_CATEGORIES) {
    const s = R.lastErrorSentence(c);
    if (c === "none" || c === "other") assert.equal(s, null);
    else {
      assert.equal(typeof s, "string", c);
      assert.ok(!/\u2014/.test(s), "no em dash: " + c);
    }
  }
});
