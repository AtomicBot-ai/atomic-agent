import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  parseUserConfigFile,
} from "./config-schema.js";

describe("parseUserConfigFile", () => {
  it("returns defaults when all fields are missing", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed).toEqual(USER_CONFIG_DEFAULTS);
  });

  it("accepts a fully specified config and normalises it", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llama: { url: "http://localhost:18991" },
      log: { level: "debug" },
      agent: {
        tokenBudget: 3000,
        maxSteps: 10,
        toolTimeoutMs: 45000,
        approvalRequired: false,
      },
    });
    expect(parsed.llama.url).toBe("http://localhost:18991");
    expect(parsed.log.level).toBe("debug");
    expect(parsed.agent.tokenBudget).toBe(3000);
    expect(parsed.agent.approvalRequired).toBe(false);
  });

  it("coerces boolean-ish strings for approvalRequired", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      agent: { approvalRequired: "false" },
    });
    expect(parsed.agent.approvalRequired).toBe(false);
  });

  it("rejects unsupported version", () => {
    expect(() => parseUserConfigFile({ version: 99 })).toThrow(
      ConfigValidationError,
    );
  });

  it("accepts legacy v1 input and upgrades it to the current version", () => {
    const parsed = parseUserConfigFile({ version: 1 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.memory.notes.enabled).toBe(
      USER_CONFIG_DEFAULTS.memory.notes.enabled,
    );
    expect(parsed.memory.notes.maxEntries).toBe(
      USER_CONFIG_DEFAULTS.memory.notes.maxEntries,
    );
  });

  it("applies memory.notes defaults when the section is absent", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.memory.notes).toEqual(USER_CONFIG_DEFAULTS.memory.notes);
  });

  it("accepts user-supplied memory.notes overrides", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: {
        notes: {
          enabled: false,
          maxEntries: 50,
          maxContentChars: 1_000,
          recallDefaultK: 3,
        },
      },
    });
    expect(parsed.memory.notes).toEqual({
      enabled: false,
      maxEntries: 50,
      maxContentChars: 1_000,
      recallDefaultK: 3,
    });
  });

  it("rejects non-positive memory.notes.maxEntries", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { notes: { maxEntries: 0 } },
      }),
    ).toThrow(/memory.notes.maxEntries/);
  });

  it("rejects invalid log level", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        log: { level: "loud" },
      }),
    ).toThrow(/log.level/);
  });

  it("rejects invalid URL", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llama: { url: "not a url" },
      }),
    ).toThrow(/llama.url/);
  });

  it("rejects non-positive tokenBudget", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        agent: { tokenBudget: 0 },
      }),
    ).toThrow(/agent.tokenBudget/);
  });

  it("applies safety-net caps from defaults when unspecified", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.agent.conversationMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.agent.conversationMaxTokens,
    );
    expect(parsed.agent.worldSnapshotMaxTokens).toBe(
      USER_CONFIG_DEFAULTS.agent.worldSnapshotMaxTokens,
    );
  });

  it("accepts user-supplied conversation and world caps", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      agent: {
        conversationMaxTokens: 16_000,
        worldSnapshotMaxTokens: 4_000,
      },
    });
    expect(parsed.agent.conversationMaxTokens).toBe(16_000);
    expect(parsed.agent.worldSnapshotMaxTokens).toBe(4_000);
  });

  it("rejects non-positive conversationMaxTokens", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        agent: { conversationMaxTokens: 0 },
      }),
    ).toThrow(/agent.conversationMaxTokens/);
  });

  it("rejects non-object root", () => {
    expect(() => parseUserConfigFile([])).toThrow(ConfigValidationError);
    expect(() => parseUserConfigFile(null)).toThrow(ConfigValidationError);
    expect(() => parseUserConfigFile("oops")).toThrow(ConfigValidationError);
  });

  it("applies tracing.trace defaults when unspecified", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.tracing.trace.enabled).toBeNull();
    expect(parsed.tracing.trace.maxBytesPerSession).toBe(
      USER_CONFIG_DEFAULTS.tracing.trace.maxBytesPerSession,
    );
  });

  it("accepts explicit tracing.trace.enabled values", () => {
    const on = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tracing: { trace: { enabled: true } },
    });
    expect(on.tracing.trace.enabled).toBe(true);
    const off = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tracing: { trace: { enabled: false } },
    });
    expect(off.tracing.trace.enabled).toBe(false);
  });

  it("accepts custom tracing.trace.maxBytesPerSession", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tracing: { trace: { maxBytesPerSession: 2_097_152 } },
    });
    expect(parsed.tracing.trace.maxBytesPerSession).toBe(2_097_152);
  });

  it("rejects non-positive tracing.trace.maxBytesPerSession", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        tracing: { trace: { maxBytesPerSession: 0 } },
      }),
    ).toThrow(/tracing.trace.maxBytesPerSession/);
  });

  it("reads legacy telemetry.* as an alias of tracing.* (tracing wins on overlap)", () => {
    const fromLegacy = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telemetry: { trace: { enabled: false, maxBytesPerSession: 4096 } },
    });
    expect(fromLegacy.tracing.trace.enabled).toBe(false);
    expect(fromLegacy.tracing.trace.maxBytesPerSession).toBe(4096);
    const tracingWins = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telemetry: { trace: { enabled: false, maxBytesPerSession: 1 } },
      tracing: { trace: { enabled: true, maxBytesPerSession: 2_097_152 } },
    });
    expect(tracingWins.tracing.trace.enabled).toBe(true);
    expect(tracingWins.tracing.trace.maxBytesPerSession).toBe(2_097_152);
  });

  it("applies memory.reflection.autoStoreNotes + maxNotesPerCall defaults", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.memory.reflection.autoStoreNotes).toBe(
      USER_CONFIG_DEFAULTS.memory.reflection.autoStoreNotes,
    );
    expect(parsed.memory.reflection.maxNotesPerCall).toBe(
      USER_CONFIG_DEFAULTS.memory.reflection.maxNotesPerCall,
    );
  });

  it("accepts explicit memory.reflection note overrides", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: {
        reflection: { autoStoreNotes: false, maxNotesPerCall: 0 },
      },
    });
    expect(parsed.memory.reflection.autoStoreNotes).toBe(false);
    expect(parsed.memory.reflection.maxNotesPerCall).toBe(0);
  });

  it("rejects negative memory.reflection.maxNotesPerCall", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { reflection: { maxNotesPerCall: -1 } },
      }),
    ).toThrow(/memory.reflection.maxNotesPerCall/);
  });
});
