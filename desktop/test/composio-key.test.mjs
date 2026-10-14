// Unit tests for main/composio-key.ts (Settings › Connections › Composio),
// against the built output. Run: npm run build && npm run test:unit
//
// The key typed in the window is checked with Composio (the core's own
// tool-router session call), written to <stateDir>/.env as COMPOSIO_API_KEY,
// and the session it made is cached in config.json. Every effect is faked
// here: `fetch` is a stub, config writes are recorded, the state dir is a
// throwaway directory, and every key is a dummy. Nothing leaves the process.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const home = mkdtempSync(join(tmpdir(), "cmp-home-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
const require = createRequire(import.meta.url);
const K = require("../out/main/composio-key.js");
const cli = require("../out/main/agent-cli.js");

const dirs = [home];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "cmp-"));
  dirs.push(d);
  return d;
}
const KEY = "ak_dummy0123456789abcdef";
const posix = process.platform !== "win32";

/** A fetch that records each call and answers with `status` / `body`. */
function answering(status, body, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
const SESSION = { session_id: "trs_new", mcp: { url: "https://backend.composio.dev/tool_router/trs_new/mcp" }, tool_router_tools: ["COMPOSIO_SEARCH_TOOLS"] };

/** Deps over a real throwaway state dir, with the config faked in memory. */
function deps(over = {}) {
  const dir = over.stateDir ?? freshDir();
  const writes = [];
  const checks = [];
  const config = { enabled: true, apiKeyEnv: "COMPOSIO_API_KEY", userId: null, sessionId: "trs_old", mcpUrl: "https://old/mcp", ...(over.config ?? {}) };
  return {
    writes, checks, config,
    d: {
      stateDir: dir,
      env: over.env ?? {},
      dotenvSet: over.dotenvSet ?? cli.dotenvSet,
      readComposio: over.readComposio ?? (async () => ({ ok: true, value: { ...config } })),
      writeComposio: over.writeComposio ?? (async (patch) => { writes.push(patch); Object.assign(config, patch); return { ok: true }; }),
      check: over.check ?? (async (o) => { checks.push(o); return { ok: true, sessionId: "trs_new", mcpUrl: "https://new/mcp" }; }),
      mintId: () => "11111111-2222-4333-8444-555555555555",
    },
  };
}

/* ---------------- the check: the core's request, the core's verdicts ---------------- */

test("the check is the core's tool-router session call: same URL, header, body, workbench off", async () => {
  const calls = [];
  const res = await K.checkComposioKey({ apiKey: KEY, userId: "u-1", fetchImpl: answering(201, SESSION, calls) });
  assert.deepEqual(res, { ok: true, sessionId: "trs_new", mcpUrl: "https://backend.composio.dev/tool_router/trs_new/mcp" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://backend.composio.dev/api/v3.1/tool_router/session");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), { user_id: "u-1", workbench: { enable: false } });
});

test("401 and 403 are a refused key; other failures could not check it; the key is never in the text", async () => {
  for (const status of [401, 403]) {
    const res = await K.checkComposioKey({ apiKey: KEY, userId: "u", fetchImpl: answering(status, { error: "bad" }, []) });
    assert.deepEqual(res, { ok: false, rejected: true, status, error: `Composio rejected the API key (HTTP ${status}).` });
  }
  const five = await K.checkComposioKey({ apiKey: KEY, userId: "u", fetchImpl: answering(503, "{}", []) });
  assert.equal(five.ok, false); assert.equal(five.rejected, false); assert.match(five.error, /^Composio returned HTTP 503/);
  const down = await K.checkComposioKey({ apiKey: KEY, userId: "u", fetchImpl: async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND backend.composio.dev") }); } });
  assert.deepEqual(down, { ok: false, rejected: false, status: 0, error: "Could not reach Composio: getaddrinfo ENOTFOUND backend.composio.dev." });
  const noUrl = await K.checkComposioKey({ apiKey: KEY, userId: "u", fetchImpl: answering(200, { session_id: "trs_x" }, []) });
  assert.equal(noUrl.error, "Composio session response carried no mcp.url.");
  const noId = await K.checkComposioKey({ apiKey: KEY, userId: "u", fetchImpl: answering(200, { mcp: { url: "https://x" } }, []) });
  assert.equal(noId.error, "Composio session response carried no session_id.");
  for (const r of [five, down, noUrl, noId]) assert.ok(!JSON.stringify(r).includes(KEY));
});

test("a key outside letters, digits and _ - . : + / = is refused before anything happens", async () => {
  // Quotes, # and backslash would be quoted or escaped in .env in a way load-dotenv.ts does not undo.
  for (const bad of [KEY + "\nPATH=/tmp/evil", "two words here", "short", "", "k".repeat(513), KEY + "\u0000", "ключ-ключ-ключ",
    KEY + '"', KEY + "'", KEY + "#c", KEY + "\\", null, 42]) {
    assert.equal(K.composioKeyValueError(bad), "That does not look like a Composio API key.", JSON.stringify(bad));
    const { d, checks } = deps();
    const res = await K.saveComposioKey(d, bad);
    assert.equal(res.ok, false);
    assert.equal(checks.length, 0, "no call to Composio");
  }
  assert.equal(K.composioKeyValueError(KEY), null);
  assert.equal(K.composioKeyValueError("k".repeat(512)), null);
  assert.equal(K.composioKeyValueError("ak_AZaz09-._:+/="), null);
});

/* ---------------- save ---------------- */

test("save: checked, written to .env owner-only, the new session cached for the saved user id", { skip: !posix }, async () => {
  const { d, writes, checks } = deps({ config: { userId: "user-kept" } });
  writeFileSync(join(d.stateDir, ".env"), "# mine\nTELEGRAM_BOT_TOKEN=123:abc\n", { mode: 0o644 });
  const res = await K.saveComposioKey(d, KEY);
  assert.deepEqual(res, { ok: true, verified: true, shadowed: false });
  assert.deepEqual(checks, [{ apiKey: KEY, userId: "user-kept" }]);
  assert.equal(readFileSync(join(d.stateDir, ".env"), "utf8"), `# mine\nTELEGRAM_BOT_TOKEN=123:abc\nCOMPOSIO_API_KEY=${KEY}\n`);
  assert.equal(statSync(join(d.stateDir, ".env")).mode & 0o777, 0o600);
  assert.deepEqual(writes, [{ userId: "user-kept", sessionId: "trs_new", mcpUrl: "https://new/mcp" }]);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("save: no user id yet mints one and keeps it, as ensure-composio-session.ts does", async () => {
  const { d, writes, checks } = deps();
  const res = await K.saveComposioKey(d, KEY);
  assert.equal(res.ok, true);
  assert.equal(checks[0].userId, "11111111-2222-4333-8444-555555555555");
  assert.equal(writes[0].userId, "11111111-2222-4333-8444-555555555555");
});

test("save: a key Composio refuses is never written, and the old session stays", async () => {
  const { d, writes } = deps({ check: async () => ({ ok: false, rejected: true, status: 401, error: "Composio rejected the API key (HTTP 401)." }) });
  const res = await K.saveComposioKey(d, KEY);
  assert.deepEqual(res, { ok: false, verified: false, rejected: true, error: "Composio rejected the API key (HTTP 401).", shadowed: false });
  assert.deepEqual(cli.dotenvKeys(d.stateDir).keys, []);
  assert.deepEqual(writes, []);
});

test("save: Composio unreachable writes the key, drops the old session and says it was not checked", async () => {
  const { d, writes } = deps({ config: { userId: "u" }, check: async () => ({ ok: false, rejected: false, status: 0, error: "Could not reach Composio: offline." }) });
  const res = await K.saveComposioKey(d, KEY);
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(res.warning, "The key is saved, but it could not be checked. Could not reach Composio: offline.");
  assert.deepEqual(cli.dotenvKeys(d.stateDir).keys, ["COMPOSIO_API_KEY"]);
  // The cached session belonged to the old key (integrations-orchestrator.ts applyComposio).
  assert.deepEqual(writes, [{ userId: "u", sessionId: null, mcpUrl: null }]);
});

test("save: an unreadable config stops before Composio, so no second user id is minted", async () => {
  const { d, checks } = deps({ readComposio: async () => ({ ok: false, error: "config get failed" }) });
  const res = await K.saveComposioKey(d, KEY);
  assert.deepEqual(res, { ok: false, verified: false, error: "Could not read the settings: config get failed", shadowed: false });
  assert.equal(checks.length, 0);
});

test("save: a failed .env write is an error; a failed config write is a warning after the key is in", async () => {
  const a = deps({ dotenvSet: () => ({ ok: false, error: "EACCES" }) });
  const r1 = await K.saveComposioKey(a.d, KEY);
  assert.deepEqual(r1, { ok: false, verified: false, error: "Could not save the key: EACCES", shadowed: false });
  assert.deepEqual(a.writes, []);
  const b = deps({ writeComposio: async () => ({ ok: false, error: "locked" }) });
  const r2 = await K.saveComposioKey(b.d, KEY);
  assert.equal(r2.ok, true);
  assert.equal(r2.warning, "The key is saved, but the Composio settings could not be updated: locked");
});

test("save: a key in this app's environment is reported, and the typed key's session is not cached for it", async () => {
  const { d, writes } = deps({ config: { userId: "u" }, env: { COMPOSIO_API_KEY: "ak_env_dummy_0000" } });
  const res = await K.saveComposioKey(d, KEY);
  assert.equal(res.shadowed, true);
  assert.equal(res.verified, true);
  // The agent loads the environment's key; a session made with the typed one would not match it.
  assert.deepEqual(writes, [{ userId: "u", sessionId: null, mcpUrl: null }]);
});

/* ---------------- remove ---------------- */

test("remove: the key leaves .env, the session is forgotten, the user id stays", async () => {
  const { d, writes } = deps({ config: { userId: "u" } });
  writeFileSync(join(d.stateDir, ".env"), `A=1\nCOMPOSIO_API_KEY=${KEY}\n`);
  const res = await K.removeComposioKey(d);
  assert.deepEqual(res, { ok: true, verified: false, shadowed: false });
  assert.equal(readFileSync(join(d.stateDir, ".env"), "utf8"), "A=1\n");
  assert.deepEqual(writes, [{ sessionId: null, mcpUrl: null }]);
});

/* ---------------- check again ---------------- */

test("check again reads the key the agent would load, environment first, and caches the new session", async () => {
  const fromFile = deps({ config: { userId: "u" } });
  writeFileSync(join(fromFile.d.stateDir, ".env"), `COMPOSIO_API_KEY="${KEY}"\n`);
  const r1 = await K.checkSavedComposioKey(fromFile.d);
  assert.deepEqual(r1, { ok: true, verified: true, shadowed: false });
  assert.equal(fromFile.checks[0].apiKey, KEY, "the quotes are stripped as load-dotenv.ts does");
  assert.deepEqual(fromFile.writes, [{ userId: "u", sessionId: "trs_new", mcpUrl: "https://new/mcp" }]);

  const fromEnv = deps({ env: { COMPOSIO_API_KEY: " ak_env_dummy_0000 " } });
  writeFileSync(join(fromEnv.d.stateDir, ".env"), `COMPOSIO_API_KEY=${KEY}\n`);
  await K.checkSavedComposioKey(fromEnv.d);
  assert.equal(fromEnv.checks[0].apiKey, "ak_env_dummy_0000");

  const none = deps();
  const r3 = await K.checkSavedComposioKey(none.d);
  assert.deepEqual(r3, { ok: false, verified: false, error: "No Composio API key is saved.", shadowed: false });
  assert.equal(none.checks.length, 0);

  const refused = deps({ check: async () => ({ ok: false, rejected: true, status: 403, error: "Composio rejected the API key (HTTP 403)." }) });
  writeFileSync(join(refused.d.stateDir, ".env"), `COMPOSIO_API_KEY=${KEY}\n`);
  const r4 = await K.checkSavedComposioKey(refused.d);
  assert.equal(r4.rejected, true);
  assert.deepEqual(refused.writes, []);
});

test("readDotenvValue reads .env the way the agent does", () => {
  const dir = freshDir();
  assert.equal(K.readDotenvValue(dir, "COMPOSIO_API_KEY"), undefined, "no file");
  writeFileSync(join(dir, ".env"), "# COMPOSIO_API_KEY=commented\n  COMPOSIO_API_KEY = 'ak_one_two'  \nOTHER=x\n");
  assert.equal(K.readDotenvValue(dir, "COMPOSIO_API_KEY"), "ak_one_two");
  writeFileSync(join(dir, ".env"), "COMPOSIO_API_KEY=\n");
  assert.equal(K.readDotenvValue(dir, "COMPOSIO_API_KEY"), undefined, "empty is unset");
  writeFileSync(join(dir, ".env"), "COMPOSIO_API_KEY=ak_first_one\nCOMPOSIO_API_KEY=ak_second_one\n");
  assert.equal(K.readDotenvValue(dir, "COMPOSIO_API_KEY"), "ak_first_one", "the first non-empty line wins, as in load-dotenv.ts");
});

test("analytics: composio_setup carries a step and an outcome, never anything else; the pane is a settings pane", () => {
  const V = require("../out/main/analytics/validate.js");
  const ok = V.validateEvent("composio_setup", { step: "key_saved", result: "unverified" }, "main");
  assert.deepEqual({ ...ok.props }, { step: "key_saved", result: "unverified" });
  assert.equal("step" in V.validateEvent("composio_setup", { step: KEY, result: "ok" }, "main").props, false);
  assert.equal("key" in V.validateEvent("composio_setup", { step: "key_saved", result: "ok", key: KEY }, "main").props, false);
  assert.equal(V.validateEvent("settings_pane_viewed", { pane: "composio", ms_on_pane: 5 }, "ui").props.pane, "composio");
});
