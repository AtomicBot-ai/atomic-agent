import { describe, expect, it } from "vitest";
import { createMemoryDefaults } from "./memory-defaults.js";
import { parseMemoryConfig, parseRewriterGateMode, prepareMemoryInputs } from "./memory-parser.js";
import type { UserMemoryConfig } from "./memory-types.js";
import {
  ConfigValidationError,
  parseRewriterGateMode as parseComposedGateMode,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
} from "../config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "../config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected memory configuration fixture validation to reject");
}

function parseMemory(raw: Record<string, unknown>, version = 74): UserMemoryConfig {
  const defaults = createMemoryDefaults();
  return parseMemoryConfig(prepareMemoryInputs(raw), version, () => defaults);
}

function featureFlags(memory: UserMemoryConfig): boolean[] {
  return [memory.links.enabled, memory.evolution.enabled, memory.lessons.enabled,
    memory.procedures.enabled, memory.consolidation.enabled, memory.voting.enabled,
    memory.retrieve.rewriter.enabled];
}

function rawFeatureFlags(enabled: unknown) {
  return { links: { enabled }, evolution: { enabled }, lessons: { enabled },
    procedures: { enabled }, consolidation: { enabled }, voting: { enabled },
    retrieve: { rewriter: { enabled } } };
}

function timeouts(memory: UserMemoryConfig): number[] {
  return [memory.reflection.timeoutMs, memory.links.generatorTimeoutMs, memory.retrieve.rewriter.timeoutMs];
}

describe("memory configuration domain seams", () => {
  it("preserves the public gate-mode helper and existing error class", () => {
    expect(parseComposedGateMode).toBe(parseRewriterGateMode);
    expect(ConfigValidationError).toBe(OwnedValidationError);
    for (const mode of ["heuristic", "embedding", "always"]) {
      expect(parseRewriterGateMode(mode, "synthetic.gateMode")).toBe(mode);
    }
    const error = thrownError(() => parseRewriterGateMode("ALWAYS", "synthetic.gateMode"));
    expect(error).toBeInstanceOf(OwnedValidationError);
    expect(error).toMatchObject({ field: "synthetic.gateMode", reason: 'expected one of heuristic|embedding|always, got "ALWAYS"' });
  });

  it("creates independent mutable defaults and fresh outputs for all fifteen blocks", () => {
    const first = createMemoryDefaults();
    const second = createMemoryDefaults();
    const parsed = parseMemory({});
    const root = parseUserConfigFile({}).memory;
    const names = ["profile", "reflection", "notes", "recallInjection", "index", "dedup", "eviction",
      "embeddings", "links", "evolution", "lessons", "procedures", "consolidation", "voting", "retrieve"];
    expect(Object.keys(first)).toEqual(names);
    expect(Object.keys(parsed)).toEqual(names);
    expect(parsed).toStrictEqual(first);
    expect(root).toStrictEqual(first);
    for (let i = 0; i < names.length; i += 1) {
      expect(Object.values(first)[i]).not.toBe(Object.values(second)[i]);
      expect(Object.values(parsed)[i]).not.toBe(Object.values(first)[i]);
      expect(Object.values(root)[i]).not.toBe(Object.values(USER_CONFIG_DEFAULTS.memory)[i]);
    }
    expect(first.reflection.typedNotes).not.toBe(second.reflection.typedNotes);
    expect(first.reflection.segmentation).not.toBe(second.reflection.segmentation);
    expect(first.retrieve.rewriter).not.toBe(second.retrieve.rewriter);
    expect(first.retrieve.rewriter.embeddingGate).not.toBe(second.retrieve.rewriter.embeddingGate);
    expect(parsed.reflection.typedNotes).not.toBe(first.reflection.typedNotes);
    expect(parsed.reflection.segmentation).not.toBe(first.reflection.segmentation);
    expect(parsed.retrieve.rewriter.embeddingGate).not.toBe(first.retrieve.rewriter.embeddingGate);
    first.profile.maxTokens = 123;
    first.reflection.typedNotes.enabled = true;
    first.retrieve.rewriter.embeddingGate.exemplars = ["synthetic exemplar"];
    expect(createMemoryDefaults()).toStrictEqual(second);
    expect(parsed).toStrictEqual(second);
  });

  it("prepares raw references in the existing order without validating scalar fields", () => {
    const events: string[] = [];
    const raw: Record<string, unknown> = {};
    const earlyNames = ["profile", "reflection", "notes", "recallInjection", "index", "dedup", "eviction",
      "embeddings", "links", "evolution", "lessons", "procedures", "consolidation", "voting"];
    const reflection = {
      get typedNotes() { events.push("typedNotes"); return {}; },
      get segmentation() { events.push("segmentation"); return {}; },
    };
    const profile = { get enabled() { events.push("profile.enabled"); return "invalid"; } };
    for (const name of earlyNames) {
      Object.defineProperty(raw, name, { get() {
        events.push(name);
        return name === "profile" ? profile : name === "reflection" ? reflection : {};
      } });
    }
    Object.defineProperty(raw, "retrieve", { get() {
      events.push("retrieve");
      return { get rewriter() {
        events.push("rewriter");
        return { get embeddingGate() { events.push("embeddingGate"); return {}; } };
      } };
    } });
    const prepared = prepareMemoryInputs(raw);
    expect(events).toEqual([...earlyNames, "typedNotes", "segmentation", "retrieve", "rewriter", "embeddingGate"]);
    expect(thrownError(() => parseMemoryConfig(prepared, 74, createMemoryDefaults)))
      .toMatchObject({ field: "memory.profile.enabled" });
    expect(events.at(-1)).toBe("profile.enabled");
  });

  it("retains early subblock references even when a later raw getter replaces them", () => {
    const raw = { profile: { maxTokens: 11 } };
    const result = parseUserConfigFile({ memory: raw, get webhooks() {
      raw.profile = { maxTokens: 13 };
      return {};
    } });
    expect(raw.profile.maxTokens).toBe(13);
    expect(result.memory.profile.maxTokens).toBe(11);
  });

  it.each([false, "malformed"])("forces all seven pre-v22 feature flags on despite raw %j", (enabled) => {
    const raw = rawFeatureFlags(enabled);
    expect(featureFlags(parseMemory(raw, 21))).toEqual(Array<boolean>(7).fill(true));
    expect(featureFlags(parseUserConfigFile({ version: 21, memory: raw }).memory)).toEqual(Array<boolean>(7).fill(true));
  });

  it("honors explicit false from v22 onward and keeps other enabled fields outside that migration", () => {
    expect(featureFlags(parseMemory(rawFeatureFlags(false), 22))).toEqual(Array<boolean>(7).fill(false));
    expect(featureFlags(parseUserConfigFile({ version: 22, memory: rawFeatureFlags(false) }).memory)).toEqual(Array<boolean>(7).fill(false));
    expect(parseMemory({ profile: { enabled: false }, reflection: { enabled: false } }, 21).profile.enabled).toBe(false);
    expect(thrownError(() => parseMemory({ profile: { enabled: "malformed" } }, 21)))
      .toMatchObject({ field: "memory.profile.enabled" });
  });

  it.each([
    { raw: { links: { enabled: "malformed" } }, field: "memory.links.enabled" },
    { raw: { evolution: { enabled: "malformed" } }, field: "memory.evolution.enabled" },
    { raw: { lessons: { enabled: "malformed" } }, field: "memory.lessons.enabled" },
    { raw: { procedures: { enabled: "malformed" } }, field: "memory.procedures.enabled" },
    { raw: { consolidation: { enabled: "malformed" } }, field: "memory.consolidation.enabled" },
    { raw: { voting: { enabled: "malformed" } }, field: "memory.voting.enabled" },
    { raw: { retrieve: { rewriter: { enabled: "malformed" } } }, field: "memory.retrieve.rewriter.enabled" },
  ])("validates v22 enabled fields at $field", ({ raw, field }) => {
    const reason = 'expected boolean, got "malformed"';
    for (const error of [thrownError(() => parseMemory(raw, 22)), thrownError(() => parseUserConfigFile({ version: 22, memory: raw }))]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it("reads all seven default arguments unconditionally before pre-v22 helper branches", () => {
    const original = USER_CONFIG_DEFAULTS.memory;
    const defaults = createMemoryDefaults();
    const events: string[] = [];
    const features = [
      { name: "links", block: defaults.links }, { name: "evolution", block: defaults.evolution },
      { name: "lessons", block: defaults.lessons }, { name: "procedures", block: defaults.procedures },
      { name: "consolidation", block: defaults.consolidation }, { name: "voting", block: defaults.voting },
      { name: "rewriter", block: defaults.retrieve.rewriter },
    ];
    for (const { name, block } of features) {
      Object.defineProperty(block, "enabled", { get() { events.push(name); return false; } });
    }
    try {
      USER_CONFIG_DEFAULTS.memory = defaults;
      expect(featureFlags(parseUserConfigFile({ version: 21, memory: rawFeatureFlags("malformed") }).memory))
        .toEqual(Array<boolean>(7).fill(true));
      expect(events).toEqual(features.map(({ name }) => name));
      events.length = 0;
      expect(featureFlags(parseMemoryConfig(prepareMemoryInputs(rawFeatureFlags(false)), 22, () => defaults)))
        .toEqual(Array<boolean>(7).fill(false));
      expect(events).toEqual(features.map(({ name }) => name));
    } finally { USER_CONFIG_DEFAULTS.memory = original; }
  });

  it.each([
    { version: 64, expected: [60_000, 60_000, 10_000] },
    { version: 65, expected: [10_000, 8_000, 3_000] },
  ])("migrates exactly the old subcall timeouts at input version $version", ({ version, expected }) => {
    const old = { reflection: { timeoutMs: "10000" }, links: { generatorTimeoutMs: "8e3" }, retrieve: { rewriter: { timeoutMs: 3000 } } };
    expect(timeouts(parseMemory(old, version))).toEqual(expected);
    expect(timeouts(parseUserConfigFile({ version, memory: old }).memory)).toEqual(expected);
    const pinned = { reflection: { timeoutMs: 1234 }, links: { generatorTimeoutMs: 2345 }, retrieve: { rewriter: { timeoutMs: 3456 } } };
    expect(timeouts(parseMemory(pinned, version))).toEqual([1234, 2345, 3456]);
    expect(timeouts(parseUserConfigFile({ version, memory: pinned }).memory)).toEqual([1234, 2345, 3456]);
  });

  it.each([
    { version: 64, explicit: false, reads: 2, expected: [91_000, 92_000, 93_000] },
    { version: 64, explicit: true, reads: 1, expected: [91_000, 92_000, 93_000] },
    { version: 65, explicit: false, reads: 2, expected: [10_000, 8_000, 3_000] },
    { version: 65, explicit: true, reads: 1, expected: [10_000, 8_000, 3_000] },
  ])("preserves repeated current-timeout reads ($version / explicit=$explicit)", ({ version, explicit, reads, expected }) => {
    const original = USER_CONFIG_DEFAULTS.memory;
    const defaults = createMemoryDefaults();
    const counts = [0, 0, 0];
    const fields = [
      { block: defaults.reflection, key: "timeoutMs", old: 10_000, current: 91_000 },
      { block: defaults.links, key: "generatorTimeoutMs", old: 8_000, current: 92_000 },
      { block: defaults.retrieve.rewriter, key: "timeoutMs", old: 3_000, current: 93_000 },
    ];
    fields.forEach(({ block, key, old, current }, index) => {
      let count = 0;
      Object.defineProperty(block, key, { get() {
        count += 1;
        counts[index] = count;
        return !explicit && count === 1 ? old : current;
      } });
    });
    const raw = explicit ? { reflection: { timeoutMs: 10_000 }, links: { generatorTimeoutMs: 8_000 }, retrieve: { rewriter: { timeoutMs: 3_000 } } } : {};
    try {
      USER_CONFIG_DEFAULTS.memory = defaults;
      expect(timeouts(parseUserConfigFile({ version, memory: raw }).memory)).toEqual(expected);
      expect(counts).toEqual([reads, reads, reads]);
    } finally { USER_CONFIG_DEFAULTS.memory = original; }
  });

  it("rejects an invalid timeout before evaluating the migration's current-default argument", () => {
    const original = USER_CONFIG_DEFAULTS.memory;
    const defaults = createMemoryDefaults();
    let reads = 0;
    Object.defineProperty(defaults.reflection, "timeoutMs", { get() { reads += 1; throw new Error("must not reach migration default"); } });
    try {
      USER_CONFIG_DEFAULTS.memory = defaults;
      const error = thrownError(() => parseUserConfigFile({ version: 64, memory: { reflection: { timeoutMs: 0 } } }));
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field: "memory.reflection.timeoutMs", reason: "expected positive integer, got 0" });
      expect(reads).toBe(0);
    } finally { USER_CONFIG_DEFAULTS.memory = original; }
  });

  it("short-circuits explicit scalar defaults except the seven feature and three timeout arguments", () => {
    const defaults = createMemoryDefaults();
    const raw = {
      ...createMemoryDefaults(),
      retrieve: { rewriter: {
        ...defaults.retrieve.rewriter,
        embeddingGate: { ...defaults.retrieve.rewriter.embeddingGate, exemplars: [] },
      } },
    };
    let reads = 0;
    const parsed = parseMemoryConfig(prepareMemoryInputs(raw), 65, () => {
      reads += 1;
      return defaults;
    });
    expect(parsed).toStrictEqual(raw);
    expect(reads).toBe(10);
  });

  it("observes nested and whole-memory replacements within one late parse", () => {
    const original = USER_CONFIG_DEFAULTS.memory;
    const first = createMemoryDefaults();
    const second = createMemoryDefaults();
    second.profile.maxTokens = 129;
    second.reflection.enabled = false;
    second.notes.recallDefaultK = 2;
    const events: string[] = [];
    try {
      USER_CONFIG_DEFAULTS.memory = first;
      const result = parseUserConfigFile({ memory: { profile: {
        get enabled() { events.push("nested replacement"); USER_CONFIG_DEFAULTS.memory.profile = { ...first.profile, enabled: false }; return undefined; },
        get maxTokens() { events.push("whole replacement"); USER_CONFIG_DEFAULTS.memory = second; return undefined; },
      } } }).memory;
      expect(events).toEqual(["nested replacement", "whole replacement"]);
      expect(result.profile.enabled).toBe(false);
      expect(result.profile.maxTokens).toBe(129);
      expect(result.reflection.enabled).toBe(false);
      expect(result.notes.recallDefaultK).toBe(2);
      expect(result.profile).not.toBe(second.profile);
      second.profile.maxTokens = 131;
      expect(result.profile.maxTokens).toBe(129);
    } finally { USER_CONFIG_DEFAULTS.memory = original; }
  });

  it("preserves zero allowances, independent weights and duplicate exemplar data", () => {
    const raw = {
      reflection: { maxNotesPerCall: 0 }, recallInjection: { k: 0 }, index: { limit: 0 },
      embeddings: { enabled: false, fts5Weight: 1, vectorWeight: 1 },
      voting: { eventLogMaxRows: 0, signalDecay: 1, scoreBlend: 0 },
      retrieve: { rewriter: { embeddingGate: { threshold: 0, exemplars: [" ", "duplicate", "duplicate"] } } },
    };
    const parsed = parseMemory(raw);
    expect(parseUserConfigFile({ memory: raw }).memory).toStrictEqual(parsed);
    expect(parsed.reflection.maxNotesPerCall).toBe(0);
    expect(parsed.recallInjection.k).toBe(0);
    expect(parsed.index.limit).toBe(0);
    expect(parsed.voting.eventLogMaxRows).toBe(0);
    expect(parsed.embeddings.fts5Weight + parsed.embeddings.vectorWeight).toBe(2);
    expect(parsed.retrieve.rewriter.embeddingGate.exemplars).toEqual([" ", "duplicate", "duplicate"]);
    expect(parseMemory({ retrieve: { rewriter: { embeddingGate: { exemplars: [] } } } }).retrieve.rewriter.embeddingGate.exemplars).toEqual([]);
    expect(parseMemory({ retrieve: { rewriter: { embeddingGate: { exemplars: null } } } }).retrieve.rewriter.embeddingGate.exemplars).toBeNull();
  });

  it.each([
    { raw: { profile: { maxEntries: 0 } }, field: "memory.profile.maxEntries", reason: "expected positive integer, got 0" },
    { raw: { voting: { signalDecay: 0 } }, field: "memory.voting.signalDecay", reason: "expected number in (0, 1], got 0" },
    { raw: { embeddings: { enabled: false, fts5Weight: 2 } }, field: "memory.embeddings.fts5Weight", reason: "expected number in [0, 1], got 2" },
  ])("preserves exceptional bound semantics for $field", ({ raw, field, reason }) => {
    for (const error of [thrownError(() => parseMemory(raw)), thrownError(() => parseUserConfigFile({ memory: raw }))]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it.each([false, 42, "primitive", [], new Date(0)])("retains permissive memory block lookup (%j)", (raw) => {
    expect(parseUserConfigFile({ memory: raw }).memory).toStrictEqual(createMemoryDefaults());
    expect(parseUserConfigFile({ memory: { profile: raw, retrieve: { rewriter: raw } } }).memory).toStrictEqual(createMemoryDefaults());
  });

  it.each([
    { raw: { webhooks: [] }, field: "webhooks" },
    { raw: { localModels: { mode: "bad" } }, field: "localModels.mode" },
    { raw: { agent: { tokenBudget: 0 } }, field: "agent.tokenBudget" },
    { raw: { http: { enabled: "bad" } }, field: "http.enabled" },
    { raw: { web: { search: { maxResults: 0 } } }, field: "web.search.maxResults" },
    { raw: { tracing: { trace: { enabled: "bad" } } }, field: "tracing.trace.enabled" },
    { raw: { vision: { enabled: "bad" } }, field: "memory.profile.maxTokens" },
  ])("keeps memory's late validation position relative to $field", ({ raw, field }) => {
    expect(thrownError(() => parseUserConfigFile({ ...raw, memory: { profile: { maxTokens: 0 } } })))
      .toMatchObject({ field });
  });
});
