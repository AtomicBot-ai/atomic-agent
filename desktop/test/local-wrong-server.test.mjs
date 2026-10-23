// ATO-869: a local llama-server that answers 404/405 is up, so "Local models
// is not answering" was wrong. The agent's words are 'llama-server returned
// http 404: …' (llama-server-client.ts buildHttpError). The row now says the
// address is not a model server or has no model loaded, with the agent's words
// under Details. A refused connection still reads "not answering"; a cloud 404
// still reads "Couldn't get a reply from …".
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
  "turnFailureLine", "localWrongServerLine", "localServerHost", "waitIsLocalServer",
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

const external = (url) => ({
  localModels: { mode: "external", url },
  llm: { activeTextProvider: "local-llama", providers: [
    { id: "local-llama", kind: "llama-server", url, baseUrl: "http://127.0.0.1:19092" },
    { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  ] },
});

test("a local server answering 404 or 405 is named as the wrong server, not as silent", () => {
  const row = window(external("http://127.0.0.1:8090"));
  for (const status of [404, 405]) {
    const said = `llama-server returned http ${status}: File Not Found`;
    const r = row({ kind: "error", category: "transport", error: said });
    assert.equal(r.text, "The server at 127.0.0.1:8090 is not a model server, or no model is loaded there. Check the address in Settings › Models.");
    assert.equal(r.detail, said);
    assert.doesNotMatch(r.text, /not answering|undefined|—/);
  }
});

test("the address is the llama-server entry's url, not its embeddings baseUrl; a bare local-llama falls back to localModels", () => {
  const managed = window({ localModels: { mode: "managed", managed: { port: 29470 } } });
  const r = managed({ kind: "error", category: "transport", error: "llama-server returned http 404" });
  assert.match(r.text, /^The server at 127\.0\.0\.1:29470 is not a model server/);
  const noUrl = window({ localModels: { mode: "external", url: "http://10.0.0.5:8080" },
    llm: { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server" }] } });
  assert.match(noUrl({ kind: "error", category: "transport", error: "llama-server returned http 405" }).text,
    /^The server at 10\.0\.0\.5:8080 /);
});

test("a refused connection still reads as not answering", () => {
  const row = window(external("http://127.0.0.1:8090"));
  const r = row({ kind: "error", category: "transport", error: "fetch failed: connect ECONNREFUSED 127.0.0.1:8090" });
  assert.match(r.text, /^local-llama is not answering/);
});

test("a cloud provider's 404 still reads as no reply from it", () => {
  const cfg = external("http://127.0.0.1:8090");
  cfg.llm.activeTextProvider = "openrouter";
  const row = window(cfg);
  const said = '"openrouter" answered 404 (not found). The model id or the base URL is likely wrong.';
  const r = row({ kind: "error", category: "transport", error: said });
  assert.equal(r.text, "Couldn't get a reply from OpenRouter.");
  assert.equal(r.detail, said);
});
