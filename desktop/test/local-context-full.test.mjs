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
  "turnFailureLine", "localWrongServerLine", "localContextFullLine", "localRequestInvalidLine", "localFailureCode", "localFrameAdvice", "localServerHost", "waitIsLocalServer",
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

// ATO-1206: the agent's code and advice for a local 400 are the row's words.
const INVALID = "The local model server turned the request down as invalid."
  + " The model or the server may not support something the agent sent, such as tools or images."
  + " Try another model, or update the server.";

test("a local request the server would not take reads as the agent's advice, raw words under Details", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const said = "llama-server returned http 400: tools are not supported by this model";
  const advice = "The local model server turned the request down as invalid. Try another model, or update the server.";
  const r = row({ kind: "error", category: "transport", error: said, payload: { code: "local_request_invalid", advice } });
  assert.equal(r.text, advice);
  assert.equal(r.detail, said);
  // A frame with no advice still gets the agent's sentence for that code.
  const bare = row({ kind: "error", category: "transport", error: said, payload: { code: "local_request_invalid" } });
  assert.equal(bare.text, INVALID);
  assert.equal(bare.detail, said);
});

test("the frame's advice wins for a full context, and the TUI's panel reads as Settings › Models", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const advice = "The conversation no longer fits in the local model's context window. Compact this chat, or pick a model with a larger window in the Providers panel.";
  const r = row({ kind: "error", category: "transport", error: LLAMA_400, payload: { code: "local_context_exceeded", advice } });
  assert.equal(r.text, advice.replace("the Providers panel", "Settings › Models"));
  assert.equal(r.detail, LLAMA_400);
});

test("the code is enough on an OpenAI-compatible local server (Atomic Chat on 1337)", () => {
  const config = {
    localModels: { mode: "external", url: "http://127.0.0.1:8090" },
    llm: { activeTextProvider: "atomic-chat", providers: [
      { id: "atomic-chat", kind: "openai", baseUrl: "http://127.0.0.1:1337/v1" },
    ] },
  };
  const row = window(config);
  const said = '"atomic-chat" rejected the request (400). The local Atomic Chat server at 127.0.0.1:1337 turned the request down (400).';
  const full = row({ kind: "error", category: "transport", error: said, payload: { code: "local_context_exceeded" } });
  assert.equal(full.text, PHRASE);
  const invalid = row({ kind: "error", category: "transport", error: said, payload: { code: "local_request_invalid" } });
  assert.equal(invalid.text, INVALID);
});

test("a cloud 400 with no code reads as before, and a 404/405 is still the wrong server", () => {
  const cloud = window(external("http://127.0.0.1:8090", "openrouter"));
  const said = '"openrouter" answered 400 (bad request): tools are not supported';
  assert.equal(cloud({ kind: "error", category: "transport", error: said }).text, "Couldn't get a reply from OpenRouter.");
  const row = window(external("http://127.0.0.1:8090"));
  const r = row({ kind: "error", category: "transport", error: "llama-server returned http 404", payload: { code: "local_request_invalid" } });
  assert.match(r.text, /^The server at 127\.0\.0\.1:8090 is not a model server/);
});
