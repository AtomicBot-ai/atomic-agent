// ATO-1207: a turn on a local model whose context filled up read "Couldn't get
// a reply from Local models." An older bundled agent gives no code for it, only
// words: llama.cpp's 'llama-server returned http 400: the request exceeds the
// available context size, try increasing it', its `exceed_context_size_error`
// type, or the agent's own "The conversation no longer fits this model's
// context window …" once compacting did not help. On a local provider the row
// now says the context is full, with the agent's words under Details. A cloud
// provider's 400 and an unrelated local error read as before; a frame's code
// wins over the words; a 404/405 is still the wrong server.
// The renderer as text in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) return "";
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const NAMES = [
  "providerHost", "providerFailure", "providerReplied", "turnWaited", "turnFailure",
  "turnFailureLine", "localWrongServerLine", "localContextFullLine", "localServerHost", "waitIsLocalServer",
  "selProviders", "selActiveProviderId", "llmBlock", "llmProviders", "llmProvider", "llmLocalModels",
];

function window(config) {
  const c = vm.createContext({
    LIVE_CONFIG: config, S: { turnStartedAt: 0 }, SWX: {}, URL,
    esc: (s) => String(s), providerWord: (id) => (id === "openrouter" ? "OpenRouter" : String(id)),
    savedKeyInvalid: () => false, billingFailureLine: () => "",
  });
  for (const n of NAMES) { const src = fn(n); if (src) vm.runInContext(src, c); }
  return (ev) => c.turnFailure(ev);
}

const PHRASE = "The conversation no longer fits in the local model's context window."
  + " Compact this chat or start a new one, or give the model a larger context size.";

const external = (url, active = "local-llama") => ({
  localModels: { mode: "external", url },
  llm: { activeTextProvider: active, providers: [
    { id: "local-llama", kind: "llama-server", url, baseUrl: "http://127.0.0.1:19092" },
    { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ] },
});

const LLAMA_400 = "llama-server returned http 400: the request exceeds the available context size, try increasing it";
const LLAMA_TYPED = 'llama-server returned http 400: {"error":{"code":400,"type":"exceed_context_size_error","n_prompt_tokens":5369,"n_ctx":4096}}';
const AGENT_GAVE_UP = "The conversation no longer fits this model's context window (4,096 tokens), even after compacting it.";

test("a local model's context overflow reads as the context being full, the agent's words under Details", () => {
  const managed = window({ localModels: { mode: "managed", managed: { port: 19091 } } });
  const ext = window(external("http://127.0.0.1:8090"));
  for (const row of [managed, ext]) {
    for (const said of [LLAMA_400, LLAMA_TYPED]) {
      const r = row({ kind: "error", category: "transport", error: said });
      assert.equal(r.text, PHRASE);
      assert.equal(r.detail, said);
    }
    const r = row({ kind: "error", category: "model", error: AGENT_GAVE_UP });
    assert.equal(r.text, PHRASE);
    assert.equal(r.detail, AGENT_GAVE_UP);
  }
});

test("the same words on a cloud provider still read as no reply from it", () => {
  const row = window(external("http://127.0.0.1:8090", "openrouter"));
  const said = '"openrouter" answered 400 (bad request): the request exceeds the available context size';
  const r = row({ kind: "error", category: "transport", error: said });
  assert.equal(r.text, "Couldn't get a reply from OpenRouter.");
  assert.equal(r.detail, said);
});

test("an unrelated local error, or one that only mentions the context window, is not called a full context", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const invalid = "llama-server returned http 400: tools are not supported by this model";
  assert.equal(row({ kind: "error", category: "transport", error: invalid }).text, "Couldn't get a reply from local-llama.");
  const cut = "The model's reply was cut off by the 8192-token reply cap (localModels.completionMaxTokens) or the model server's context window.";
  assert.equal(row({ kind: "error", category: "model", error: cut }).text, "The model didn't give a usable answer.");
});

test("the frame's code wins over the words", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const other = row({ kind: "error", category: "transport", error: LLAMA_400, payload: { code: "local_request_invalid" } });
  assert.notEqual(other.text, PHRASE);
  const marked = row({ kind: "error", category: "transport", error: "llama-server returned http 400", payload: { code: "local_context_exceeded" } });
  assert.equal(marked.text, PHRASE);
});

test("a 404 or 405 is still the wrong server, even with context words in it", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const r = row({ kind: "error", category: "transport", error: "llama-server returned http 404: exceeds the available context size" });
  assert.match(r.text, /^The server at 127\.0\.0\.1:8090 is not a model server/);
});
