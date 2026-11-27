// ATO-2530: Settings › Models says where a saved key comes from.
// main/secret-source-labels.ts against the built output (npm run build first),
// renderer/secret-source.js directly. Every key is a dummy; nothing is resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/secret-source-labels.js");
const R = require("../renderer/secret-source.js");

test("names the source of each reference scheme and nothing for a plain key", () => {
  const env = [
    "OPENROUTER_API_KEY=op://Private/OpenRouter/credential",
    'NPM_TOKEN="bw://npm/password"',
    "DEPLOY_TOKEN=vault://secret/apps/deploy#token",
    "GROQ_API_KEY=cmd://groq",
    "EXA_API_KEY=exa-plain-1",
    "# GEMINI_API_KEY=op://commented/out/x",
  ].join("\n");
  assert.deepEqual(L.secretSources(env, []), {
    OPENROUTER_API_KEY: "1password",
    NPM_TOKEN: "bitwarden",
    DEPLOY_TOKEN: "vault",
    GROQ_API_KEY: "command",
  });
});

test("a keychain name counts unless .env holds the same name, which wins at load", () => {
  assert.deepEqual(L.secretSources("A_API_KEY=plain\n", ["A_API_KEY", "B_TOKEN"]), { B_TOKEN: "keychain" });
});

test("the label is never the value", () => {
  const out = L.secretSources("X_API_KEY=op://v/i/f\n", []);
  assert.equal(JSON.stringify(out).includes("op://"), false);
});

test("renderer words, per platform, and empty for a plain key", () => {
  const sources = { OPENROUTER_API_KEY: "1password", K_TOKEN: "keychain" };
  assert.equal(R.secretSourceLabel(["OPENROUTER_API_KEY"], sources, "darwin"), "from 1Password");
  assert.equal(R.secretSourceLabel(["K_TOKEN"], sources, "win32"), "in Credential Manager");
  assert.equal(R.secretSourceLabel(["K_TOKEN"], sources, "darwin"), "in Keychain");
  assert.equal(R.secretSourceLabel(["EXA_API_KEY"], sources, "darwin"), "");
  assert.equal(R.secretSourceLabel(["X"], undefined, "darwin"), "");
  const chip = (tone, html) => `<${tone}>${html}</${tone}>`;
  assert.equal(R.secretSourceChip(["OPENROUTER_API_KEY"], sources, "darwin", chip, (s) => s), " <line>from 1Password</line>");
  assert.equal(R.secretSourceChip(["EXA_API_KEY"], sources, "darwin", chip, (s) => s), "");
});
