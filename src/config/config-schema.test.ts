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
      localModels: { url: "http://localhost:18991" },
      log: { level: "debug" },
      agent: {
        tokenBudget: 3000,
        maxSteps: 10,
        toolTimeoutMs: 45000,
        approvalRequired: false,
      },
    });
    expect(parsed.localModels.url).toBe("http://localhost:18991");
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

  it("rejects legacy v1/v2/v3/v4 input — migration is not supported", () => {
    expect(() => parseUserConfigFile({ version: 1 })).toThrow(
      ConfigValidationError,
    );
    expect(() => parseUserConfigFile({ version: 4 })).toThrow(
      ConfigValidationError,
    );
  });

  it("accepts a v5 file and fills in vision.* defaults transparently", () => {
    const parsed = parseUserConfigFile({ version: 5 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.vision).toEqual(USER_CONFIG_DEFAULTS.vision);
  });

  it("applies vision defaults when the section is absent", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.vision).toEqual(USER_CONFIG_DEFAULTS.vision);
  });

  it("accepts user-supplied vision overrides", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      vision: {
        enabled: false,
        autoDetect: false,
        maxImageBytes: 2_097_152,
        maxImagesPerCall: 1,
      },
    });
    expect(parsed.vision).toEqual({
      enabled: false,
      autoDetect: false,
      maxImageBytes: 2_097_152,
      maxImagesPerCall: 1,
    });
  });

  it("rejects vision.maxImageBytes <= 0", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        vision: { maxImageBytes: 0 },
      }),
    ).toThrow(ConfigValidationError);
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
        localModels: { url: "not a url" },
      }),
    ).toThrow(/localModels.url/);
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

  it("fills in localModels defaults when only url is provided", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      localModels: { url: "http://custom:9000" },
    });
    expect(parsed.localModels.mode).toBe("external");
    expect(parsed.localModels.url).toBe("http://custom:9000");
    expect(parsed.localModels.managed).toEqual(
      USER_CONFIG_DEFAULTS.localModels.managed,
    );
  });

  it("rejects invalid localModels.mode", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        localModels: { mode: "bogus" },
      }),
    ).toThrow(/localModels.mode/);
  });

  it("rejects unknown localModels.managed.modelId", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        localModels: { managed: { modelId: "glm-4.7-flash-30b" } },
      }),
    ).toThrow(/localModels.managed.modelId/);
  });

  it("applies skills defaults when the section is absent", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.skills).toEqual(USER_CONFIG_DEFAULTS.skills);
  });

  it("accepts a v7 file and fills in skills.* defaults transparently", () => {
    const parsed = parseUserConfigFile({ version: 7 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.skills).toEqual(USER_CONFIG_DEFAULTS.skills);
  });

  it("preserves a non-empty skills.disabled list and dedupes duplicates", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      skills: { disabled: ["apple-notes", "obsidian", "apple-notes"] },
    });
    expect(parsed.skills.disabled).toEqual(["apple-notes", "obsidian"]);
  });

  it("rejects invalid skills.disabled entries", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: ["Apple-Notes"] },
      }),
    ).toThrow(/skills.disabled\[0\]/);
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: [""] },
      }),
    ).toThrow(/skills.disabled\[0\]/);
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: "obsidian" },
      }),
    ).toThrow(/skills.disabled/);
  });

  it("applies telegram defaults when the section is absent", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.telegram).toEqual(USER_CONFIG_DEFAULTS.telegram);
  });

  it("accepts a v8 file and fills in telegram.* defaults transparently", () => {
    const parsed = parseUserConfigFile({ version: 8 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.telegram).toEqual(USER_CONFIG_DEFAULTS.telegram);
  });

  it("preserves a configured telegram block", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telegram: { enabled: true, ownerUserId: 12345678 },
    });
    expect(parsed.telegram).toEqual({ enabled: true, ownerUserId: 12345678 });
  });

  it("accepts a numeric-string telegram.ownerUserId", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telegram: { enabled: true, ownerUserId: "12345678" },
    });
    expect(parsed.telegram.ownerUserId).toBe(12345678);
  });

  it("rejects a non-positive telegram.ownerUserId", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        telegram: { enabled: true, ownerUserId: 0 },
      }),
    ).toThrow(/telegram.ownerUserId/);
  });

  it("rejects a non-integer telegram.ownerUserId", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        telegram: { enabled: true, ownerUserId: 3.14 },
      }),
    ).toThrow(/telegram.ownerUserId/);
  });
});
