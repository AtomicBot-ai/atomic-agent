// Unit tests for main/agent-output.ts, against the built output.
// Run: npm run build && npm run test:unit
// `atag serve`'s output is relayed as whole lines however the pipe cuts it,
// and each structured log line is labelled with its own level (ATO-121).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LineSplitter, agentLogTag, lineLevel, structuredLevel, worthQuoting } = require("../out/main/agent-output.js");

/** A splitter and the lines it let out. */
function splitter(maxLineChars) {
  const lines = [];
  const s = maxLineChars === undefined ? new LineSplitter((l) => lines.push(l)) : new LineSplitter((l) => lines.push(l), maxLineChars);
  return { s, lines };
}

test("a line cut across chunks comes out whole", () => {
  const { s, lines } = splitter();
  s.push(Buffer.from("[2026-10-02T07:15:29.123Z] WARN provider unrea"));
  s.push(Buffer.from("chable; parking the turn {\"causeCode\":\"ECONN"));
  assert.deepEqual(lines, []);
  s.push(Buffer.from("REFUSED\"}\nnext"));
  assert.deepEqual(lines, ['[2026-10-02T07:15:29.123Z] WARN provider unreachable; parking the turn {"causeCode":"ECONNREFUSED"}']);
  s.end();
  assert.deepEqual(lines.slice(1), ["next"]);
});

test("a character cut between chunks is not garbled", () => {
  const { s, lines } = splitter();
  const text = "файл «отчёт» 📄 готов\n";
  const bytes = Buffer.from(text, "utf8");
  // Cut inside the emoji's four bytes, and inside a two-byte Cyrillic letter.
  const emoji = bytes.indexOf(Buffer.from("📄", "utf8"));
  for (const [from, to] of [[0, 3], [3, emoji + 2], [emoji + 2, bytes.length]]) s.push(bytes.subarray(from, to));
  assert.deepEqual(lines, ["файл «отчёт» 📄 готов"]);
});

test("several lines in one chunk, CRLF endings and empty lines", () => {
  const { s, lines } = splitter();
  s.push(Buffer.from("one\r\ntwo\n\nthree\n"));
  assert.deepEqual(lines, ["one", "two", "", "three"]);
});

test("what is left when the stream closes is let out, an unfinished character included", () => {
  const { s, lines } = splitter();
  s.push(Buffer.from("serve failed: Error: boom"));
  s.end();
  assert.deepEqual(lines, ["serve failed: Error: boom"]);

  const cut = splitter();
  cut.s.push(Buffer.from("ok ", "utf8"));
  cut.s.push(Buffer.from("📄", "utf8").subarray(0, 2));
  cut.s.end();
  assert.equal(cut.lines.length, 1);
  assert.ok(cut.lines[0].startsWith("ok "));
});

test("a line with no end in sight is let out in pieces, not held without bound", () => {
  const { s, lines } = splitter(10);
  s.push(Buffer.from("x".repeat(25)));
  assert.deepEqual(lines, ["x".repeat(25)]);
  s.push(Buffer.from("tail\n"));
  assert.deepEqual(lines, ["x".repeat(25), "tail"]);
});

test("a structured line's level is read off its head, and nothing else is", () => {
  assert.equal(structuredLevel("[2026-10-02T07:15:29.123Z] INFO tool executed {\"tool\":\"os.fs.read\"}"), "info");
  assert.equal(structuredLevel("[2026-10-02T07:15:29.123Z] WARN provider unreachable; parking the turn"), "warn");
  assert.equal(structuredLevel("[2026-10-02T07:15:29.123Z] ERROR agent loop failed"), "error");
  assert.equal(structuredLevel("[2026-10-02T07:15:29.123Z] DEBUG prompt built"), "debug");
  assert.equal(structuredLevel("[atomic-agent] serve listening on http://127.0.0.1:1234 (auth=bearer, cwd=/x)"), null);
  assert.equal(structuredLevel("serve failed: Error: INFO is not a level here"), null);
  assert.equal(structuredLevel("    at Object.<anonymous> (/x/y.js:1:1)"), null);
  assert.equal(structuredLevel("[2026-10-02T07:15:29.123Z] NOTICE something"), null);
});

test("agent.log tags a line by its level; any other stderr line is ERR, stdout OUT", () => {
  assert.equal(agentLogTag("stderr", "info"), "INFO");
  assert.equal(agentLogTag("stderr", "warn"), "WARN");
  assert.equal(agentLogTag("stderr", "error"), "ERROR");
  assert.equal(agentLogTag("stderr", "debug"), "DEBUG");
  assert.equal(agentLogTag("stderr", null), "ERR");
  assert.equal(agentLogTag("stderr", undefined), "ERR");
  assert.equal(agentLogTag("stdout", undefined), "OUT");
});

test("the smoke's ring of last words keeps what went wrong, not routine INFO", () => {
  assert.equal(worthQuoting("info"), false);
  assert.equal(worthQuoting("debug"), false);
  assert.equal(worthQuoting("warn"), true);
  assert.equal(worthQuoting("error"), true);
  assert.equal(worthQuoting(undefined), true);
  assert.equal(worthQuoting(null), true);
});

test("ATO-121: serve's lifecycle lines and the desktop's own are INFO, a notice WARN, a failure and a stack still not INFO", () => {
  assert.equal(lineLevel("[2026-10-02T07:15:29.123Z] WARN provider unreachable"), "warn");
  assert.equal(lineLevel("[atomic-agent] serve listening on http://127.0.0.1:1234 (auth=bearer, cwd=/x)"), "info");
  assert.equal(lineLevel("[atomic-agent] SIGTERM received, closing"), "info");
  assert.equal(lineLevel("[atomic-agent] serve listening on http://127.0.0.1:1234 (auth=bearer, cwd=/Users/x/error-logs)"), "info");
  assert.equal(lineLevel("[desktop] local-llm: the local model server stopped — starting it again (auto-restart)"), "error");
  assert.equal(lineLevel("[atomic-agent] created default config at /x/config.json"), "info");
  assert.equal(lineLevel("[desktop] local-llm: the app is stopping the model server (route cloud)"), "info");
  assert.equal(lineLevel("[desktop] started the local model daemon (qwen)"), "info");
  assert.equal(lineLevel("[desktop] could not start the local model daemon (qwen): boom"), "error");
  assert.equal(lineLevel("[desktop] local-llm: the automatic restart failed: boom"), "error");
  assert.equal(lineLevel("[desktop] the agent (pid 7) did not close within 4 s of being stopped — ending it with SIGKILL"), "error");
  assert.equal(lineLevel('web.search: provider "exa" is configured but EXA_API_KEY is not set; running on the keyless tier'), "warn");
  assert.equal(lineLevel("(node:123) ExperimentalWarning: something"), "warn");
  assert.equal(lineLevel("serve failed: Error: boom"), null);
  assert.equal(lineLevel("    at Object.<anonymous> (/x/y.js:1:1)"), null);
  assert.equal(agentLogTag("stderr", lineLevel("[atomic-agent] SIGTERM received, closing")), "INFO");
  assert.equal(agentLogTag("stderr", lineLevel("serve failed: Error: boom")), "ERR");
});
