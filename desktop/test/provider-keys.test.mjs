// Unit tests for ATO-132 (main/agent-cli.ts), against the built output.
// Run: npm run build && npm run test:unit
//
// A provider key typed in the window stays in its entry in config.json (the
// decision after review: in .env it would reach every MCP server and shell
// job the agent starts). What changes around it, tested here:
//   - every whole-file config write reaches `atag config set` on stdin, never
//     as an argument, so the key is never on a command line;
//   - the key check sends a saved key only to that provider's own endpoint;
//   - the launch makes config.json and .env owner-only and removes the tmp
//     files a dead write left beside them.
// `atag` is a fake made here: a script that keeps the config in a throwaway
// state dir and records each command line and stdin. Every key is a dummy;
// `fetch` is replaced in the key check tests, so nothing leaves the machine.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const posix = process.platform !== "win32";

// The app's state dir and its agent, both throwaway: set before agent-cli loads.
const home = mkdtempSync(join(tmpdir(), "t44-unit-home-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
const fakeDir = mkdtempSync(join(tmpdir(), "t44-unit-atag-"));
const FAKE = join(fakeDir, "fake-atag.cjs");
writeFileSync(FAKE, `
const fs = require("fs");
const path = require("path");
const dir = process.env.ATOMIC_AGENT_STATE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const cfg = path.join(dir, "config.json");
if (args[0] === "config" && args[1] === "get" && args.length === 2) {
  process.stdout.write(fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "{}");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set" && args.length === 3 && args[2] === "-") {
  if (process.env.FAKE_ATAG_OLD === "1") {
    process.stderr.write("config set failed: no value given for -\\nusage: atomic-agent config set - <value>\\n");
    process.exit(1);
  }
  const text = fs.readFileSync(0, "utf8");
  JSON.parse(text);
  fs.appendFileSync(path.join(dir, "stdin.log"), text + "\\n");
  fs.writeFileSync(cfg, text);
  process.stdout.write("wrote " + cfg + "\\n");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set" && args.length >= 3 && args[2].startsWith("{")) {
  const text = args.slice(2).join(" ");
  JSON.parse(text);
  fs.writeFileSync(cfg, text);
  process.exit(0);
}
process.stderr.write("fake atag: not this: " + args.join(" ") + "\\n");
process.exit(2);
`);
const SHIM = join(fakeDir, "atag");
writeFileSync(SHIM, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(SHIM, 0o755);
process.env.ATOMIC_AGENT_BIN = SHIM;

const require = createRequire(import.meta.url);
const cli = require("../out/main/agent-cli.js");

const dirs = [home, fakeDir];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "t44-unit-"));
  dirs.push(d);
  return d;
}
const modeOf = (p) => statSync(p).mode & 0o777;
const text = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const argvLog = () => text(join(home, "argv.log"));
const LOCAL = { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" };

/** A fresh app config, as the fake agent will read it; the logs start empty. */
function stage(providers) {
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, llm: { activeTextProvider: "local-llama", providers } }));
  rmSync(join(home, "argv.log"), { force: true });
  rmSync(join(home, "stdin.log"), { force: true });
  delete process.env.FAKE_ATAG_OLD;
}
const saved = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
const entryOf = (id) => (saved().llm?.providers ?? []).find((p) => p.id === id);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.FAKE_ATAG_OLD; });

/* ---------------- no key on a command line ---------------- */

test("a whole-file config write reaches the agent on stdin: `config set -`, the file never an argument", { skip: !posix }, async () => {
  stage([LOCAL]);
  const cfg = saved();
  cfg.llm.providers.push({ id: "aimlapi", kind: "aimlapi", apiKey: "t44-k-stdin-0123456789", defaultChatModel: "m" });
  const res = await cli.configSetWhole(cfg);
  assert.equal(res.ok, true, res.error);
  const lines = argvLog().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [["config", "set", "-"]]);
  assert.equal(argvLog().includes("t44-k-stdin"), false);
  assert.equal(entryOf("aimlapi").apiKey, "t44-k-stdin-0123456789", "the key is saved inline, as the key field says");
  assert.equal(text(join(home, "stdin.log")).includes("t44-k-stdin-0123456789"), true);
});

test("a key typed in the window is saved inline, and neither the read nor the write puts it on a command line", { skip: !posix }, async () => {
  stage([LOCAL]);
  const res = await cli.upsertProvider({ id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: " t44-k-typed-0123456789\u200b " });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf("aimlapi").apiKey, "t44-k-typed-0123456789");
  assert.equal(argvLog().includes("t44-k-typed"), false);
  assert.deepEqual(argvLog().trim().split("\n").map((l) => JSON.parse(l)), [["config", "get"], ["config", "set", "-"]]);
});

test("a blank key field keeps the saved key and the variable the entry reads, whatever variable its row names", { skip: !posix }, async () => {
  stage([LOCAL, { id: "groq", kind: "openai-compatible", baseUrl: "https://g.invalid", apiKeyEnvVar: "GROQ_OWN_KEY", apiKey: "t44-k-kept-0123456789", defaultChatModel: "m" }]);
  const res = await cli.upsertProvider({ id: "groq", kind: "openai-compatible", baseUrl: "https://g.invalid", apiKeyEnvVar: "GROQ_API_KEY", defaultChatModel: "m2" });
  assert.equal(res.ok, true, res.error);
  const e = entryOf("groq");
  assert.equal(e.apiKeyEnvVar, "GROQ_OWN_KEY");
  assert.equal(e.apiKey, "t44-k-kept-0123456789");
  assert.equal(e.defaultChatModel, "m2");
});

test("the setup's rollback of a provider whose key was turned down takes the key out of config.json with it", { skip: !posix }, async () => {
  stage([LOCAL]);
  await cli.upsertProvider({ id: "aimlapi", kind: "aimlapi", apiKey: "t44-k-turned-down-0123" });
  assert.equal(text(join(home, "config.json")).includes("t44-k-turned-down"), true);
  const rm = await cli.removeProvider("aimlapi");
  assert.equal(rm.ok, true, rm.error);
  assert.equal(text(join(home, "config.json")).includes("t44-k-turned-down"), false);
  assert.equal(argvLog().includes("t44-k-turned-down"), false);
});

test("an agent too old for `config set -` never gets a key on its command line: the write is refused, a file with no key goes the old way", { skip: !posix }, async () => {
  stage([LOCAL]);
  process.env.FAKE_ATAG_OLD = "1";
  const withKey = saved();
  withKey.llm.providers.push({ id: "aimlapi", kind: "aimlapi", apiKey: "t44-k-old-agent-0123", defaultChatModel: "m" });
  const refused = await cli.configSetWhole(withKey);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, cli.AGENT_TOO_OLD_FOR_KEYS);
  assert.equal(argvLog().includes("t44-k-old-agent"), false);
  assert.equal(text(join(home, "config.json")).includes("t44-k-old-agent"), false, "nothing was written");
  const noKey = saved();
  noKey.tui = { onboarding: { introSeenAt: "2026-10-02T00:00:00.000Z" } };
  const written = await cli.configSetWhole(noKey);
  assert.equal(written.ok, true, written.error);
  assert.equal(saved().tui.onboarding.introSeenAt, "2026-10-02T00:00:00.000Z");
});

/* ---------------- the key check (N9) ---------------- */

/** A fetch that records where it was asked and with what key, and answers 200. */
function recording(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: (init && init.headers && (init.headers.authorization || init.headers.Authorization)) || null });
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("with no key typed, the check sends the saved key to the saved endpoint only — never to a URL the window names", { skip: !posix }, async () => {
  stage([LOCAL, { id: "custom-x", kind: "openai-compatible", baseUrl: "https://saved.invalid", apiKey: "t44-k-saved-0123456789", defaultChatModel: "m" }]);
  const calls = [];
  globalThis.fetch = recording(calls);
  const res = await cli.checkProviderKey({ id: "custom-x", kind: "openai-compatible", baseUrl: "https://elsewhere.invalid", apiKeyEnvVar: "HOME" }, "m");
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(calls, [{ url: "https://saved.invalid/v1/chat/completions", auth: "Bearer t44-k-saved-0123456789" }]);
});

test("with no key typed and nothing saved under that id, the check asks no one", { skip: !posix }, async () => {
  stage([LOCAL]);
  const calls = [];
  globalThis.fetch = recording(calls);
  const res = await cli.checkProviderKey({ id: "not-saved", kind: "openai-compatible", baseUrl: "https://elsewhere.invalid", apiKeyEnvVar: "HOME" }, "m");
  assert.equal(res.ok, false);
  assert.deepEqual(calls, []);
});

test("a key typed in the window is checked on the endpoint typed with it", async () => {
  const calls = [];
  globalThis.fetch = recording(calls);
  const res = await cli.checkProviderKey({ id: "custom-y", kind: "openai-compatible", baseUrl: "https://typed.invalid", apiKey: "t44-k-typed-check" }, "m");
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(calls, [{ url: "https://typed.invalid/v1/chat/completions", auth: "Bearer t44-k-typed-check" }]);
});

/* ---------------- the launch: modes and leftovers ---------------- */

test("at launch config.json and .env are made owner-only; a symlink is left alone", { skip: !posix }, () => {
  const dir = freshDir();
  writeFileSync(join(dir, "config.json"), "{}\n");
  writeFileSync(join(dir, ".env"), "A=1\n");
  chmodSync(join(dir, "config.json"), 0o644);
  chmodSync(join(dir, ".env"), 0o664);
  assert.deepEqual(cli.secureStateFiles(dir), ["config.json", ".env"]);
  assert.equal(modeOf(join(dir, "config.json")), 0o600);
  assert.equal(modeOf(join(dir, ".env")), 0o600);
  assert.deepEqual(cli.secureStateFiles(dir), [], "already owner-only: nothing to do");
  const linked = freshDir();
  const target = join(freshDir(), "elsewhere.json");
  writeFileSync(target, "{}\n");
  chmodSync(target, 0o644);
  symlinkSync(target, join(linked, "config.json"));
  assert.deepEqual(cli.secureStateFiles(linked), []);
  assert.equal(modeOf(target), 0o644);
  assert.equal(lstatSync(join(linked, "config.json")).isSymbolicLink(), true);
  assert.deepEqual(cli.secureStateFiles(dir, "win32"), []);
});

test("at launch the tmp files a dead config or .env write left are removed; a write on its way stays", () => {
  const dir = freshDir();
  const now = Date.now();
  const put = (name, ageMs) => {
    writeFileSync(join(dir, name), "{\"llm\":{\"providers\":[{\"apiKey\":\"t44-k-leftover\"}]}}", { mode: 0o644 });
    const t = (now - ageMs) / 1000;
    utimesSync(join(dir, name), t, t);
  };
  put("config.json.tmp-4242", 1000);          // its process is gone
  put(".env.tmp-4242", 1000);                 // the same
  put("config.json.tmp-7777", 1000);          // a write on its way: alive and fresh
  put("config.json.tmp-7777-ab12", 3600_000); // alive, but an hour old: a leftover
  put("notes.tmp-4242", 1000);                // not a config or .env tmp file
  mkdirSync(join(dir, ".env.tmp-4243"));      // not a file
  const alive = (pid) => pid === 7777;
  const removed = cli.removeStaleTmpFiles(dir, now, alive).sort();
  assert.deepEqual(removed, [".env.tmp-4242", "config.json.tmp-4242", "config.json.tmp-7777-ab12"]);
  assert.equal(existsSync(join(dir, "config.json.tmp-7777")), true);
  assert.equal(existsSync(join(dir, "notes.tmp-4242")), true);
  assert.equal(existsSync(join(dir, ".env.tmp-4243")), true);
  assert.deepEqual(cli.removeStaleTmpFiles(join(dir, "absent"), now, alive), []);
});
