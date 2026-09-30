// Unit tests for main/provider-hygiene.ts (U29), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isIncompleteProvider, pruneIncompleteProviders } = require("../out/main/provider-hygiene.js");

test("an OpenAI-compatible entry without a model is incomplete", () => {
  assert.equal(isIncompleteProvider({ id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434" }), true);
  assert.equal(isIncompleteProvider({ id: "q", kind: "qwen-openai-compatible", defaultChatModel: "m" }), true);
  assert.equal(isIncompleteProvider({ id: "ok", kind: "openai-compatible", baseUrl: "http://x", defaultChatModel: "m" }), false);
});

test("kinds with a built-in default model are never incomplete", () => {
  for (const kind of ["openrouter", "aimlapi", "gemini", "llama-server"]) {
    assert.equal(isIncompleteProvider({ id: kind, kind }), false, kind);
  }
});

test("prune removes an unreferenced half-made entry and keeps the rest", () => {
  const cfg = {
    llm: {
      activeTextProvider: "openrouter",
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" },
        { id: "openrouter", kind: "openrouter" },
        { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434", apiKeyEnvVar: "OLLAMA_API_KEY" },
        { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai", defaultChatModel: "llama-4" },
      ],
    },
  };
  assert.deepEqual(pruneIncompleteProviders(cfg), ["ollama"]);
  assert.deepEqual(cfg.llm.providers.map((p) => p.id), ["local-llama", "openrouter", "groq"]);
});

test("prune keeps an incomplete entry that anything else names", () => {
  const active = { llm: { activeTextProvider: "ollama", providers: [{ id: "ollama", kind: "openai-compatible", baseUrl: "http://x" }] } };
  assert.deepEqual(pruneIncompleteProviders(active), []);
  assert.equal(active.llm.providers.length, 1);

  const inChain = {
    llm: {
      activeTextProvider: "openrouter",
      fallback: { chain: ["lmstudio"] },
      providers: [{ id: "openrouter", kind: "openrouter" }, { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://x" }],
    },
  };
  assert.deepEqual(pruneIncompleteProviders(inChain), []);
  assert.equal(inChain.llm.providers.length, 2);
});

test("prune is a no-op on a file with no llm block", () => {
  const cfg = { localModels: { mode: "managed" } };
  assert.deepEqual(pruneIncompleteProviders(cfg), []);
  assert.deepEqual(cfg, { localModels: { mode: "managed" } });
});
