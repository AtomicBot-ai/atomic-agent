// #902: on Windows `atag models search --refresh --json` printed DeepSeek's
// live list and then died in Node's exit (`Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`). The
// non-zero exit threw the list away, and a valid key read "Could not check
// this key with DeepSeek". `models search` prints its JSON only on its way to
// exit 0, so a whole, non-empty list on stdout is the answer.
// main against the built output (npm run build first).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const home = mkdtempSync(join(tmpdir(), "models-list-after-crash-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { withCliStandIn, providerModels, answeredBeforeCrash, modelsSearch, modelWindow } = require("../out/main/agent-cli.js");

const ASSERTION = "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\n";
const LIST = JSON.stringify([
  { provider: "deepseek", id: "deepseek-v4-flash" },
  { provider: "deepseek", id: "deepseek-v4-pro" },
], null, 2) + "\n";

const crashedAfterList = { ok: false, stdout: LIST, stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() };

test("a list printed before the agent died at exit is the answer", () => {
  const res = answeredBeforeCrash(crashedAfterList);
  assert.equal(res.ok, true);
  assert.equal(res.stdout, LIST);
});

test("a failure with no list on stdout stays a failure", () => {
  const refused = { ok: false, stdout: "", stderr: 'could not list models from "deepseek": http 401\n', exitCode: 1, error: 'could not list models from "deepseek": http 401' };
  assert.equal(answeredBeforeCrash(refused), refused);
  const empty = { ok: false, stdout: "[]\n", stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() };
  assert.equal(answeredBeforeCrash(empty).ok, false);
  const garbage = { ok: false, stdout: "not json", stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() };
  assert.equal(answeredBeforeCrash(garbage).ok, false);
});

test("DeepSeek's model step keeps the live list when the agent crashes after printing it", async () => {
  const calls = [];
  const standIn = async (args) => {
    calls.push(args);
    if (args[0] === "models" && args[1] === "search") return crashedAfterList;
    return { ok: false, stdout: "", stderr: "", error: "not this: " + args.slice(0, 2).join(" ") };
  };
  const res = await withCliStandIn(standIn, () => providerModels("deepseek", "openai-compatible"));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.models.map((m) => m.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.ok(calls[0].includes("--refresh"), "a kind with no bundled catalog asks live");
});

test("a refused key still reads as refused", async () => {
  const standIn = async () => ({ ok: false, stdout: "", stderr: 'could not list models from "deepseek": http 401\n', exitCode: 1, error: 'could not list models from "deepseek": http 401' });
  const res = await withCliStandIn(standIn, () => providerModels("deepseek", "openai-compatible"));
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

// ATO-1197: the same trick for the other two `models search` callers.
const WINDOW_LIST = JSON.stringify([
  { provider: "deepseek-w", id: "deepseek-v4-pro", contextWindow: 131072 },
]) + "\n";

test("the model search keeps a list printed before the agent died at exit", async () => {
  const standIn = async (args) => args[0] === "models" && args[1] === "search"
    ? crashedAfterList
    : { ok: false, stdout: "", stderr: "", error: "not this" };
  const res = await withCliStandIn(standIn, () => modelsSearch("deepseek", "deepseek"));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.models.map((m) => m.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("the model search still fails when nothing was printed", async () => {
  const standIn = async () => ({ ok: false, stdout: "", stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() });
  const res = await withCliStandIn(standIn, () => modelsSearch("deepseek", "deepseek"));
  assert.equal(res.ok, false);
});

test("the context window is read from a list printed before the agent died at exit", async () => {
  const standIn = async (args) => args[0] === "models" && args[1] === "search"
    ? { ok: false, stdout: WINDOW_LIST, stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() }
    : { ok: false, stdout: "", stderr: "", error: "not this" };
  const win = await withCliStandIn(standIn, () => modelWindow("deepseek-w", "openai-compatible", "deepseek-v4-pro"));
  assert.equal(win, 131072);
});

test("a context-window lookup that printed nothing stays unknown", async () => {
  const standIn = async () => ({ ok: false, stdout: "", stderr: ASSERTION, exitCode: 3, error: ASSERTION.trim() });
  // A provider id of its own: modelWindow memoises per (provider, model).
  const win = await withCliStandIn(standIn, () => modelWindow("deepseek-x", "openai-compatible", "deepseek-v4-pro"));
  assert.equal(win, null);
});
