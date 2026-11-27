// ATO-1196: an Ollama or LM Studio with no models answers the wizard's
// `models search --refresh` with an empty list, and the agent says
// "no searchable cloud models: the configured providers ship no catalog...".
// The wizard only matched `no models`, so the screen read "<X> at <address>
// didn't list its models." instead of "has no models yet. Add one in <X>".
//
// renderer.js and the agent's source are read as text; wizSaidNoModels runs
// in a vm context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const agent = readFileSync(new URL("../../src/cli/models-search-command.ts", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

function saidNoModels(said) {
  const c = vm.createContext({});
  vm.runInContext(fn("wizSaidNoModels"), c);
  return c.wizSaidNoModels(said);
}

// The line exactly as the agent prints it when every list came back empty.
const AGENT_EMPTY = (() => {
  const at = agent.indexOf('"no searchable cloud models:');
  assert.ok(at >= 0, "the agent still prints the empty-catalog line");
  const parts = agent.slice(at, agent.indexOf(");", at)).match(/"((?:[^"\\]|\\.)*)"/g);
  return parts.map((p) => JSON.parse(p)).join("");
})();

test("the agent's empty-catalog line reads as a server with no models", () => {
  assert.match(AGENT_EMPTY, /^no searchable cloud models:/);
  assert.equal(saidNoModels(AGENT_EMPTY), true);
  assert.equal(saidNoModels("Error: " + AGENT_EMPTY.trim()), true);
});

test("no words and a plain 'no models' still read as empty, as before", () => {
  assert.equal(saidNoModels(""), true);
  assert.equal(saidNoModels("no models"), true);
});

test("a failed list is not an empty server", () => {
  assert.equal(saidNoModels('could not list models from "ollama": http 404'), false);
  assert.equal(saidNoModels('could not list models from "lmstudio": fetch failed'), false);
  assert.equal(saidNoModels("models search did not return JSON: \"oops\""), false);
});

// ATO-2011: an address of your own (a Tailscale 100.x, a domain) with no model read "Could not
// check this key"; it is asked for any custom address now, and a llama.cpp still loading its
// model ("http 503: Loading model") is said as that, not as "had a problem answering (HTTP 503)".
function wizNextBody() {
  const at = source.indexOf("\nasync function wizNextStep(");
  assert.ok(at >= 0, "wizNextStep is in renderer.js");
  return source.slice(at, source.indexOf("\n}\n", at));
}

test("the wizard asks it for a server on this machine and for any address of your own", () => {
  const body = wizNextBody();
  assert.match(body, /: \(local \|\| k\.custom\) && wizSaidNoModels\(said\)\n\s*\? Name \+ ' at ' \+ where \+ \(k\.custom \? ' has no models loaded\. Load a model into the server' : ' has no models yet\. Add one in ' \+ name\)/);
  assert.doesNotMatch(body, /: local && wizSaidNoModels\(said\)/);
  // The key-free lines come before the cloud fallback that names the key.
  assert.ok(body.indexOf("wizSaidNoModels(said)\n") < body.indexOf("'Could not check this key with '"));
});

test("an empty server of your own does not light the key field", () => {
  const body = wizNextBody();
  assert.match(body, /const notTheKey = [^;]*\|\| \(k\.custom && !refused && wizSaidNoModels\(said\)\)/);
});

test("llama.cpp's 503 Loading model is said as a model still loading, ahead of the HTTP 5xx line", () => {
  const body = wizNextBody();
  const decl = body.match(/const loadingModel = ([^;]*);/);
  assert.ok(decl, "loadingModel is read off the answer");
  const loading = (status, said, k) => vm.runInNewContext(decl[1], {status, said, k});
  assert.equal(loading(503, "http 503: Loading model", {custom: true}), true);
  assert.equal(loading(503, "could not list models from \"mine\": http 503: Loading model", {local: true}), true);
  assert.equal(loading(503, "http 503: Service Unavailable", {custom: true}), false);
  assert.equal(loading(502, "http 502: Loading model", {custom: true}), false);
  assert.equal(loading(503, "http 503: Loading model", {}), false, "a cloud provider's 503 keeps its own line");
  const at = body.indexOf(": loadingModel\n");
  assert.ok(at >= 0 && at < body.indexOf(": status >= 500\n"));
  assert.match(body.slice(at, at + 200), /is still loading its model\. Wait a moment, then try again\./);
});
