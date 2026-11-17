// ATO-1607: Azure OpenAI and Amazon Bedrock are rows in Add provider. Their
// endpoint is per account, so the configure step asks for it, prefilled with
// the preset's template, and refuses the template until it is filled in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return source.slice(at + 1, source.indexOf("\n}", at) + 2);
}
function presets() {
  const at = source.indexOf("\nconst PRESETS = [");
  return vm.runInNewContext("(" + source.slice(at + "\nconst PRESETS = ".length, source.indexOf("\n];", at) + 2) + ")");
}
function load(baseUrl = "") {
  const c = vm.createContext({ WIZ: { baseUrl } });
  for (const n of ["wizAsksUrl", "wizUrlValue", "wizPerAccountUrlError"]) vm.runInContext(fn(n), c);
  return c;
}

test("Azure OpenAI and Amazon Bedrock are presets with the agent's endpoints and key variables", () => {
  const byId = Object.fromEntries(presets().map((p) => [p.id, p]));
  assert.equal(byId["azure-openai"].baseUrl, "https://your-resource.openai.azure.com/openai");
  assert.equal(byId["azure-openai"].env, "AZURE_OPENAI_API_KEY");
  assert.equal(byId["azure-openai"].perAccount.placeholder, "your-resource");
  assert.equal(byId.bedrock.baseUrl, "https://bedrock-mantle.us-east-1.api.aws");
  assert.equal(byId.bedrock.env, "AWS_BEARER_TOKEN_BEDROCK");
  assert.ok(byId.bedrock.perAccount.hint.length > 0);
  // No longer named as terminal-only.
  assert.doesNotMatch(source.slice(source.indexOf("const TUI_ONLY_PRESET_WORDS"), source.indexOf("\n", source.indexOf("const TUI_ONLY_PRESET_WORDS"))), /azure|bedrock/);
  // The add-provider rows carry perAccount over.
  assert.match(source, /local:p\.local, perAccount:p\.perAccount\}/);
});

test("the address field opens on the template and keeps what was typed", () => {
  const azure = presets().find((p) => p.id === "azure-openai");
  assert.equal(load().wizAsksUrl(azure), true);
  assert.equal(load().wizAsksUrl({ id: "groq" }), false);
  assert.equal(load().wizAsksUrl({ id: "openai-compatible", custom: true }), true);
  assert.equal(load().wizUrlValue(azure), azure.baseUrl);
  assert.equal(load("https://my-team.openai.azure.com/openai").wizUrlValue(azure), "https://my-team.openai.azure.com/openai");
});

test("the template is refused until the account's part is filled in", () => {
  const [azure, bedrock] = ["azure-openai", "bedrock"].map((id) => presets().find((p) => p.id === id));
  const c = load();
  assert.equal(c.wizPerAccountUrlError(azure, azure.baseUrl), azure.perAccount.hint);
  assert.equal(c.wizPerAccountUrlError(azure, "https://my-team.openai.azure.com/openai"), "");
  assert.match(c.wizPerAccountUrlError(azure, "my-team"), /^That does not look like a URL\./);
  // Bedrock's template is a real Region, so it may be kept as it is.
  assert.equal(c.wizPerAccountUrlError(bedrock, bedrock.baseUrl), "");
  assert.equal(c.wizPerAccountUrlError({ id: "groq" }, "x"), "");
});

test("the saved entry takes the typed endpoint, not the template", () => {
  assert.match(source, /else if \(k\.perAccount\) entry\.baseUrl = WIZ\.baseUrl;/);
  assert.ok(source.indexOf("else if (k.perAccount) entry.baseUrl") < source.indexOf("else if (k.baseUrl) entry.baseUrl = k.baseUrl;"));
});
