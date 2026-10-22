// ATO-813: Studio's local downloads send the Hugging Face token the agent
// would send: the environment, else `<stateDir>/.env`. Against the built output.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { agentHuggingFaceToken } = require("../out/main/hf-token.js");

const base = mkdtempSync(join(tmpdir(), "hf-token-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function stateDir(dotenv) {
  const dir = join(base, String(n++));
  mkdirSync(dir);
  if (dotenv !== null) writeFileSync(join(dir, ".env"), dotenv);
  return dir;
}

test("a token kept in the agent's .env is found when the app's environment has none", () => {
  assert.equal(agentHuggingFaceToken(stateDir("# keys\nHF_TOKEN=\"hf_from_dotenv\"\n"), {}), "hf_from_dotenv");
  assert.equal(agentHuggingFaceToken(stateDir("HUGGING_FACE_HUB_TOKEN=hf_hub\n"), {}), "hf_hub");
});

test("the environment wins, as load-dotenv leaves a set name alone; an empty one does not", () => {
  const dir = stateDir("HF_TOKEN=hf_from_dotenv\n");
  assert.equal(agentHuggingFaceToken(dir, { HF_TOKEN: "hf_from_env" }), "hf_from_env");
  assert.equal(agentHuggingFaceToken(dir, { HF_TOKEN: "" }), "hf_from_dotenv");
});

test("HF_TOKEN comes before HUGGING_FACE_HUB_TOKEN wherever each is kept, as the agent reads them", () => {
  const dir = stateDir("HF_TOKEN=hf_from_dotenv\n");
  assert.equal(agentHuggingFaceToken(dir, { HUGGING_FACE_HUB_TOKEN: "hf_hub_env" }), "hf_from_dotenv");
});

test("no token anywhere, or no .env at all, is none", () => {
  assert.equal(agentHuggingFaceToken(stateDir(null), {}), null);
  assert.equal(agentHuggingFaceToken(stateDir("OPENROUTER_API_KEY=x\nHF_TOKEN=\n"), {}), null);
});

test("Studio's downloads use it, and the token is never logged", () => {
  const studio = readFileSync(new URL("../main/studio-local-models.ts", import.meta.url), "utf8");
  assert.match(studio, /const defaultHfToken = \(\): string \| null => agentHuggingFaceToken\(DESKTOP_STATE_DIR\);/);
  assert.match(studio, /isHuggingFaceUrl\(url\) \? \(this\.deps\.hfToken \?\? defaultHfToken\)\(\) : null/);
  assert.doesNotMatch(studio, /huggingFaceToken\(\)/, "no download reads the environment-only port any more");
  const mod = readFileSync(new URL("../main/hf-token.ts", import.meta.url), "utf8");
  assert.doesNotMatch(mod, /console\.|send\(/);
});

// ATO-853: "Add a model from Hugging Face" (the listing and the projector
// download, huggingface.ts) sends the same token, so a gated repo whose token
// is only in `<stateDir>/.env` lists here as it downloads with `models pull`.
test("the Hugging Face listing's token comes from the agent's .env too", () => {
  const { huggingFaceToken } = require("../out/main/huggingface.js");
  assert.equal(huggingFaceToken(stateDir("HF_TOKEN=hf_from_dotenv\n"), {}), "hf_from_dotenv");
  assert.equal(huggingFaceToken(stateDir("HF_TOKEN=hf_from_dotenv\n"), { HF_TOKEN: "hf_from_env" }), "hf_from_env");
  assert.equal(huggingFaceToken(stateDir(null), {}), null);
});

test("the listing no longer adds the old 'this window does not read .env' line", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /hfGatedTokenHint/);
  assert.doesNotMatch(main, /which `atag models pull` reads and this window does not/);
  const hf = readFileSync(new URL("../main/huggingface.ts", import.meta.url), "utf8");
  assert.match(hf, /return agentHuggingFaceToken\(stateDir, env\);/);
});
