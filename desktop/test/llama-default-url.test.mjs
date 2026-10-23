// ATO-834 / ATO-847: llama-server's default port moved from 8080 to 9931
// (llama.cpp v0.7.0) and the agent's localModels.url default followed. A
// fresh state dir now carries 9931; an install from before carries the old
// 8080 default that nobody chose. The first-run wizard, the composer's
// "Set up a model" slot and the wizard's own readiness probe must read both
// as untouched, the way the agent's isLocalBackendConfigured does, and any
// other address as a backend the user set up.
// The renderer as text in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function block(head) {
  const at = source.indexOf("\n" + head);
  if (at < 0) throw new Error("not found: " + head);
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function constLine(name) {
  const m = source.match(new RegExp("^const " + name + " = [^\\n]*;", "m"));
  if (!m) throw new Error("not found: const " + name);
  return m[0];
}

function renderer(config, { backend = "custom", ext = { url: null, model: null } } = {}) {
  const c = vm.createContext({
    LIVE_CONFIG: config, OB: { open: false }, SWX: { want: null }, EXT: ext,
    selBackend: () => backend,
    BR: {
      providersReady: async () => ({ ok: true, ids: [] }),
      configGet: async () => ({ ok: true, config }),
    },
  });
  // `const` stays script-scoped in a vm context, so run them as one script.
  vm.runInContext([
    constLine("OB_DEFAULT_LLAMA_URL"),
    constLine("DEFAULT_LLAMA_URL"),
    constLine("LEGACY_LLAMA_URL"),
    block("function llamaUrlUntouched("),
    block("function needsOnboarding("),
    block("function composerNeedsSetup("),
    block("async function obReadiness("),
    "this.api = { needsOnboarding, composerNeedsSetup, obReadiness, DEFAULT_LLAMA_URL, OB_DEFAULT_LLAMA_URL };",
  ].join("\n"), c);
  return c.api;
}

const external = (url) => ({ localModels: { mode: "external", url, managed: { modelId: null } }, llm: {}, tui: { onboarding: {} } });

test("the desktop's default External URL is llama-server's own port 9931", () => {
  const r = renderer(external("http://127.0.0.1:9931"));
  assert.equal(r.DEFAULT_LLAMA_URL, "http://127.0.0.1:9931");
  assert.equal(r.OB_DEFAULT_LLAMA_URL, "http://127.0.0.1:9931");
});

test("a fresh 9931 config and an old 8080 config both still reach the first-run wizard", () => {
  for (const url of ["http://127.0.0.1:9931", "http://127.0.0.1:8080"]) {
    assert.equal(renderer(external(url)).needsOnboarding(external(url)), true, url);
  }
  const typed = external("http://127.0.0.1:9999");
  assert.equal(renderer(typed).needsOnboarding(typed), false);
});

test("the composer offers setup on either shipped default and not on an address the user typed", () => {
  for (const url of ["http://127.0.0.1:9931", "http://127.0.0.1:8080"]) {
    assert.equal(renderer(external(url)).composerNeedsSetup(), true, url);
  }
  assert.equal(renderer(external("http://192.168.1.5:8080")).composerNeedsSetup(), false);
  // A server that answers at the default with a model brings the chips back.
  const answering = renderer(external("http://127.0.0.1:9931"), { ext: { url: "http://127.0.0.1:9931", model: "m" } });
  assert.equal(answering.composerNeedsSetup(), false);
});

test("the wizard's readiness probe does not count either shipped default as a local backend", async () => {
  for (const url of ["http://127.0.0.1:9931", "http://127.0.0.1:8080"]) {
    assert.equal((await renderer(external(url)).obReadiness()).localReady, false, url);
  }
  assert.equal((await renderer(external("http://10.0.0.4:9931")).obReadiness()).localReady, true);
});
