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
        approvalLevel: 5,
      },
    });
    expect(parsed.localModels.url).toBe("http://localhost:18991");
    expect(parsed.log.level).toBe("debug");
    expect(parsed.agent.tokenBudget).toBe(3000);
    expect(parsed.agent.approvalLevel).toBe(5);
  });

  it("defaults agent.approvalLevel to 1 (ask for everything)", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.agent.approvalLevel).toBe(1);
  });

  it("migrates legacy agent.approvalRequired: false to level 5", () => {
    const parsed = parseUserConfigFile({
      version: 36,
      agent: { approvalRequired: false },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.agent.approvalLevel).toBe(5);
    // The legacy key is read once and never written back.
    expect("approvalRequired" in parsed.agent).toBe(false);
  });

  it("migrates legacy agent.approvalRequired: true (and string forms) to level 1", () => {
    expect(
      parseUserConfigFile({ version: 36, agent: { approvalRequired: true } })
        .agent.approvalLevel,
    ).toBe(1);
    expect(
      parseUserConfigFile({ version: 36, agent: { approvalRequired: "false" } })
        .agent.approvalLevel,
    ).toBe(5);
  });

  it("prefers agent.approvalLevel over a stale legacy approvalRequired", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      agent: { approvalLevel: 3, approvalRequired: false },
    });
    expect(parsed.agent.approvalLevel).toBe(3);
  });

  it("rejects out-of-range or non-integer agent.approvalLevel", () => {
    for (const bad of [0, 6, 2.5, "3", true]) {
      expect(() =>
        parseUserConfigFile({
          version: USER_CONFIG_VERSION,
          agent: { approvalLevel: bad },
        }),
      ).toThrow(ConfigValidationError);
    }
    // null means "unset": falls back through the migration to level 1.
    expect(
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        agent: { approvalLevel: null },
      }).agent.approvalLevel,
    ).toBe(1);
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

  it("fills web.search defaults when migrating from v26", () => {
    const parsed = parseUserConfigFile({ version: 26 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.web.search).toEqual(USER_CONFIG_DEFAULTS.web.search);
  });

  it("accepts user-supplied web search provider overrides", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      web: {
        search: {
          provider: "searxng",
          maxResults: 6,
          timeoutMs: 12_000,
          searxng: { instanceUrl: "https://search.example.com" },
        },
      },
    });
    expect(parsed.web.search.provider).toBe("searxng");
    expect(parsed.web.search.maxResults).toBe(6);
    expect(parsed.web.search.timeoutMs).toBe(12_000);
    expect(parsed.web.search.searxng.instanceUrl).toBe(
      "https://search.example.com",
    );
  });

  it("rejects an unknown web search provider", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        web: { search: { provider: "google" } },
      }),
    ).toThrow(/web.search.provider/);
  });

  it("fills cacheTtlMinutes/fallback defaults when migrating from v27", () => {
    const parsed = parseUserConfigFile({ version: 27 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.web.search.cacheTtlMinutes).toBe(15);
    expect(parsed.web.search.provider).toBe("exa");
    expect(parsed.web.search.fallback).toEqual(["duckduckgo"]);
  });

  it("fills tui.theme default 'auto' when migrating from v28", () => {
    const parsed = parseUserConfigFile({ version: 28 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.tui.theme).toBe("auto");
  });

  it("fills web.fetch defaults when migrating from v37", () => {
    const parsed = parseUserConfigFile({
      version: 37,
      web: { search: { provider: "exa", timeoutMs: 15_000 } },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.web.fetch.timeoutMs).toBe(30_000);
    expect(parsed.web.fetch.connectTimeoutMs).toBe(10_000);
    expect(parsed.web.fetch.maxRetries).toBe(2);
    // The version bump must not drop the settings a v37 file already carried.
    expect(parsed.web.search.timeoutMs).toBe(15_000);
  });

  it("accepts every version between the oldest supported and the current one", () => {
    // A bump that forgets to append the outgoing version to the supported
    // list locks out everyone whose config is still on it.
    for (let version = 5; version <= USER_CONFIG_VERSION; version += 1) {
      expect(() => parseUserConfigFile({ version })).not.toThrow();
    }
  });

  it("preserves an explicit tui.theme name", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { theme: "dracula" },
    });
    expect(parsed.tui.theme).toBe("dracula");
  });

  it("normalises a blank tui.theme back to 'auto'", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { theme: "   " },
    });
    expect(parsed.tui.theme).toBe("auto");
  });

  it("enables tui.mouse by default when migrating from v37", () => {
    const parsed = parseUserConfigFile({ version: 37 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.tui.mouse).toBe(true);
  });

  it("preserves tui.mouse: false so an operator's opt-out survives", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { theme: "auto", mouse: false },
    });
    expect(parsed.tui.mouse).toBe(false);
  });

  it("accepts the string forms parseBool understands for tui.mouse", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { mouse: "off" },
    });
    expect(parsed.tui.mouse).toBe(false);
  });

  it("rejects a non-boolean tui.mouse", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        tui: { mouse: 42 },
      }),
    ).toThrow(/tui.mouse/);
  });

  it("rejects a non-string tui.theme", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        tui: { theme: 42 },
      }),
    ).toThrow(/tui.theme/);
  });

  it("keeps an explicit empty fallback (disables the default Exa->DDG degrade)", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      web: { search: { provider: "exa", fallback: [] } },
    });
    expect(parsed.web.search.fallback).toEqual([]);
  });

  it("accepts cacheTtlMinutes and a deduped fallback chain (dropping the primary)", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      web: {
        search: {
          provider: "duckduckgo",
          cacheTtlMinutes: 30,
          fallback: ["exa", "duckduckgo", "exa", "searxng"],
        },
      },
    });
    expect(parsed.web.search.cacheTtlMinutes).toBe(30);
    // primary (duckduckgo) dropped, duplicate exa collapsed
    expect(parsed.web.search.fallback).toEqual(["exa", "searxng"]);
  });

  it("allows cacheTtlMinutes = 0 (cache disabled)", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      web: { search: { cacheTtlMinutes: 0 } },
    });
    expect(parsed.web.search.cacheTtlMinutes).toBe(0);
  });

  it("rejects an out-of-range cacheTtlMinutes", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        web: { search: { cacheTtlMinutes: 5000 } },
      }),
    ).toThrow(/web.search.cacheTtlMinutes/);
  });

  it("rejects an invalid fallback entry", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        web: { search: { fallback: ["exa", "google"] } },
      }),
    ).toThrow(/web.search.fallback/);
  });

  it("rejects a non-array fallback", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        web: { search: { fallback: "exa" } },
      }),
    ).toThrow(/web.search.fallback/);
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

  it("defaults localModels.managed.device to 'auto'", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.localModels.managed.device).toBe("auto");
  });

  it("defaults localModels.managed.stopOnExit to true", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed.localModels.managed.stopOnExit).toBe(true);
  });

  it("preserves an explicit localModels.managed.stopOnExit=false", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      localModels: { managed: { stopOnExit: false } },
    });
    expect(parsed.localModels.managed.stopOnExit).toBe(false);
  });

  it("accepts a v33 file and fills in stopOnExit=true transparently", () => {
    const parsed = parseUserConfigFile({
      version: 33,
      localModels: { managed: { autoUpdate: true } },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.localModels.managed.stopOnExit).toBe(true);
    expect(parsed.localModels.managed.autoUpdate).toBe(true);
  });

  it("preserves an explicit localModels.managed.device override", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      localModels: { managed: { device: "Vulkan0" } },
    });
    expect(parsed.localModels.managed.device).toBe("Vulkan0");
  });

  it("migrates a v25 file by filling localModels.managed.device='auto'", () => {
    const parsed = parseUserConfigFile({ version: 25 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.localModels.managed.device).toBe("auto");
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

  it("fills skills.taps defaults on a v29 file (transparent v29 -> v30)", () => {
    const parsed = parseUserConfigFile({
      version: 29,
      skills: { disabled: [] },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.skills.taps).toEqual(USER_CONFIG_DEFAULTS.skills.taps);
  });

  it("preserves a custom skills.taps list and dedupes duplicates", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      skills: {
        disabled: [],
        taps: ["my-org/skills", "my-org/skills", "openai/skills"],
      },
    });
    expect(parsed.skills.taps).toEqual(["my-org/skills", "openai/skills"]);
  });

  it("rejects invalid skills.taps entries", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: [], taps: ["not-a-repo"] },
      }),
    ).toThrow(/skills.taps\[0\]/);
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        skills: { disabled: [], taps: "openai/skills" },
      }),
    ).toThrow(/skills.taps/);
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
      progressIndicator: true,
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
      progressIndicator: true,
    });
  });

  it("accepts a v33 file and fills in telegram.progressIndicator=true transparently", () => {
    const parsed = parseUserConfigFile({
      version: 33,
      telegram: { enabled: true, ownerUserId: 12345678, parseMode: "plain" },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.telegram.progressIndicator).toBe(true);
  });

  it("accepts a v35 file and fills in projects.roots=[] transparently", () => {
    const parsed = parseUserConfigFile({ version: 35 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.projects).toEqual({ roots: [] });
  });

  it("preserves explicit projects.roots entries", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      projects: { roots: ["~/dev", "/data/projects"] },
    });
    expect(parsed.projects.roots).toEqual(["~/dev", "/data/projects"]);
  });

  it("rejects a non-array projects.roots", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        projects: { roots: "~/dev" },
      }),
    ).toThrow(/projects\.roots/);
  });

  it("preserves an explicit telegram.progressIndicator=false", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      telegram: {
        enabled: true,
        ownerUserId: 12345678,
        parseMode: "plain",
        progressIndicator: false,
      },
    });
    expect(parsed.telegram.progressIndicator).toBe(false);
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
    expect(parsed.memory.voting.enabled).toBe(true);
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

  it("transparently migrates v17 → v22 with advanced memory layers + links enabled", () => {
    const parsed = parseUserConfigFile({ version: 17 });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.memory.evolution.enabled).toBe(true);
    expect(parsed.memory.lessons.enabled).toBe(true);
    expect(parsed.memory.procedures.enabled).toBe(true);
    expect(parsed.memory.consolidation.enabled).toBe(true);
    expect(parsed.memory.voting.enabled).toBe(true);
    expect(parsed.memory.retrieve.rewriter.enabled).toBe(true);
    expect(parsed.memory.links.enabled).toBe(true);
    expect(parsed.memory.embeddings.enabled).toBe(false);
    expect(parsed.localModels.embeddings.enabled).toBe(false);
    expect(parsed.memory.reflection.typedNotes.enabled).toBe(false);
    expect(parsed.memory.reflection.segmentation.enabled).toBe(false);
  });

  it("migrates v20 → v22 enabling memory-v2 layers that were false on disk", () => {
    const parsed = parseUserConfigFile({
      version: 20,
      memory: {
        evolution: { enabled: false },
        lessons: { enabled: false },
        procedures: { enabled: false },
        consolidation: { enabled: false },
        voting: { enabled: false },
        retrieve: { rewriter: { enabled: false } },
      },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.memory.evolution.enabled).toBe(true);
    expect(parsed.memory.lessons.enabled).toBe(true);
    expect(parsed.memory.procedures.enabled).toBe(true);
    expect(parsed.memory.consolidation.enabled).toBe(true);
    expect(parsed.memory.voting.enabled).toBe(true);
    expect(parsed.memory.retrieve.rewriter.enabled).toBe(true);
    expect(parsed.memory.links.enabled).toBe(true);
    expect(parsed.memory.embeddings.enabled).toBe(false);
    expect(parsed.localModels.embeddings.enabled).toBe(false);
  });

  it("migrates v21 → v22 enabling links but leaving embeddings off by default", () => {
    const parsed = parseUserConfigFile({
      version: 21,
      memory: {
        links: { enabled: false },
        embeddings: { enabled: false },
      },
      localModels: {
        embeddings: { enabled: false, modelId: null },
      },
    });
    expect(parsed.memory.links.enabled).toBe(true);
    expect(parsed.memory.embeddings.enabled).toBe(false);
    expect(parsed.localModels.embeddings.enabled).toBe(false);
  });

  it("transparently migrates v23 → v24 (MCP block preserved, version bumped)", () => {
    const parsed = parseUserConfigFile({
      version: 23,
      mcp: {
        servers: [
          {
            name: "github",
            enabled: true,
            transport: { kind: "stdio", command: "npx", args: ["-y", "mcp"] },
          },
        ],
      },
    });
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.mcp.servers).toHaveLength(1);
    expect(parsed.mcp.servers[0]?.name).toBe("github");
  });

  it("v22 honours explicit memory.lessons.enabled=false", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      memory: { lessons: { enabled: false } },
    });
    expect(parsed.memory.lessons.enabled).toBe(false);
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

describe("tui.whileBusySubmit", () => {
  it("defaults to steer for a config file that predates the key", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { theme: "auto" },
    });
    expect(parsed.tui.whileBusySubmit).toBe("steer");
  });

  it("round-trips an explicit queue preference", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      tui: { theme: "nord", whileBusySubmit: "queue" },
    });
    expect(parsed.tui.whileBusySubmit).toBe("queue");
    expect(parsed.tui.theme).toBe("nord");
  });

  it("rejects an unknown mode instead of silently defaulting", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        tui: { theme: "auto", whileBusySubmit: "interrupt" },
      }),
    ).toThrow(/whileBusySubmit/);
  });
});

