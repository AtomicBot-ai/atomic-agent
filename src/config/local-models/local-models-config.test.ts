import { describe, expect, it } from "vitest";
import { createLocalModelsDefaults } from "./local-models-defaults.js";
import {
  parseBackendVariant, parseLocalCompletionCap, parseLocalLlmMode,
  parseLocalTemplateSetting, parseReasoningBudgetTokens, parseSwaFullPreference,
  parseTensorSplit, parseUserLocalModelsConfig, prepareLocalModelsInputs,
} from "./local-models-parser.js";
import * as schema from "../config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "../config-validation-error.js";
import { parseCustomLocalModel } from "../custom-models-schema.js";

const CUSTOM_MODEL = {
  id: "custom-stage05i-fixture",
  filename: "synthetic-weights.gguf",
  huggingFaceUrl: "https://huggingface.co/synthetic/fixture/resolve/main/synthetic-weights.gguf",
};

function thrownError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected local-model configuration fixture validation to reject");
}

function parseLocal(raw: Record<string, unknown>, version = 74) {
  const defaults = createLocalModelsDefaults();
  return parseUserLocalModelsConfig(prepareLocalModelsInputs(raw, version, () => defaults), () => defaults);
}

describe("local model configuration domain seams", () => {
  it("preserves the seven public validator identities and original error class", () => {
    expect(schema.parseLocalTemplateSetting).toBe(parseLocalTemplateSetting);
    expect(schema.parseLocalLlmMode).toBe(parseLocalLlmMode);
    expect(schema.parseBackendVariant).toBe(parseBackendVariant);
    expect(schema.parseSwaFullPreference).toBe(parseSwaFullPreference);
    expect(schema.parseLocalCompletionCap).toBe(parseLocalCompletionCap);
    expect(schema.parseReasoningBudgetTokens).toBe(parseReasoningBudgetTokens);
    expect(schema.parseTensorSplit).toBe(parseTensorSplit);
    expect(schema.ConfigValidationError).toBe(OwnedValidationError);
    expect(thrownError(() => parseLocalCompletionCap(63, "synthetic.cap")))
      .toMatchObject({ field: "synthetic.cap", reason: "expected integer in [64, 131072], got 63" });
  });

  it("creates fresh mutable nested defaults and output arrays in the original key order", () => {
    const defaults = createLocalModelsDefaults();
    const other = createLocalModelsDefaults();
    const parsed = parseLocal({});
    const root = schema.parseUserConfigFile({}).localModels;
    expect(parsed).toStrictEqual(defaults);
    expect(root).toStrictEqual(defaults);
    expect(Object.keys(defaults)).toEqual(["url", "mode", "completionMaxTokens", "useServerTemplate", "thinking", "reasoningBudgetTokens", "managed", "embeddings", "download", "customModels"]);
    expect(Object.keys(defaults.managed)).toEqual(["modelId", "port", "dataDirOverride", "autoUpdate", "stopOnExit", "autoRestart", "device", "backendVariant", "contextSize", "tensorSplit", "parallel", "swaFull"]);
    expect(defaults.managed).not.toBe(other.managed);
    expect(defaults.embeddings).not.toBe(other.embeddings);
    expect(defaults.download).not.toBe(other.download);
    expect(defaults.managed.tensorSplit).not.toBe(other.managed.tensorSplit);
    expect(defaults.customModels).not.toBe(other.customModels);
    expect(parsed.managed).not.toBe(defaults.managed);
    expect(parsed.embeddings).not.toBe(defaults.embeddings);
    expect(parsed.download).not.toBe(defaults.download);
    expect(parsed.managed.tensorSplit).not.toBe(defaults.managed.tensorSplit);
    expect(parsed.customModels).not.toBe(defaults.customModels);
    expect(root.managed).not.toBe(schema.USER_CONFIG_DEFAULTS.localModels.managed);
    defaults.managed.tensorSplit.push(1, 2);
    defaults.customModels.push(parseCustomLocalModel(CUSTOM_MODEL, "fixture"));
    defaults.embeddings.port = 1234;
    expect(createLocalModelsDefaults()).toStrictEqual(other);
    expect(parsed).toStrictEqual(other);
  });

  it("validates same-file custom models before selecting the managed model", () => {
    const raw = { customModels: [CUSTOM_MODEL], managed: { modelId: CUSTOM_MODEL.id } };
    expect(parseLocal(raw).managed.modelId).toBe(CUSTOM_MODEL.id);
    const root = schema.parseUserConfigFile({ localModels: raw }).localModels;
    expect(root.managed.modelId).toBe(CUSTOM_MODEL.id);
    expect(root.customModels[0]?.id).toBe(CUSTOM_MODEL.id);
    const field = "localModels.managed.modelId";
    for (const error of [thrownError(() => parseLocal({ managed: { modelId: CUSTOM_MODEL.id } })), thrownError(() => schema.parseUserConfigFile({ localModels: { managed: { modelId: CUSTOM_MODEL.id } } }))]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field, reason: `unknown managed local model id: ${JSON.stringify(CUSTOM_MODEL.id)}` });
    }
  });

  it("accepts nonempty unknown embedding ids without introducing a historical migration", () => {
    for (const version of [21, 22, 74]) {
      expect(parseLocal({ embeddings: { modelId: "synthetic-unknown-embedding" } }, version).embeddings.modelId)
        .toBe("synthetic-unknown-embedding");
      expect(schema.parseUserConfigFile({ version, localModels: { embeddings: { modelId: "synthetic-unknown-embedding" } } }).localModels.embeddings.modelId)
        .toBe("synthetic-unknown-embedding");
    }
  });

  it("keeps early normalized values while reading late scalar fields after LLM composition", () => {
    const raw = { mode: "managed", managed: { port: 1111 }, completionMaxTokens: 0 };
    const prepared = prepareLocalModelsInputs(raw, 74, createLocalModelsDefaults);
    raw.managed.port = 2222;
    raw.completionMaxTokens = 64;
    const direct = parseUserLocalModelsConfig(prepared, createLocalModelsDefaults);
    expect(direct.managed.port).toBe(1111);
    expect(direct.completionMaxTokens).toBe(64);
    raw.managed.port = 1111;
    raw.completionMaxTokens = 0;
    const root = schema.parseUserConfigFile({ localModels: raw, get llm() {
      raw.managed.port = 2222;
      raw.completionMaxTokens = 64;
      return {};
    } });
    expect(root.localModels.managed.port).toBe(1111);
    expect(root.localModels.completionMaxTokens).toBe(64);
    expect(root.llm?.providers[0]?.url).toBe("http://127.0.0.1:1111");
  });

  it.each([
    { version: 40, raw: undefined, expected: true, reads: 0 },
    { version: 40, raw: "malformed", expected: true, reads: 0 },
    { version: 41, raw: undefined, expected: false, reads: 1 },
    { version: 41, raw: false, expected: false, reads: 0 },
  ])("retains lazy auto-update defaults at v$version for raw $raw", ({ version, raw, expected, reads }) => {
    const original = schema.USER_CONFIG_DEFAULTS.localModels;
    const defaults = createLocalModelsDefaults();
    let accesses = 0;
    Object.defineProperty(defaults.managed, "autoUpdate", { get() { accesses += 1; return false; } });
    try {
      schema.USER_CONFIG_DEFAULTS.localModels = defaults;
      const input = { managed: { autoUpdate: raw } };
      const direct = parseUserLocalModelsConfig(prepareLocalModelsInputs(input, version, () => defaults), () => defaults);
      expect(direct.managed.autoUpdate).toBe(expected);
      expect(accesses).toBe(reads);
      accesses = 0;
      expect(schema.parseUserConfigFile({ version, localModels: input }).localModels.managed.autoUpdate).toBe(expected);
      expect(accesses).toBe(reads);
    } finally { schema.USER_CONFIG_DEFAULTS.localModels = original; }
  });

  it.each([
    { version: 62, raw: "auto", expected: "auto", reads: 0 },
    { version: 62, raw: 2, expected: "auto", reads: 0 },
    { version: 63, raw: 2, expected: 2, reads: 0 },
    { version: 62, raw: 3, expected: 3, reads: 0 },
    { version: 63, raw: null, expected: 0, reads: 1 },
    { version: 63, raw: undefined, expected: 0, reads: 1 },
  ])("preserves parallel migration and direct-default branches (v$version / $raw)", ({ version, raw, expected, reads }) => {
    const original = schema.USER_CONFIG_DEFAULTS.localModels;
    const defaults = createLocalModelsDefaults();
    let accesses = 0;
    Object.defineProperty(defaults.managed, "parallel", { get() { accesses += 1; return 0; } });
    try {
      schema.USER_CONFIG_DEFAULTS.localModels = defaults;
      const input = { managed: { parallel: raw } };
      expect(parseUserLocalModelsConfig(prepareLocalModelsInputs(input, version, () => defaults), () => defaults).managed.parallel).toBe(expected);
      expect(accesses).toBe(reads);
      accesses = 0;
      expect(schema.parseUserConfigFile({ version, localModels: input }).localModels.managed.parallel).toBe(expected);
      expect(accesses).toBe(reads);
    } finally { schema.USER_CONFIG_DEFAULTS.localModels = original; }
  });

  it("ignores tensor/custom/data-directory defaults and derives embedding URL from the parsed port", () => {
    const original = schema.USER_CONFIG_DEFAULTS.localModels;
    const defaults = createLocalModelsDefaults();
    defaults.managed.tensorSplit = [1, 2];
    defaults.customModels = [parseCustomLocalModel(CUSTOM_MODEL, "fixture")];
    defaults.embeddings.port = 1234;
    defaults.embeddings.modelId = "synthetic-default-embedding";
    Object.defineProperty(defaults.managed, "dataDirOverride", { get() { throw new Error("data-directory default must not be read"); } });
    Object.defineProperty(defaults.embeddings, "url", { get() { throw new Error("embedding URL default must not be read"); } });
    try {
      schema.USER_CONFIG_DEFAULTS.localModels = defaults;
      const root = schema.parseUserConfigFile({}).localModels;
      expect(root.managed.tensorSplit).toEqual([]);
      expect(root.customModels).toEqual([]);
      expect(root.managed.dataDirOverride).toBeNull();
      expect(root.embeddings.modelId).toBe("synthetic-default-embedding");
      expect(root.embeddings.url).toBe("http://127.0.0.1:1234");
      expect(root.managed.tensorSplit).not.toBe(defaults.managed.tensorSplit);
      expect(root.customModels).not.toBe(defaults.customModels);
    } finally { schema.USER_CONFIG_DEFAULTS.localModels = original; }
  });

  it.each([
    { value: null, reads: 1, expected: null },
    { value: undefined, reads: 2, expected: null },
    { value: " synthetic path ", reads: 3, expected: " synthetic path " },
  ])("retains repeated data-directory getter reads ($reads)", ({ value, reads, expected }) => {
    let accesses = 0;
    const raw = { managed: { get dataDirOverride() { accesses += 1; return value; } } };
    expect(schema.parseUserConfigFile({ localModels: raw }).localModels.managed.dataDirOverride).toBe(expected);
    expect(accesses).toBe(reads);
  });

  it("observes nested and whole default replacements in the same call without retargeting prepared values", () => {
    const original = schema.USER_CONFIG_DEFAULTS.localModels;
    const first = createLocalModelsDefaults();
    const second = createLocalModelsDefaults();
    second.mode = "managed";
    second.url = "ftp://example.invalid/model-server";
    second.managed.port = 3333;
    const third = createLocalModelsDefaults();
    third.completionMaxTokens = 64;
    third.useServerTemplate = "off";
    third.thinking = "off";
    third.reasoningBudgetTokens = 0;
    const events: string[] = [];
    try {
      schema.USER_CONFIG_DEFAULTS.localModels = first;
      const root = schema.parseUserConfigFile({ localModels: {
        managed: { get port() {
          events.push("nested managed replacement");
          schema.USER_CONFIG_DEFAULTS.localModels.managed = { ...first.managed, port: 1111, autoUpdate: false };
          return undefined;
        } },
        get mode() { events.push("whole early replacement"); schema.USER_CONFIG_DEFAULTS.localModels = second; return undefined; },
        get completionMaxTokens() { events.push("whole late replacement"); schema.USER_CONFIG_DEFAULTS.localModels = third; return undefined; },
      }, llm: {} });
      expect(events).toEqual(["nested managed replacement", "whole early replacement", "whole late replacement"]);
      expect(root.localModels.managed.port).toBe(1111);
      expect(root.localModels.managed.autoUpdate).toBe(false);
      expect(root.localModels.mode).toBe("managed");
      expect(root.localModels.url).toBe(second.url);
      expect(root.localModels.completionMaxTokens).toBe(64);
      expect(root.localModels.useServerTemplate).toBe("off");
      expect(root.localModels.thinking).toBe("off");
      expect(root.localModels.reasoningBudgetTokens).toBe(0);
      expect(root.llm?.providers[0]?.url).toBe("http://127.0.0.1:1111");
      third.managed.port = 4444;
      expect(root.localModels.managed.port).toBe(1111);
      expect(root.localModels.managed).not.toBe(third.managed);
    } finally { schema.USER_CONFIG_DEFAULTS.localModels = original; }
  });

  it("retains permissive URL/port/device validation and HF normalization without launching resources", () => {
    const raw = {
      url: " ftp://example.invalid/server ", completionMaxTokens: 0, reasoningBudgetTokens: 0,
      managed: { port: 70000, device: " ", contextSize: 0 },
      embeddings: { enabled: false, port: 70001, url: "https://example.invalid/embed" },
      download: { hfEndpoint: " https://user:password@example.invalid/prefix///?query=yes#fragment " },
    };
    const parsed = parseLocal(raw);
    expect(schema.parseUserConfigFile({ localModels: raw }).localModels).toStrictEqual(parsed);
    expect(parsed.url).toBe(raw.url);
    expect(parsed.managed.port).toBe(70000);
    expect(parsed.managed.device).toBe(" ");
    expect(parsed.embeddings.port).toBe(70001);
    expect(parsed.download.hfEndpoint).toBe("https://example.invalid/prefix");
  });

  it.each([false, 42, "primitive", [], new Date(0)])("preserves permissive whole/subblock lookup (%j)", (raw) => {
    expect(schema.parseUserConfigFile({ localModels: raw }).localModels).toStrictEqual(createLocalModelsDefaults());
    expect(schema.parseUserConfigFile({ localModels: { managed: raw, embeddings: raw, download: raw } }).localModels).toStrictEqual(createLocalModelsDefaults());
  });

  it.each([
    { raw: { webhooks: [], localModels: { managed: { port: 0 } } }, field: "webhooks" },
    { raw: { localModels: { customModels: "bad", managed: { modelId: "unknown" } } }, field: "localModels.customModels" },
    { raw: { localModels: { managed: { modelId: "unknown", port: 0 } } }, field: "localModels.managed.modelId" },
    { raw: { localModels: { managed: { port: 0 }, embeddings: { port: 0 } } }, field: "localModels.managed.port" },
    { raw: { localModels: { embeddings: { port: 0, enabled: "bad" } } }, field: "localModels.embeddings.port" },
    { raw: { localModels: { embeddings: { enabled: "bad" }, download: { connections: 0 } } }, field: "localModels.embeddings.enabled" },
    { raw: { localModels: { download: { connections: 0 }, mode: "bad" } }, field: "localModels.download.connections" },
    { raw: { localModels: { mode: "bad", url: "bad" } }, field: "localModels.mode" },
    { raw: { localModels: { url: "bad" }, llm: { activeTextProvider: "missing" } }, field: "localModels.url" },
    { raw: { localModels: { completionMaxTokens: 63 }, llm: { activeTextProvider: "missing" } }, field: "llm.activeTextProvider" },
    { raw: { localModels: { completionMaxTokens: 63, thinking: "bad" }, agent: { tokenBudget: 0 } }, field: "localModels.completionMaxTokens" },
    { raw: { localModels: { thinking: "bad" }, memory: { profile: { maxTokens: 0 } } }, field: "localModels.thinking" },
  ])("preserves the early/LLM/late validation seam at $field", ({ raw, field }) => {
    const error = thrownError(() => schema.parseUserConfigFile(raw));
    expect(error).toBeInstanceOf(OwnedValidationError);
    expect(error).toMatchObject({ field });
  });
});
