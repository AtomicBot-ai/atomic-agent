// Unit tests for ATO-132 (main/provider-keys.ts and the key store in
// main/agent-cli.ts), against the built output.
// Run: npm run build && npm run test:unit
//
// A provider key typed in the window lives in <stateDir>/.env (0600) under a
// variable the entry names, never in config.json; keys saved there by earlier
// versions move at launch. Every key here is a dummy made up in this file, and
// every directory is a throwaway one: the config is a stand-in held in memory,
// so no `atag` runs and nothing outside the temp directories is read or written.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Anything that falls back to the desktop's own state dir lands in a throwaway one.
const home = mkdtempSync(join(tmpdir(), "t44-unit-home-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;

const require = createRequire(import.meta.url);
const K = require("../out/main/provider-keys.js");
const cli = require("../out/main/agent-cli.js");

const dirs = [home];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "t44-unit-"));
  dirs.push(d);
  return d;
}
const posix = process.platform !== "win32";
const modeOf = (p) => statSync(p).mode & 0o777;
const envText = (dir) => (existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : null);
const envMap = (dir) => K.parseDotenvAsAgent(envText(dir) ?? "");

/** A config held in memory, read and written as `atag config get` / `config set` would. */
function memStore(stateDir, config, env = {}) {
  const box = { current: JSON.parse(JSON.stringify(config)), fail: null, writes: 0, lastWritten: null };
  return {
    box,
    store: {
      stateDir,
      env,
      read: async () => ({ ok: true, config: JSON.parse(JSON.stringify(box.current)) }),
      write: async (cfg) => {
        if (box.fail) return { ok: false, stdout: "", stderr: "", error: box.fail };
        box.lastWritten = JSON.stringify(cfg);
        box.current = JSON.parse(box.lastWritten);
        box.writes += 1;
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  };
}
const providersOf = (box) => box.current.llm?.providers ?? [];
const entryOf = (box, id) => providersOf(box).find((p) => p.id === id);
const LOCAL = { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" };

/* ---------------- the pure half ---------------- */

test("every preset's own variable is the one named after its id, so a preset keeps the name its row shows", () => {
  // renderer.js KIND_ROWS + PRESETS: id → env.
  const rows = {
    openrouter: "OPENROUTER_API_KEY", aimlapi: "AIMLAPI_API_KEY", gemini: "GEMINI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY", groq: "GROQ_API_KEY", deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY",
    cerebras: "CEREBRAS_API_KEY", together: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY", xai: "XAI_API_KEY",
    moonshot: "MOONSHOT_API_KEY", perplexity: "PERPLEXITY_API_KEY", nous: "NOUS_API_KEY", novita: "NOVITA_API_KEY",
    "atomic-chat": "ATOMIC_CHAT_API_KEY", ollama: "OLLAMA_API_KEY", lmstudio: "LMSTUDIO_API_KEY",
  };
  for (const [id, env] of Object.entries(rows)) assert.equal(K.idKeyVar(id), env, id);
  assert.equal(K.idKeyVar("custom-api-example-com"), "CUSTOM_API_EXAMPLE_COM_API_KEY");
  assert.equal(K.idKeyVar("openrouter-2"), "OPENROUTER_2_API_KEY");
  assert.equal(K.idKeyVar("2x"), "PROVIDER_2X_API_KEY");
  assert.match(K.idKeyVar("-"), K.KEY_VAR);
});

test("which variables an entry's key is read from, as the agent reads them", () => {
  assert.deepEqual(K.keyVarsReadBy({ id: "a", kind: "aimlapi" }), ["AIMLAPI_API_KEY"]);
  assert.deepEqual(K.keyVarsReadBy({ id: "g", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY" }), ["GROQ_API_KEY"]);
  assert.deepEqual(K.keyVarsReadBy({ id: "c", kind: "openai-compatible" }), ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"]);
  // An entry holding its own key reads no variable at all.
  assert.deepEqual(K.keyVarsReadBy({ id: "a", kind: "aimlapi", apiKey: "t44-dummy" }), []);
  assert.deepEqual(K.keyVarsReadBy(LOCAL), []);
});

test(".env is read as load-dotenv.ts reads it", () => {
  const m = K.parseDotenvAsAgent([
    "# comment",
    "PLAIN=abc",
    "QUOTED=\"with space\"",
    "SINGLE='it\"s'",
    "EMPTY_FIRST=",
    "EMPTY_FIRST=later",
    "TWICE=first",
    "TWICE=second",
    "lower=nope",
    "export EXPORTED=nope",
    "  SPACED = padded  ",
    "EQ=a=b=c",
    "WIN=crlf\r",
  ].join("\n"));
  assert.equal(m.get("PLAIN"), "abc");
  assert.equal(m.get("QUOTED"), "with space");
  assert.equal(m.get("SINGLE"), "it\"s");
  assert.equal(m.get("EMPTY_FIRST"), "later", "an empty line is overwritten by a later value");
  assert.equal(m.get("TWICE"), "first", "a name keeps its first value");
  assert.equal(m.has("lower"), false);
  assert.equal(m.has("EXPORTED"), false);
  assert.equal(m.get("SPACED"), "padded");
  assert.equal(m.get("EQ"), "a=b=c");
  assert.equal(m.get("WIN"), "crlf");
});

test("whatever a key looks like, .env gives it back exactly as written", () => {
  const values = [
    "t44-plain-0123456789",
    "t44 with space",
    "t44#hash",
    "t44\"double",
    "t44'single",
    "t44\"both'kinds",
    "t44\\back\\slash",
    "\"t44-quoted\"",
    "'t44-single-quoted'",
    "t44=equals=",
    "t44-\u0441yrillic",
  ];
  for (const v of values) {
    const text = K.applyDotenvMutation("OTHER=1\n", "T44_KEY", v);
    assert.equal(K.parseDotenvAsAgent(text).get("T44_KEY"), v, JSON.stringify(v));
    assert.equal(K.parseDotenvAsAgent(text).get("OTHER"), "1");
  }
  // Removal of a name that is not there changes nothing; of the last one, empties the text.
  assert.equal(K.applyDotenvMutation("A=1\n", "B", null), null);
  assert.equal(K.applyDotenvMutation("A=1\n", "A", null), "");
});

test("the key the agent sends: its own, else its variable (authoritative), the environment over .env", () => {
  const dotenv = new Map([["AIMLAPI_API_KEY", "from-file"], ["MY_VAR", "mine"], ["OPENAI_API_KEY", "compat-file"]]);
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi", apiKey: "inline" }, {}, dotenv), "inline");
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi" }, {}, dotenv), "from-file");
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi" }, { AIMLAPI_API_KEY: "from-env" }, dotenv), "from-env");
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi" }, { AIMLAPI_API_KEY: "" }, dotenv), "from-file", "an empty variable is overwritten by .env");
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi", apiKeyEnvVar: "MY_VAR" }, {}, dotenv), "mine");
  assert.equal(K.agentKeyFor({ id: "a", kind: "aimlapi", apiKeyEnvVar: "MISSING_VAR" }, {}, dotenv), undefined, "no fallback past the entry's own variable");
  assert.equal(K.agentKeyFor({ id: "c", kind: "openai-compatible" }, {}, dotenv), "compat-file");
  assert.equal(K.agentKeyFor({ id: "c", kind: "openai-compatible" }, { OPENAI_COMPAT_API_KEY: "" }, new Map()), undefined, "a set-but-empty first link ends the chain");
  assert.equal(K.agentKeyFor(LOCAL, {}, dotenv), undefined);
});

test("a key goes under the entry's own name unless another provider reads it or the environment sets it otherwise", () => {
  const base = { id: "aimlapi", key: "t44-a", preferred: ["AIMLAPI_API_KEY"], others: [], env: {}, dotenv: new Map() };
  assert.equal(K.chooseKeyVar(base), "AIMLAPI_API_KEY");
  // Over its own name's old value: re-keying.
  assert.equal(K.chooseKeyVar({ ...base, dotenv: new Map([["AIMLAPI_API_KEY", "old"]]) }), "AIMLAPI_API_KEY");
  // Another provider reads AIMLAPI_API_KEY: a spare, so that provider keeps its key.
  assert.equal(K.chooseKeyVar({ ...base, others: [{ id: "aimlapi-2", kind: "aimlapi" }] }), "AIMLAPI_API_KEY_2");
  // The environment sets it to something else: the agent would send that, so a spare.
  assert.equal(K.chooseKeyVar({ ...base, env: { AIMLAPI_API_KEY: "shell-key" } }), "AIMLAPI_API_KEY_2");
  // ... to the same key: fine.
  assert.equal(K.chooseKeyVar({ ...base, env: { AIMLAPI_API_KEY: "t44-a" } }), "AIMLAPI_API_KEY");
  // A spare that already holds something else is not taken over.
  assert.equal(K.chooseKeyVar({ ...base, env: { AIMLAPI_API_KEY: "x" }, dotenv: new Map([["AIMLAPI_API_KEY_2", "someone"]]) }), "AIMLAPI_API_KEY_3");
  // A name given to another entry in the same write.
  assert.equal(K.chooseKeyVar({ ...base, taken: new Set(["AIMLAPI_API_KEY"]) }), "AIMLAPI_API_KEY_2");
  // A custom endpoint with no variable of its own gets the one named after it, not the shared OpenAI chain.
  assert.equal(K.chooseKeyVar({ ...base, id: "custom-x", preferred: [] }), "CUSTOM_X_API_KEY");
  // Names that are not names are skipped.
  assert.equal(K.chooseKeyVar({ ...base, preferred: ["lower_case", "", null] }), "AIMLAPI_API_KEY");
});

test("the launch plan: every inline key gets its own variable, and nobody's key changes", () => {
  const providers = [
    LOCAL,
    { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: "t44-k1", defaultChatModel: "m" },
    { id: "custom-x", kind: "openai-compatible", baseUrl: "https://x.invalid", apiKey: "t44-k2", defaultChatModel: "m" },
    // Two entries of one preset share a variable (the TUI saves them so); each held its own key.
    { id: "groq", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY", apiKey: "t44-k3", baseUrl: "https://g.invalid", defaultChatModel: "m" },
    { id: "groq-2", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY", apiKey: "t44-k4", baseUrl: "https://g.invalid", defaultChatModel: "m" },
    // Reads OPENROUTER_API_KEY from .env and holds no key: must keep reading it.
    { id: "openrouter", kind: "openrouter", defaultChatModel: "m" },
  ];
  const dotenv = new Map([["OPENROUTER_API_KEY", "t44-file"]]);
  const plan = K.planKeyMoves(providers, {}, dotenv);
  assert.deepEqual(plan.stuck, []);
  assert.deepEqual(plan.moves.map((m) => [m.id, m.name]), [
    ["aimlapi", "AIMLAPI_API_KEY"],
    ["custom-x", "CUSTOM_X_API_KEY"],
    ["groq", "GROQ_API_KEY"],
    ["groq-2", "GROQ_2_API_KEY"],
  ]);
  let text = "OPENROUTER_API_KEY=t44-file\n";
  for (const m of plan.moves) text = K.applyDotenvMutation(text, m.name, m.key);
  const afterProviders = providers.map((p, i) => {
    const m = plan.moves.find((x) => x.index === i);
    if (!m) return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKeyEnvVar: m.name };
  });
  assert.deepEqual(K.keyChanges(providers, afterProviders, {}, dotenv, K.parseDotenvAsAgent(text)), []);
  // ... and keyChanges does see a change.
  assert.deepEqual(K.keyChanges(providers, afterProviders, {}, dotenv, new Map()), ["aimlapi", "custom-x", "groq", "groq-2", "openrouter"]);
});

test("a line that might quote a key back has it redacted", () => {
  assert.equal(K.redactKeys("config set failed: t44-secret-value is bad", ["t44-secret-value"]), "config set failed: <key> is bad");
});

/* ---------------- the key store (agent-cli.ts) ---------------- */

test("a key typed in the window goes into .env (0600) under the entry's variable; config.json names it and holds no key", async () => {
  const dir = freshDir();
  const { box, store } = memStore(dir, { llm: { activeTextProvider: "local-llama", providers: [LOCAL] } });
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: " t44-k1\u200b " });
  assert.equal(res.ok, true, res.error);
  assert.equal(envMap(dir).get("AIMLAPI_API_KEY"), "t44-k1");
  if (posix) assert.equal(modeOf(join(dir, ".env")), 0o600);
  const e = entryOf(box, "aimlapi");
  assert.equal(e.apiKeyEnvVar, "AIMLAPI_API_KEY");
  assert.equal("apiKey" in e, false);
  assert.equal(box.lastWritten.includes("t44-k1"), false, "the config write never carries the key");
  assert.equal(K.agentKeyFor(e, {}, envMap(dir)), "t44-k1");
  // keyNamesAvailable reads the same .env: the provider has a usable key.
  assert.equal(cli.providerIsUsable(e, cli.keyNamesAvailable(dir, {})), true);
});

test("re-keying writes over the same variable and keeps the rest of .env", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "# mine\nTELEGRAM_BOT_TOKEN=t44-bot\n", { mode: 0o644 });
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL] } });
  await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: "t44-old" });
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: "t44-new" });
  assert.equal(res.ok, true, res.error);
  const text = envText(dir);
  assert.equal(envMap(dir).get("AIMLAPI_API_KEY"), "t44-new");
  assert.equal(text.includes("t44-old"), false);
  assert.ok(text.startsWith("# mine\nTELEGRAM_BOT_TOKEN=t44-bot\n"), text);
  if (posix) assert.equal(modeOf(join(dir, ".env")), 0o600);
  assert.equal(entryOf(box, "aimlapi").apiKeyEnvVar, "AIMLAPI_API_KEY");
});

test("a blank key field keeps the entry's own variable, whatever the row says", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "AIMLAPI_API_KEY_2=t44-moved\n");
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY_2", defaultChatModel: "m" }] } });
  const before = envText(dir);
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", defaultChatModel: "m2" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf(box, "aimlapi").apiKeyEnvVar, "AIMLAPI_API_KEY_2");
  assert.equal(entryOf(box, "aimlapi").defaultChatModel, "m2");
  assert.equal(envText(dir), before);
});

test("a model change keeps a key that is still inline (a launch that could not move it), and writes no .env", async () => {
  const dir = freshDir();
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-inline", defaultChatModel: "m" }] } });
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "", defaultChatModel: "m2" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf(box, "aimlapi").apiKey, "t44-inline");
  assert.equal(entryOf(box, "aimlapi").kind, "aimlapi");
  assert.equal(existsSync(join(dir, ".env")), false);
});

test("a key with a line break is refused before anything is written", async () => {
  const dir = freshDir();
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL] } });
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-a\nb" });
  assert.equal(res.ok, false);
  assert.equal(res.error, cli.API_KEY_CHAR_ERROR);
  assert.equal(box.writes, 0);
  assert.equal(existsSync(join(dir, ".env")), false);
});

test("when config.json cannot be written, .env is put back exactly as it was and the error says no key", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "OTHER=1\n");
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL] } });
  box.fail = "config set failed: t44-k9 rejected";
  const res = await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-k9" });
  assert.equal(res.ok, false);
  assert.equal(String(res.error).includes("t44-k9"), false, res.error);
  assert.equal(envText(dir), "OTHER=1\n");
  // No .env before: none after.
  const dir2 = freshDir();
  const two = memStore(dir2, { llm: { providers: [LOCAL] } });
  two.box.fail = "nope";
  await cli.upsertProviderIn(two.store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-k9" });
  assert.equal(existsSync(join(dir2, ".env")), false);
});

test("a key for a provider whose variable another provider reads goes under its own name, and the other keeps its key", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "GROQ_API_KEY=t44-shared\n");
  const groq = { id: "groq", kind: "openai-compatible", baseUrl: "https://g.invalid", apiKeyEnvVar: "GROQ_API_KEY", defaultChatModel: "m" };
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL, groq, { ...groq, id: "groq-2" }] } });
  const res = await cli.upsertProviderIn(store, { id: "groq-2", kind: "openai-compatible", baseUrl: "https://g.invalid", apiKeyEnvVar: "GROQ_API_KEY", apiKey: "t44-own" });
  assert.equal(res.ok, true, res.error);
  assert.equal(entryOf(box, "groq-2").apiKeyEnvVar, "GROQ_2_API_KEY");
  assert.equal(K.agentKeyFor(entryOf(box, "groq-2"), {}, envMap(dir)), "t44-own");
  assert.equal(K.agentKeyFor(entryOf(box, "groq"), {}, envMap(dir)), "t44-shared");
});

test("a key the environment would shadow goes under another name, so the key typed is the key sent", async () => {
  const dir = freshDir();
  const env = { OPENROUTER_API_KEY: "t44-shell" };
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL] } }, env);
  const res = await cli.upsertProviderIn(store, { id: "openrouter", kind: "openrouter", apiKeyEnvVar: "OPENROUTER_API_KEY", apiKey: "t44-typed" });
  assert.equal(res.ok, true, res.error);
  const e = entryOf(box, "openrouter");
  assert.notEqual(e.apiKeyEnvVar, "OPENROUTER_API_KEY");
  assert.equal(K.agentKeyFor(e, env, envMap(dir)), "t44-typed");
});

test("the setup's rollback of a provider it created takes the key it typed out of .env again", async () => {
  // No variable before: it goes.
  const dir = freshDir();
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL] } });
  await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-turned-down" });
  assert.equal(envMap(dir).get("AIMLAPI_API_KEY"), "t44-turned-down");
  const rm = await cli.removeProviderIn(store, "aimlapi");
  assert.equal(rm.ok, true);
  assert.equal(entryOf(box, "aimlapi"), undefined);
  assert.equal(envText(dir)?.includes("t44-turned-down") ?? false, false);
  // A value there before (say, imported from the terminal): it comes back.
  const dir2 = freshDir();
  writeFileSync(join(dir2, ".env"), "AIMLAPI_API_KEY=t44-imported\n");
  const two = memStore(dir2, { llm: { providers: [LOCAL] } });
  await cli.upsertProviderIn(two.store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-turned-down" });
  await cli.removeProviderIn(two.store, "aimlapi");
  assert.equal(envMap(dir2).get("AIMLAPI_API_KEY"), "t44-imported");
});

test("removing a provider that was already there leaves .env alone", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "AIMLAPI_API_KEY=t44-kept\n");
  const { store } = memStore(dir, { llm: { providers: [LOCAL, { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", defaultChatModel: "m" }] } });
  await cli.upsertProviderIn(store, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-rekeyed" });
  await cli.removeProviderIn(store, "aimlapi");
  assert.equal(envMap(dir).get("AIMLAPI_API_KEY"), "t44-rekeyed");
});

test("at launch, keys saved in config.json move to .env; every provider sends the key it sent before", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=t44-file\n", { mode: 0o644 });
  const legacy = [
    LOCAL,
    { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: "t44-k1", defaultChatModel: "m" },
    { id: "custom-x", kind: "openai-compatible", baseUrl: "https://x.invalid", apiKey: "t44-k2", defaultChatModel: "m" },
    { id: "groq", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY", apiKey: "t44-k3", baseUrl: "https://g.invalid", defaultChatModel: "m" },
    { id: "groq-2", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY", apiKey: "t44-k4", baseUrl: "https://g.invalid", defaultChatModel: "m" },
    { id: "bad", kind: "openai-compatible", baseUrl: "https://b.invalid", apiKey: "t44-\u0441", defaultChatModel: "m" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "m" },
  ];
  const { box, store } = memStore(dir, { llm: { activeTextProvider: "aimlapi", providers: legacy } });
  const sentBefore = Object.fromEntries(legacy.map((p) => [p.id, K.agentKeyFor(p, {}, envMap(dir))]));
  const r = await cli.moveProviderKeysIn(store);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.moved, ["aimlapi", "custom-x", "groq", "groq-2", "bad"]);
  assert.deepEqual(r.left, []);
  for (const p of providersOf(box)) assert.equal("apiKey" in p, false, p.id);
  for (const k of ["t44-k1", "t44-k2", "t44-k3", "t44-k4", "t44-\u0441"]) assert.equal(box.lastWritten.includes(k), false, k);
  const sentAfter = Object.fromEntries(providersOf(box).map((p) => [p.id, K.agentKeyFor(p, {}, envMap(dir))]));
  assert.deepEqual(sentAfter, sentBefore);
  if (posix) assert.equal(modeOf(join(dir, ".env")), 0o600);
  // Backlog 32's "Key invalid" still sees the moved bad key; the others count as keys.
  const names = cli.keyNamesAvailable(dir, {});
  assert.equal(cli.providerKeyInvalid(entryOf(box, "bad"), names), true);
  assert.equal(cli.providerIsUsable(entryOf(box, "bad"), names), false);
  for (const id of ["aimlapi", "custom-x", "groq", "groq-2", "openrouter"]) assert.equal(cli.providerIsUsable(entryOf(box, id), names), true, id);
  // Idempotent: a second launch has nothing to move and writes nothing.
  const writes = box.writes;
  const text = envText(dir);
  const again = await cli.moveProviderKeysIn(store);
  assert.deepEqual(again, { ok: true, moved: [], left: [] });
  assert.equal(box.writes, writes);
  assert.equal(envText(dir), text);
});

test("at launch, a config write that fails leaves config.json as it was and .env exactly as it was", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "OTHER=1\n");
  const { box, store } = memStore(dir, { llm: { providers: [LOCAL, { id: "aimlapi", kind: "aimlapi", apiKey: "t44-k7", defaultChatModel: "m" }] } });
  box.fail = "config set failed: t44-k7 echoed back";
  const r = await cli.moveProviderKeysIn(store);
  assert.equal(r.ok, false);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.left, ["aimlapi"]);
  assert.equal(String(r.error).includes("t44-k7"), false, r.error);
  assert.equal(entryOf(box, "aimlapi").apiKey, "t44-k7");
  assert.equal(envText(dir), "OTHER=1\n");
});

test("the launch's raw look: only a config that holds a key needs the move", () => {
  const dir = freshDir();
  assert.equal(cli.configHoldsProviderKeys(dir), false);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ llm: { providers: [LOCAL, { id: "a", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY" }] } }));
  assert.equal(cli.configHoldsProviderKeys(dir), false);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ llm: { providers: [{ id: "a", kind: "aimlapi", apiKey: "t44-k" }] } }));
  assert.equal(cli.configHoldsProviderKeys(dir), true);
  writeFileSync(join(dir, "config.json"), "{ not json");
  assert.equal(cli.configHoldsProviderKeys(dir), false);
});

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

test("the key names the window shows match the agent: an empty variable does not hide .env's value", () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".env"), "AIMLAPI_API_KEY=t44-file\nlower=x\nexport GEMINI_API_KEY=t44-x\n");
  const empty = cli.keyNamesAvailable(dir, { AIMLAPI_API_KEY: "" });
  assert.equal(empty.nonEmpty.has("AIMLAPI_API_KEY"), true);
  assert.equal(empty.nonEmpty.has("GEMINI_API_KEY"), false, "the agent skips an `export` line");
  assert.equal(empty.present.has("lower"), false);
  const set = cli.keyNamesAvailable(dir, { AIMLAPI_API_KEY: "t44-\u0441" });
  assert.equal(set.badChars.has("AIMLAPI_API_KEY"), true, "a value in the environment wins over .env");
});

test("the Telegram token writer still quotes for the loader, owner-only", () => {
  const dir = freshDir();
  const r = cli.dotenvSet(dir, "TELEGRAM_BOT_TOKEN", "desktop smoke:token #1");
  assert.equal(r.ok, true, r.error);
  assert.equal(envText(dir), "TELEGRAM_BOT_TOKEN=\"desktop smoke:token #1\"\n");
  if (posix) assert.equal(modeOf(join(dir, ".env")), 0o600);
  assert.equal(cli.dotenvSet(dir, "TELEGRAM_BOT_TOKEN", null).ok, true);
  assert.equal(existsSync(join(dir, ".env")), false);
});
