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

test("the wizard asks it only for a server on this machine", () => {
  const at = source.indexOf("\nasync function wizNextStep(");
  assert.ok(at >= 0, "wizNextStep is in renderer.js");
  const body = source.slice(at, source.indexOf("\n}\n", at));
  assert.match(body, /: local && wizSaidNoModels\(said\)\n\s*\? Name \+ ' at ' \+ where \+ ' has no models yet\. '/);
  assert.equal((body.match(/wizSaidNoModels\(/g) || []).length, 1, "used in the local line only");
});
