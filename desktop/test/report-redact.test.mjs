// Unit tests for main/report-redact.ts, against the built output.
// Run: npm run build && npm run test:unit
// "Save report for support" says the settings have keys, tokens and passwords
// taken out; the agent log's tail goes through the same scrubber.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { logTail, redactSecrets, scrubText } = require("../out/main/report-redact.js");

/** Every secret in `secrets` is gone from `text`. */
const noneLeft = (text, secrets) => {
  for (const s of secrets) assert.equal(text.includes(s), false, `${s} is still in: ${text}`);
};

/* ---------------------------------------------------------------- config */

test("a key in a URL's query goes, the rest of the URL stays", () => {
  const out = JSON.stringify(redactSecrets({
    mcp: { servers: [
      { name: "smithery", transport: { type: "http", url: "https://server.example/mcp?api_key=q-key-1&profile=work" } },
      { name: "plain", transport: { type: "sse", url: "https://mcp.example/sse?token=q-tok-2" } },
      { name: "gemini", transport: { type: "http", url: "https://g.example/v1?key=q-key-3&alt=sse" } },
    ] },
  }));
  noneLeft(out, ["q-key-1", "q-tok-2", "q-key-3"]);
  assert.match(out, /https:\/\/server\.example\/mcp\?api_key=<redacted 7 chars>&profile=work/);
  assert.match(out, /\?key=<redacted 7 chars>&alt=sse/);
});

test("a token in a URL's path goes", () => {
  const out = JSON.stringify(redactSecrets({
    hooks: { url: "https://hooks.example.com/services/T0001/B0002/a1B2c3D4e5F6g7H8i9J0k1L2m3" },
  }));
  noneLeft(out, ["a1B2c3D4e5F6g7H8i9J0k1L2m3"]);
  assert.match(out, /services\/T0001\/B0002\/<redacted 26 chars>/);
});

test("an Authorization header passed after --header (mcp-remote) goes, the flag stays", () => {
  const cfg = { mcp: { servers: [{ name: "remote", transport: { type: "stdio", command: "npx",
    args: ["-y", "mcp-remote", "https://remote.example/mcp", "--header", "Authorization: Bearer hdr-secret-1", "-H", "X-Api-Key: hdr-secret-2"] } }] } };
  const out = JSON.stringify(redactSecrets(cfg));
  noneLeft(out, ["hdr-secret-1", "hdr-secret-2"]);
  assert.ok(out.includes('"--header","Authorization: <redacted'), out);
  assert.ok(out.includes('"-H","X-Api-Key: <redacted'), out);
  assert.ok(out.includes('"https://remote.example/mcp"'), out);
});

test("keys named pass, pwd or password go", () => {
  const out = JSON.stringify(redactSecrets({
    mcp: { servers: [{ name: "db", transport: { type: "stdio", command: "db-mcp",
      env: { DB_PASS: "pw-1", MYSQL_PWD: "pw-2", PGPASSWORD: "pw-3", DB_HOST: "db.local" } } }] },
  }));
  noneLeft(out, ["pw-1", "pw-2", "pw-3"]);
  assert.ok(out.includes('"DB_HOST":"db.local"'), out);
});

test("what the report always took out still goes, and the rest is kept (release fix 49)", () => {
  const staged = {
    llm: { providers: [{ id: "p", apiKey: "sk-key-0", baseUrl: "https://u0:pass0@llm.example/v1" }] },
    mcp: { servers: [
      { name: "h", transport: { type: "http", url: "https://mcp.example/h", headers: { Authorization: "Bearer bearer-0" } } },
      { name: "s", transport: { type: "stdio", command: "npx", args: ["srv", "--api-key", "arg-0", "--token=flag-0", "--port", "8049"],
        env: { DATABASE_URL: "postgres://u0:db-0@db.example/x", PLAIN: "kept" } } },
    ] },
    telegram: { enabled: true, ownerUserId: 4949 },
  };
  const out = JSON.stringify(redactSecrets(staged));
  noneLeft(out, ["sk-key-0", "pass0", "bearer-0", "arg-0", "flag-0", "db-0"]);
  for (const kept of ['"--api-key"', '"--port","8049"', '"PLAIN":"kept"', '"ownerUserId":4949',
    '"url":"https://mcp.example/h"', "@llm.example/v1", "@db.example/x", '"enabled":true']) {
    assert.ok(out.includes(kept), `${kept} missing from ${out}`);
  }
});

/* ------------------------------------------------------------- log text */

test("key- and token-shaped strings go from a log line", () => {
  const secrets = [
    "sk-or-v1-0123456789abcdef0123",
    "sk-ant-api03-ABCDEFGHIJKLMNOPQRST",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
    "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "123456789:AAE1234567890abcdefghijklmnopqrstuv",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "AKIAABCDEFGHIJKLMNOP",
  ];
  const line = `[2026-10-02T07:15:29.123Z] WARN provider failed {"reason":"401 invalid key ${secrets[0]}","other":"${secrets[1]}"} `
    + `${secrets[2]} ${secrets[3]} ${secrets[4]} https://api.telegram.org/bot${secrets[5]}/getMe ${secrets[6]} ${secrets[7]}`;
  const out = scrubText(line);
  noneLeft(out, secrets);
  assert.ok(out.startsWith("[2026-10-02T07:15:29.123Z] WARN provider failed "), out);
  assert.ok(out.includes("https://api.telegram.org/bot<redacted"), out);
});

test("Authorization and Bearer values go, the scheme stays", () => {
  const out = scrubText([
    'headers {"authorization":"Bearer abcdefgh12345678"}',
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "curl -H 'Authorization: token tok-12345' https://x.example",
    "sent bearer ABCDEFGHIJ0123456789",
  ].join("\n"));
  noneLeft(out, ["abcdefgh12345678", "dXNlcjpwYXNzd29yZA==", "tok-12345", "ABCDEFGHIJ0123456789"]);
  assert.match(out, /"authorization":"Bearer <redacted 16 chars>/);
  assert.match(out, /Authorization: Basic <redacted/);
});

test("a secret flag's value goes from a command line, other flags keep theirs", () => {
  const out = scrubText("spawn atag serve --host 127.0.0.1 --port 51234 --api-key 0f1e2d3c4b5a --token=tok-9 --max-tokens 8192");
  noneLeft(out, ["0f1e2d3c4b5a", "tok-9"]);
  assert.ok(out.includes("--host 127.0.0.1 --port 51234 --api-key <redacted 12 chars> --token=<redacted 5 chars> --max-tokens 8192"), out);
});

test("a name=value or JSON pair whose name names a secret loses its value; counts keep theirs", () => {
  const out = scrubText([
    'OPENROUTER_API_KEY=or-secret-1 DB_PASS=hunter2 MYSQL_PWD="two words"',
    '{"apiKey":"json-secret-2","clientSecret":"json-secret-3","sessionToken":"json-secret-4","x-api-key":"json-secret-5"}',
    '{"promptTokens":12345,"maxTokens":8192,"tokenBudget":32000,"keyName":"tui.notify","token":null}',
  ].join("\n"));
  noneLeft(out, ["or-secret-1", "hunter2", "two words", "json-secret-2", "json-secret-3", "json-secret-4", "json-secret-5"]);
  for (const kept of ['"promptTokens":12345', '"maxTokens":8192', '"tokenBudget":32000', '"keyName":"tui.notify"', '"token":null']) {
    assert.ok(out.includes(kept), `${kept} missing from ${out}`);
  }
  assert.ok(out.includes('MYSQL_PWD="<redacted 9 chars>"'), out);
});

test("a URL's password, secret query values and token path segments go", () => {
  const out = scrubText("GET https://user:pa55@host.example/v1/models?api_key=k-1&page=2 and postgres://me:pw@db:5432/x");
  noneLeft(out, ["pa55", "k-1", ":pw@"]);
  assert.ok(out.includes("https://<redacted>@host.example/v1/models?api_key=<redacted 3 chars>&page=2"), out);
  assert.ok(out.includes("postgres://<redacted>@db:5432/x"), out);
});

test("an ordinary agent line is left exactly as it was", () => {
  const lines = [
    "[atomic-agent] serve listening on http://127.0.0.1:51234 (auth=bearer, cwd=/Users/me/project)",
    '[2026-10-02T07:15:29.123Z] INFO tool executed {"sessionId":"0b6f3c1e-5d2a-4f8e-9c3b-1a2b3c4d5e6f","tool":"os.fs.read","status":"ok","durationMs":12}',
    '[2026-10-02T07:15:30.000Z] WARN no-progress loop detected {"path":"/Users/me/project/src/index.ts","range":"1-40"}',
    "llama-server reachable http://127.0.0.1:19191 model unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
  ].join("\n");
  assert.equal(scrubText(lines), lines);
});

test("a pair never reaches past its line, or into an object or a list", () => {
  const text = 'asked for the password:\nnext line kept\n{"token":{"kind":"bot"},"secret":["a"]}\n--api-key\nkept-too';
  assert.equal(scrubText(text), text);
});

test("a very long line without a secret is scrubbed in one pass, not in quadratic time", () => {
  const long = "a-".repeat(150_000) + " " + "x.".repeat(150_000);
  const started = Date.now();
  assert.equal(scrubText(long), long);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

/* --------------------------------------------------------------- the tail */

test("the log's tail starts at a whole line", () => {
  assert.equal(logTail("short log\n", 400), "short log\n");
  // The last 30 characters begin inside the first line: that piece is dropped.
  const text = "first line with sk-cut-in-hal\nsecond line\nthird line\n";
  assert.equal(logTail(text, 30), "second line\nthird line\n");
  assert.equal(logTail("no line break at all", 5), "");
});
