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

  it("accepts a v9 file and fills in telegram.parseMode='html' transparently", () => {
    const parsed = parseUserConfigFile({
      version: 9,
      telegram: { enabled: true, ownerUserId: 12345678 },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.telegram).toEqual({
      enabled: true,
      ownerUserId: 12345678,
      parseMode: "html",
    });
  });

  it("preserves a configured telegram block including parseMode", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telegram: { enabled: true, ownerUserId: 12345678, parseMode: "plain" },
    });
    expect(parsed.telegram).toEqual({
      enabled: true,
      ownerUserId: 12345678,
      parseMode: "plain",
    });
  });

  it("rejects an unknown telegram.parseMode", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        telegram: { enabled: true, ownerUserId: 1, parseMode: "markdownV2" },
      }),
    ).toThrow(/telegram.parseMode/);
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

  it("defaults telegram.parseMode to 'html' when absent", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telegram: { enabled: true, ownerUserId: 1 },
    });
    expect(parsed.telegram.parseMode).toBe("html");
  });

  it("applies memory.voting defaults when the section is absent", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.memory.voting).toEqual(USER_CONFIG_DEFAULTS.memory.voting);
    expect(parsed.memory.voting.enabled).toBe(false);
  });

  it("accepts user-supplied memory.voting overrides", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: {
        voting: {
          enabled: true,
          maxVotePerItem: 100,
          signalDecay: 0.9,
          scoreBlend: 0.5,
          eventLogMaxRows: 10_000,
          profileFilterThreshold: 5,
        },
      },
    });
    expect(parsed.memory.voting).toEqual({
      enabled: true,
      maxVotePerItem: 100,
      signalDecay: 0.9,
      scoreBlend: 0.5,
      eventLogMaxRows: 10_000,
      profileFilterThreshold: 5,
    });
  });

  // Scorecard 7a.C.3 — bootstrap fails fast on a non-positive vote clamp.
  it("rejects memory.voting.maxVotePerItem <= 0 (scorecard 7a.C.3)", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { maxVotePerItem: 0 } },
      }),
    ).toThrow(/memory\.voting\.maxVotePerItem/);
  });

  // Scorecard 7a.C.4 — bootstrap fails fast on a decay outside (0, 1].
  it("rejects memory.voting.signalDecay > 1 (scorecard 7a.C.4)", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { signalDecay: 1.5 } },
      }),
    ).toThrow(/memory\.voting\.signalDecay/);
  });

  it("rejects memory.voting.signalDecay = 0", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { signalDecay: 0 } },
      }),
    ).toThrow(/memory\.voting\.signalDecay/);
  });

  it("accepts memory.voting.signalDecay = 1 (decay disabled)", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: { voting: { signalDecay: 1 } },
    });
    expect(parsed.memory.voting.signalDecay).toBe(1);
  });

  it("rejects memory.voting.scoreBlend outside [0, 1]", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { scoreBlend: 1.2 } },
      }),
    ).toThrow(/memory\.voting\.scoreBlend/);
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { scoreBlend: -0.1 } },
      }),
    ).toThrow(/memory\.voting\.scoreBlend/);
  });

  it("accepts memory.voting.eventLogMaxRows = 0 (disables FIFO eviction)", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: { voting: { eventLogMaxRows: 0 } },
    });
    expect(parsed.memory.voting.eventLogMaxRows).toBe(0);
  });

  it("rejects negative memory.voting.eventLogMaxRows", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { voting: { eventLogMaxRows: -1 } },
      }),
    ).toThrow(/memory\.voting\.eventLogMaxRows/);
  });

  // --------------------------------------------------------------------------
  // v2.5 memory fabric additions (config v18)
  // --------------------------------------------------------------------------

  it("transparently migrates v17 → v18 with all three new blocks defaulting to disabled", () => {
    const parsed = parseUserConfigFile({ version: 17 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.memory.reflection.typedNotes.enabled).toBe(false);
    expect(parsed.memory.reflection.segmentation.enabled).toBe(false);
    expect(parsed.memory.retrieve.rewriter.enabled).toBe(false);
  });

  it("parses memory.reflection.typedNotes.enabled", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: { reflection: { typedNotes: { enabled: true } } },
    });
    expect(parsed.memory.reflection.typedNotes.enabled).toBe(true);
  });

  it("parses memory.reflection.segmentation block end-to-end", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: {
        reflection: {
          segmentation: { enabled: true, triggerEveryTurns: 5, windowTurns: 8 },
        },
      },
    });
    expect(parsed.memory.reflection.segmentation).toEqual({
      enabled: true,
      triggerEveryTurns: 5,
      windowTurns: 8,
    });
  });

  it("rejects non-positive memory.reflection.segmentation.triggerEveryTurns", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { reflection: { segmentation: { triggerEveryTurns: 0 } } },
      }),
    ).toThrow(/triggerEveryTurns/);
  });

  it("transparently migrates v19 → v20 with rewriter gate defaults", () => {
    const parsed = parseUserConfigFile({ version: 19 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.memory.retrieve.rewriter.gateMode).toBe("heuristic");
    expect(parsed.memory.retrieve.rewriter.embeddingGate.threshold).toBe(0.65);
    expect(parsed.memory.retrieve.rewriter.embeddingGate.exemplars).toBeNull();
  });

  it("parses memory.retrieve.rewriter block end-to-end", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: {
        retrieve: {
          rewriter: {
            enabled: true,
            timeoutMs: 5_000,
            historyTurns: 2,
            gateMode: "embedding",
            embeddingGate: { threshold: 0.7, exemplars: ["tell me more"] },
          },
        },
      },
    });
    expect(parsed.memory.retrieve.rewriter).toEqual({
      enabled: true,
      timeoutMs: 5_000,
      historyTurns: 2,
      gateMode: "embedding",
      embeddingGate: { threshold: 0.7, exemplars: ["tell me more"] },
    });
  });

  it("rejects invalid memory.retrieve.rewriter.gateMode", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { retrieve: { rewriter: { gateMode: "magic" } } },
      }),
    ).toThrow(/gateMode/);
  });

  it("rejects non-positive memory.retrieve.rewriter.timeoutMs", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        memory: { retrieve: { rewriter: { timeoutMs: 0 } } },
      }),
    ).toThrow(/timeoutMs/);
  });
});
