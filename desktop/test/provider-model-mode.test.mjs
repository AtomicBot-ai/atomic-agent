import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const stateDir = mkdtempSync(join(tmpdir(), "desktop-model-mode-"));
process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const cli = require("../out/main/agent-cli.js");
const { defaultProviderModelMode } = require("../out/main/provider-model-mode.js");
const ts = require("typescript");

// Load the actual core policy and presets without a prior agent build. This
// test must fail if the separate desktop build drifts from the core contract.
const coreModules = new Map();
function loadCore(url) {
  if (coreModules.has(url.href)) return coreModules.get(url.href);
  const exports = {};
  coreModules.set(url.href, exports);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports,
    URL,
    require: (specifier) => {
      assert.ok(specifier.startsWith("."), `unexpected core dependency: ${specifier}`);
      return loadCore(new URL(specifier.replace(/\.js$/, ".ts"), url));
    },
  }, { filename: url.pathname });
  return exports;
}

test("desktop initial policy matches the core for every preset and provider kind", () => {
  const core = loadCore(new URL("../../src/config/model-mode.ts", import.meta.url));
  const { PROVIDER_PRESETS } = loadCore(new URL("../../src/llm/provider/presets/provider-presets.ts", import.meta.url));
  const entries = PROVIDER_PRESETS.flatMap((preset) => [
    { kind: "openai-compatible", baseUrl: preset.baseUrl },
    { kind: "openai-compatible", baseUrl: new URL(preset.baseUrl).origin.toUpperCase() + "/v1/" },
  ]);
  for (const kind of ["openrouter", "aimlapi", "gemini", "llama-server", "openai-compatible", "qwen-openai-compatible", "subscription-cli"]) {
    entries.push({ kind }, { kind, baseUrl: "https://api.openai.com/v1" });
  }
  entries.push(
    { kind: "subscription-cli", subscriptionCli: { cli: "claude" } },
    { kind: "subscription-cli", subscriptionCli: { cli: "codex" } },
    { kind: "subscription-cli", subscriptionCli: { cli: "" } },
    { kind: "openai-compatible", subscriptionCli: { cli: "codex" } },
    ...["https://custom.invalid", "not a url", "", "http://api.openai.com", "https://api.openai.com.evil.invalid", "https://api.openai.com:8443", "http://127.0.0.1:1337"].map((baseUrl) => ({ kind: "openai-compatible", baseUrl })),
  );
  for (const entry of entries) {
    assert.equal(defaultProviderModelMode(entry), core.defaultProviderModelMode(entry), JSON.stringify(entry));
  }
});

async function withConfig(providers, body) {
  let config = { version: 75, llm: { providers } };
  return cli.withCliStandIn(async (args, input) => {
    if (args.join(" ") === "config get") {
      return { ok: true, stdout: JSON.stringify(config), stderr: "" };
    }
    assert.deepEqual(args, ["config", "set", "-"]);
    config = JSON.parse(input);
    return { ok: true, stdout: "", stderr: "" };
  }, () => body(() => config.llm.providers));
}

test("desktop saves a context policy for new providers after the v75 migration", async () => {
  await withConfig([], async (providers) => {
    const entries = [
      [{ id: "openrouter-2", kind: "openrouter" }, "cloud"],
      [{ id: "groq-2", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai", defaultChatModel: "m" }, "cloud"],
      [{ id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434", defaultChatModel: "m" }, "local"],
      [{ id: "custom", kind: "openai-compatible", baseUrl: "https://custom.invalid", defaultChatModel: "m" }, "local"],
      [{ id: "manual", kind: "gemini", modelMode: "local", modelModes: { exact: "cloud" } }, "local"],
    ];
    for (const [entry, expected] of entries) {
      const result = await cli.upsertProvider(entry);
      assert.equal(result.ok, true, result.error);
      const saved = providers().find((p) => p.id === entry.id);
      assert.equal(saved.modelMode, expected, entry.id);
      if (entry.modelModes) assert.deepEqual(saved.modelModes, entry.modelModes);
    }
  });
});

test("desktop key and model edits preserve provider policy, exact-model overrides and inherit", async () => {
  for (const modelMode of ["local", "cloud", undefined]) {
    const entry = { id: "openrouter", kind: "openrouter", defaultChatModel: "old", modelModes: { exact: "local" } };
    if (modelMode !== undefined) entry.modelMode = modelMode;
    await withConfig([entry], async (providers) => {
      const key = await cli.upsertProvider({ id: entry.id, kind: entry.kind, apiKey: "dummy-test-key" });
      assert.equal(key.ok, true, key.error);
      const model = await cli.setProviderModel(entry.id, "new");
      assert.equal(model.ok, true, model.error);
      const saved = providers().find((p) => p.id === entry.id);
      assert.equal(saved.modelMode, modelMode);
      assert.equal(Object.hasOwn(saved, "modelMode"), modelMode !== undefined);
      assert.deepEqual(saved.modelModes, entry.modelModes);
      assert.equal(saved.defaultChatModel, "new");
      assert.equal(saved.apiKey, "dummy-test-key");
    });
  }
});
