// Unit tests for ATO-1639 (main/keychain-keys.ts, main/agent-cli.ts), against the built output.
// Run: npm run build && npm run test:unit
//
// With the agent's keys in the OS keychain (opt-in, `atag config secrets
// keychain`, ATO-474) the app saves and reads keys THROUGH THE AGENT, never
// in the keychain itself and never in config.json or .env. With the default
// .env store nothing changes. `atag` is a fake made here: it keeps the config
// in a throwaway state dir, answers `config secrets set|get|unset` the way
// the agent does (a JSON file stands in for the keychain, and
// secrets-store.json lists the names), and records each command line and
// stdin. Every key is a dummy.
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const posix = process.platform !== "win32";

const home = mkdtempSync(join(tmpdir(), "ato1639-home-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
const fakeDir = mkdtempSync(join(tmpdir(), "ato1639-atag-"));
const FAKE = join(fakeDir, "fake-atag.cjs");
writeFileSync(FAKE, `
const fs = require("fs");
const path = require("path");
const dir = process.env.ATOMIC_AGENT_STATE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const cfg = path.join(dir, "config.json");
const kcFile = path.join(dir, "fake-keychain.json");
const storeFile = path.join(dir, "secrets-store.json");
const sha = () => require("crypto").createHash("sha256").update(fs.existsSync(cfg) ? fs.readFileSync(cfg) : "").digest("hex");
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
if (args[0] === "config" && args[1] === "get" && args[2] === "--with-sha256") {
  const text = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "{}";
  process.stdout.write(JSON.stringify({ sha256: sha(), config: JSON.parse(text) }));
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set" && args[2] === "-") {
  if (args.length === 5 && args[4] !== sha()) { process.stderr.write("config changed since it was read\\n"); process.exit(3); }
  const text = fs.readFileSync(0, "utf8");
  fs.appendFileSync(path.join(dir, "stdin.log"), text + "\\n");
  fs.writeFileSync(cfg, text);
  process.exit(0);
}
if (args[0] === "config" && args[1] === "secrets") {
  if (process.env.FAKE_SECRETS_OLD === "1") { process.stderr.write("unknown secrets subcommand: " + args[2] + "\\n"); process.exit(1); }
  const name = args[3];
  const kc = readJson(kcFile, {});
  const store = readJson(storeFile, { store: "env", keychainKeys: [] });
  if (args[2] === "set") {
    const value = fs.readFileSync(0, "utf8").replace(/\\r?\\n$/, "");
    fs.appendFileSync(path.join(dir, "stdin.log"), value + "\\n");
    if (store.store === "keychain" && process.env.FAKE_KC_FAIL !== "1") {
      kc[name] = value;
      if (!store.keychainKeys.includes(name)) store.keychainKeys.push(name);
      fs.writeFileSync(kcFile, JSON.stringify(kc));
      fs.writeFileSync(storeFile, JSON.stringify(store));
      process.stdout.write(JSON.stringify({ name, store: "keychain" }) + "\\n");
    } else {
      fs.appendFileSync(path.join(dir, ".env"), name + "=" + value + "\\n");
      process.stdout.write(JSON.stringify({ name, store: "env" }) + "\\n");
    }
    process.exit(0);
  }
  if (args[2] === "get") {
    if (kc[name]) { process.stdout.write(kc[name] + "\\n"); process.exit(0); }
    process.stderr.write(name + " is not saved\\n"); process.exit(1);
  }
  if (args[2] === "unset") {
    delete kc[name];
    store.keychainKeys = store.keychainKeys.filter((k) => k !== name);
    fs.writeFileSync(kcFile, JSON.stringify(kc));
    fs.writeFileSync(storeFile, JSON.stringify(store));
    const env = path.join(dir, ".env");
    if (fs.existsSync(env)) fs.writeFileSync(env, fs.readFileSync(env, "utf8").split("\\n").filter((l) => !l.startsWith(name + "=")).join("\\n"));
    process.stdout.write("Removed " + name + "\\n");
    process.exit(0);
  }
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
const kk = require("../out/main/keychain-keys.js");

after(() => { for (const d of [home, fakeDir]) rmSync(d, { recursive: true, force: true }); });

const text = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const calls = () => text(join(home, "argv.log")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const keychain = () => (existsSync(join(home, "fake-keychain.json")) ? JSON.parse(text(join(home, "fake-keychain.json"))) : {});
const saved = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
const entryOf = (id) => (saved().llm?.providers ?? []).find((p) => p.id === id);
const LOCAL = { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" };

function stage({ store = "env", keychainKeys = [], providers = [LOCAL], kc = {} } = {}) {
  for (const f of ["argv.log", "stdin.log", ".env", "fake-keychain.json", "secrets-store.json"]) rmSync(join(home, f), { force: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, llm: { activeTextProvider: "local-llama", providers } }));
  if (store === "keychain" || keychainKeys.length) {
    writeFileSync(join(home, "secrets-store.json"), JSON.stringify({ store, keychainKeys }));
  }
  if (Object.keys(kc).length) writeFileSync(join(home, "fake-keychain.json"), JSON.stringify(kc));
  kk.clearKeychainValues();
}
beforeEach(() => stage());
afterEach(() => {
  delete process.env.FAKE_SECRETS_OLD;
  delete process.env.FAKE_KC_FAIL;
  cli.useSecretsRoute(null);
});

/* ---------------- the store file, names only ---------------- */

test("no secrets-store.json, or one that cannot be read, is the default .env store with nothing held", () => {
  assert.deepEqual(kk.readSecretsStore(home), { store: "env", keychainKeys: [] });
  writeFileSync(join(home, "secrets-store.json"), "{not json");
  assert.deepEqual(kk.readSecretsStore(home), { store: "env", keychainKeys: [] });
  assert.equal(kk.keychainStoreOn(home), false);
  assert.deepEqual(kk.keychainHeldNames(home), []);
});

test("keychain mode lists the names the agent holds; .env mode with leftover names loads none (as the agent's loader)", () => {
  writeFileSync(join(home, "secrets-store.json"), JSON.stringify({ store: "keychain", keychainKeys: ["OPENROUTER_API_KEY", "bad name", 3] }));
  assert.equal(kk.keychainStoreOn(home), true);
  assert.deepEqual(kk.keychainHeldNames(home), ["OPENROUTER_API_KEY"]);
  writeFileSync(join(home, "secrets-store.json"), JSON.stringify({ store: "env", keychainKeys: ["OPENROUTER_API_KEY"] }));
  assert.deepEqual(kk.keychainHeldNames(home), []);
});

test("a provider key gets a variable of its own, never a shared or well-known one", () => {
  assert.equal(kk.keychainProviderEnvVar({ id: "openrouter" }), "ATOMIC_AGENT_PROVIDER_OPENROUTER_API_KEY");
  assert.equal(kk.keychainProviderEnvVar({ id: "groq", apiKeyEnvVar: "GROQ_API_KEY" }), "ATOMIC_AGENT_PROVIDER_GROQ_API_KEY");
  assert.equal(kk.keychainProviderEnvVar({ id: "my-box.lan", apiKeyEnvVar: "OPENAI_API_KEY" }), "ATOMIC_AGENT_PROVIDER_MY_BOX_LAN_API_KEY");
  assert.equal(kk.keychainProviderEnvVar({ id: "x", apiKeyEnvVar: "ATOMIC_AGENT_PROVIDER_OLD_API_KEY" }), "ATOMIC_AGENT_PROVIDER_OLD_API_KEY", "a name saved this way is kept");
  assert.equal(kk.isKeychainSecretName(kk.keychainProviderEnvVar({ id: "---" })), true);
});

/* ---------------- saving through the agent ---------------- */

test("the running agent's route is used first; the value never reaches a command line", async () => {
  const seen = [];
  const deps = { cli: async () => { throw new Error("no CLI while the route answers"); }, route: async (n, v) => { seen.push([n, v]); return { ok: true, store: "keychain" }; } };
  assert.deepEqual(await kk.saveSecretThroughAgent(deps, "OPENROUTER_API_KEY", "sk-or-route-1"), { ok: true, store: "keychain" });
  assert.deepEqual(seen, [["OPENROUTER_API_KEY", "sk-or-route-1"]]);
  assert.equal(kk.cachedKeychainValue("OPENROUTER_API_KEY"), "sk-or-route-1");
});

test("without a route, `config secrets set NAME --json` with the value on stdin; null is `unset`", async () => {
  const seen = [];
  const deps = { cli: async (args, input) => { seen.push([args, input]); return { ok: true, stdout: args[2] === "set" ? '{"name":"X_API_KEY","store":"keychain"}\n' : "Removed X_API_KEY\n", stderr: "" }; }, route: null };
  assert.deepEqual(await kk.saveSecretThroughAgent(deps, "X_API_KEY", "v-1"), { ok: true, store: "keychain" });
  assert.deepEqual(seen[0], [["config", "secrets", "set", "X_API_KEY", "--json"], "v-1\n"]);
  assert.equal(seen[0][0].includes("v-1"), false);
  assert.deepEqual(await kk.saveSecretThroughAgent(deps, "X_API_KEY", null), { ok: true, store: "env" });
  assert.deepEqual(seen[1][0], ["config", "secrets", "unset", "X_API_KEY"]);
  assert.equal(kk.cachedKeychainValue("X_API_KEY"), undefined, "a removed key is forgotten");
});

test("an agent older than these commands is told apart, and nothing is sent for a bad name or value", async () => {
  const old = { cli: async () => ({ ok: false, stdout: "", stderr: "unknown secrets subcommand: set\n", error: "unknown secrets subcommand: set" }), route: null };
  assert.equal((await kk.saveSecretThroughAgent(old, "X_API_KEY", "v")).unsupported, true);
  let called = 0;
  const deps = { cli: async () => { called += 1; return { ok: true, stdout: "", stderr: "" }; }, route: null };
  for (const [name, value] of [["PATH", "/tmp"], ["NODE_OPTIONS", "x"], ["X_API_KEY", "a\nPATH=/tmp"], ["X_API_KEY", ""]]) {
    const res = await kk.saveSecretThroughAgent(deps, name, value);
    assert.equal(res.ok, false, name);
    assert.equal(res.unsupported, false, name);
  }
  assert.equal(called, 0);
});

test("a value is read with `config secrets get` only for a name the keychain holds, then kept for a minute", async () => {
  writeFileSync(join(home, "secrets-store.json"), JSON.stringify({ store: "keychain", keychainKeys: ["GEMINI_API_KEY"] }));
  let gets = 0;
  const deps = { cli: async (args) => { gets += 1; assert.deepEqual(args, ["config", "secrets", "get", "GEMINI_API_KEY"]); return { ok: true, stdout: "g-kc-1\n", stderr: "" }; } };
  assert.equal(await kk.readKeychainValue(deps, home, "GEMINI_API_KEY"), "g-kc-1");
  assert.equal(await kk.readKeychainValue(deps, home, "GEMINI_API_KEY"), "g-kc-1");
  assert.equal(gets, 1);
  assert.equal(await kk.readKeychainValue(deps, home, "OPENROUTER_API_KEY"), null);
  assert.equal(gets, 1, "a name the keychain does not hold is not asked for");
  assert.equal(kk.cachedKeychainValue("GEMINI_API_KEY", Date.now() + kk.KEYCHAIN_VALUE_TTL_MS + 1), undefined);
});

/* ---------------- agent-cli.ts ---------------- */

test("names held in the keychain count as saved keys: dotenvKeys, keyNamesAvailable, providerHasKey", () => {
  stage({ store: "keychain", keychainKeys: ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"] });
  writeFileSync(join(home, ".env"), "EXA_API_KEY=exa-1\n");
  assert.deepEqual(cli.dotenvKeys(home).keys, ["EXA_API_KEY", "TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"]);
  const names = cli.keyNamesAvailable();
  assert.equal(names.nonEmpty.has("OPENROUTER_API_KEY"), true);
  assert.equal(cli.providerHasKey({ id: "openrouter", kind: "openrouter" }, names), true);
  assert.equal(cli.keyHeldInKeychain({ id: "openrouter", kind: "openrouter" }), true);
});

test("the default .env store is untouched: no secrets-store.json, no extra names, no agent call", () => {
  writeFileSync(join(home, ".env"), "EXA_API_KEY=exa-1\n");
  assert.deepEqual(cli.dotenvKeys(home).keys, ["EXA_API_KEY"]);
  assert.equal(cli.keyHeldInKeychain({ id: "openrouter", kind: "openrouter" }), false);
  assert.deepEqual(calls(), []);
});

test("a key the keychain holds is read through the agent for the key check, and the sync lookup finds it afterwards", { skip: !posix }, async () => {
  stage({ store: "keychain", keychainKeys: ["OPENROUTER_API_KEY"], kc: { OPENROUTER_API_KEY: "sk-or-kc-1" } });
  const entry = { id: "openrouter", kind: "openrouter" };
  assert.equal(cli.resolveKeyValue(entry), null, "not read yet");
  assert.equal(await cli.resolveKeyValueAsync(entry), "sk-or-kc-1");
  assert.equal(cli.resolveKeyValue(entry), "sk-or-kc-1");
  assert.deepEqual(calls(), [["config", "secrets", "get", "OPENROUTER_API_KEY"]]);
});

test("keychain mode: a key typed in the window goes to the keychain and the entry names its variable", { skip: !posix }, async () => {
  stage({ store: "keychain" });
  const res = await cli.upsertProvider({ id: "openrouter", kind: "openrouter", apiKey: " sk-or-typed-0123456789 ", defaultChatModel: "m" });
  assert.equal(res.ok, true, res.error);
  const entry = entryOf("openrouter");
  assert.equal(entry.apiKey, undefined, "no key in config.json");
  assert.equal(entry.apiKeyEnvVar, "ATOMIC_AGENT_PROVIDER_OPENROUTER_API_KEY");
  assert.deepEqual(keychain(), { ATOMIC_AGENT_PROVIDER_OPENROUTER_API_KEY: "sk-or-typed-0123456789" });
  assert.equal(text(join(home, ".env")), "", "and none in .env");
  assert.equal(calls().some((a) => a.join(" ").includes("sk-or-typed")), false, "never on a command line");
  assert.equal(text(join(home, "config.json")).includes("sk-or-typed"), false);
});

test("keychain mode: re-saving a provider that had an inline key drops the inline key", { skip: !posix }, async () => {
  stage({ store: "keychain", providers: [LOCAL, { id: "aimlapi", kind: "aimlapi", apiKey: "old-inline-0123456789", defaultChatModel: "m" }] });
  const res = await cli.upsertProvider({ id: "aimlapi", kind: "aimlapi", apiKey: "new-typed-0123456789" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf("aimlapi").apiKey, undefined);
  assert.equal(entryOf("aimlapi").apiKeyEnvVar, "ATOMIC_AGENT_PROVIDER_AIMLAPI_API_KEY");
  assert.equal(text(join(home, "config.json")).includes("old-inline"), false);
});

test("the keychain refused (the agent fell back to .env): the key is taken back out of .env and stays inline, as before", { skip: !posix }, async () => {
  stage({ store: "keychain" });
  process.env.FAKE_KC_FAIL = "1";
  const res = await cli.upsertProvider({ id: "openrouter", kind: "openrouter", apiKey: "sk-or-fallback-0123456789" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf("openrouter").apiKey, "sk-or-fallback-0123456789");
  assert.equal(text(join(home, ".env")).includes("sk-or-fallback"), false);
});

test("an agent older than `config secrets set` keeps the old behaviour: the key inline", { skip: !posix }, async () => {
  stage({ store: "keychain" });
  process.env.FAKE_SECRETS_OLD = "1";
  const res = await cli.upsertProvider({ id: "openrouter", kind: "openrouter", apiKey: "sk-or-old-agent-0123456789" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf("openrouter").apiKey, "sk-or-old-agent-0123456789");
});

test("the default .env store saves the key inline exactly as before, with no secrets call", { skip: !posix }, async () => {
  const res = await cli.upsertProvider({ id: "openrouter", kind: "openrouter", apiKey: "sk-or-default-0123456789" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf("openrouter").apiKey, "sk-or-default-0123456789");
  assert.equal(calls().some((a) => a[1] === "secrets"), false);
});

test("bot tokens: keychain mode saves and removes through the agent; .env mode writes .env as before", { skip: !posix }, async () => {
  stage({ store: "keychain" });
  const set = await cli.desktopSecretSet(home, "TELEGRAM_BOT_TOKEN", "123:abc-kc");
  assert.equal(set.ok, true, set.error);
  assert.deepEqual(keychain(), { TELEGRAM_BOT_TOKEN: "123:abc-kc" });
  assert.equal(cli.dotenvKeys(home).keys.includes("TELEGRAM_BOT_TOKEN"), true);
  const cleared = await cli.desktopSecretSet(home, "TELEGRAM_BOT_TOKEN", null);
  assert.equal(cleared.ok, true);
  assert.deepEqual(keychain(), {});
  assert.equal(cli.dotenvKeys(home).keys.includes("TELEGRAM_BOT_TOKEN"), false);

  stage();
  const plain = await cli.desktopSecretSet(home, "TELEGRAM_BOT_TOKEN", "123:abc-env");
  assert.equal(plain.ok, true);
  assert.equal(text(join(home, ".env")), "TELEGRAM_BOT_TOKEN=123:abc-env\n");
  assert.deepEqual(calls(), []);
});

test("with `atag serve` up, a token goes through its route, not a process", { skip: !posix }, async () => {
  stage({ store: "keychain" });
  const seen = [];
  cli.useSecretsRoute(async (name, value) => { seen.push([name, value]); return { ok: true, store: "keychain" }; });
  const res = await cli.desktopSecretSet(home, "DISCORD_BOT_TOKEN", "discord-token-0123456789abcdef");
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [["DISCORD_BOT_TOKEN", "discord-token-0123456789abcdef"]]);
  assert.deepEqual(calls(), []);
});
