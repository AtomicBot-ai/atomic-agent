import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILLS_CATALOG_BUDGET,
  createSkillsDefaults,
  parseSkillsConfig,
  parseClawHubConfigWithDefaults,
  parseSkillNameArray,
  parseSkillTapArray,
} from "./skills-config.js";
import { createSessionDefaults, parseSessionConfig } from "./session-retention-config.js";
import { createTracingDefaults, parseTracingConfig } from "./tracing-config.js";
import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  ENV_DEFAULTS,
  parseUserConfigFile,
  parseClawHubConfig,
  parseSkillNameArray as rootNames,
  parseSkillTapArray as rootTaps,
} from "./config-schema.js";

function validation(run: () => unknown): ConfigValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error("Expected a configuration validation error");
}

describe("resource configuration ownership", () => {
  it("preserves root pure exports, shared budget and composing output", () => {
    expect(rootNames).toBe(parseSkillNameArray);
    expect(rootTaps).toBe(parseSkillTapArray);
    expect(ENV_DEFAULTS.SKILLS_CATALOG_BUDGET).toBe(DEFAULT_SKILLS_CATALOG_BUDGET);
    const parsed = parseUserConfigFile({});
    expect(parsed.skills).toEqual(createSkillsDefaults());
    expect(parsed.sessions).toEqual(createSessionDefaults());
    expect(parsed.tracing).toEqual(createTracingDefaults());
  });

  it("constructs fresh nested defaults without sharing skill source arrays", () => {
    const a = createSkillsDefaults();
    const b = createSkillsDefaults();
    expect(a).not.toBe(b);
    expect(a.disabled).not.toBe(b.disabled);
    expect(a.taps).not.toBe(b.taps);
    expect(a.clawhub).not.toBe(b.clawhub);
    a.taps.push("changed/repo");
    a.clawhub.apiBase = "ftp://changed/";
    expect(createSkillsDefaults()).toEqual(b);
    expect(createSessionDefaults().retention).not.toBe(createSessionDefaults().retention);
    expect(createTracingDefaults().trace).not.toBe(createTracingDefaults().trace);
  });

  it("normalizes skill lists without case folding or changing source URL policy", () => {
    expect(parseSkillsConfig({
      catalogTokenBudget: "4096",
      disabled: ["one", "two", "one"],
      taps: ["Owner/repo", "owner/repo", "Owner/repo"],
      clawhub: { enabled: false, apiBase: "ftp://source.local/path" },
    }, createSkillsDefaults)).toEqual({
      catalogTokenBudget: 4096,
      disabled: ["one", "two"],
      taps: ["Owner/repo", "owner/repo"],
      clawhub: { enabled: false, apiBase: "ftp://source.local/path", browseLimit: 100, nonSuspiciousOnly: true },
    });
    expect(validation(() => parseSkillsConfig({ disabled: ["x"] }, createSkillsDefaults)).field)
      .toBe("skills.disabled[0]");
  });

  it("keeps skill normalization order and validates disabled source settings", () => {
    expect(validation(() => parseSkillsConfig({
      catalogTokenBudget: 0, disabled: ["bad name"], taps: ["bad"],
    }, createSkillsDefaults)).field).toBe("skills.catalogTokenBudget");
    expect(validation(() => parseSkillsConfig({ disabled: ["bad name"], taps: ["bad"] }, createSkillsDefaults)).field)
      .toBe("skills.disabled[0]");
    expect(validation(() => parseSkillsConfig({ clawhub: { enabled: false, browseLimit: 0 } }, createSkillsDefaults)).field)
      .toBe("skills.clawhub.browseLimit");
  });

  it("reads outer skill defaults separately after raw getters replace them", () => {
    let defaults = createSkillsDefaults();
    const events: string[] = [];
    const result = parseSkillsConfig({
      get catalogTokenBudget() { events.push("raw.budget"); return undefined; },
      get disabled() {
        events.push("raw.disabled");
        defaults = { ...createSkillsDefaults(), disabled: ["replacement"] };
        return undefined;
      },
      get taps() { events.push("raw.taps"); return []; },
      get clawhub() { events.push("raw.clawhub"); return undefined; },
    }, () => { events.push("defaults"); return defaults; });
    expect(events).toEqual([
      "raw.budget", "defaults", "raw.disabled", "defaults", "raw.taps", "raw.clawhub", "defaults",
    ]);
    expect(result.disabled).toEqual(["replacement"]);
    expect(result.taps).toEqual([]);
  });

  it("captures ClawHub nested defaults once before its raw fields are read", () => {
    let defaults = { ...createSkillsDefaults().clawhub, apiBase: "ftp://captured/", browseLimit: 17 };
    let reads = 0;
    const result = parseClawHubConfigWithDefaults({
      get enabled() {
        defaults = { ...createSkillsDefaults().clawhub, apiBase: "ftp://replacement/", browseLimit: 23 };
        return undefined;
      },
    }, () => { reads++; return defaults; });
    expect(reads).toBe(1);
    expect(result.apiBase).toBe("ftp://captured/");
    expect(result.browseLimit).toBe(17);
  });

  it("looks up ClawHub defaults on entry even when raw object validation fails", () => {
    let reads = 0;
    const error = validation(() => parseClawHubConfigWithDefaults([], () => {
      reads++;
      return createSkillsDefaults().clawhub;
    }));
    expect(reads).toBe(1);
    expect(error.field).toBe("skills.clawhub");
    expect(error.reason).toBe("expected object, got []");
  });

  it("spreads absent ClawHub defaults freshly while present blocks discard unknown keys", () => {
    const defaults = { ...createSkillsDefaults().clawhub, extra: "preserved-on-absence" };
    const absent = parseClawHubConfigWithDefaults(null, () => defaults);
    expect(absent).not.toBe(defaults);
    expect(absent).toHaveProperty("extra", "preserved-on-absence");
    const present = parseClawHubConfigWithDefaults({}, () => defaults);
    expect(present).not.toHaveProperty("extra");
    expect(present).not.toBe(parseClawHubConfigWithDefaults({}, () => defaults));
  });

  it("keeps the one-argument public ClawHub wrapper responsive to root defaults", () => {
    const saved = USER_CONFIG_DEFAULTS.skills;
    try {
      USER_CONFIG_DEFAULTS.skills = {
        ...createSkillsDefaults(),
        clawhub: { ...createSkillsDefaults().clawhub, apiBase: "ftp://operator/", browseLimit: 19 },
      };
      expect(parseClawHubConfig(null).apiBase).toBe("ftp://operator/");
      expect(parseUserConfigFile({}).skills.clawhub.browseLimit).toBe(19);
      expect(parseClawHubConfig(null)).not.toBe(USER_CONFIG_DEFAULTS.skills.clawhub);
    } finally {
      USER_CONFIG_DEFAULTS.skills = saved;
    }
  });

  it("distinguishes absent retention caps from explicit clearing", () => {
    const defaults = { retention: { enabled: false, maxAgeDays: 7, maxRows: 9 } };
    expect(parseSessionConfig({}, () => defaults)).toEqual(defaults);
    expect(parseSessionConfig({ maxAgeDays: null, maxRows: null }, () => defaults))
      .toEqual({ retention: { enabled: false, maxAgeDays: null, maxRows: null } });
    expect(parseSessionConfig({ maxAgeDays: "3", maxRows: 4 }, () => defaults))
      .toEqual({ retention: { enabled: false, maxAgeDays: 3, maxRows: 4 } });
  });

  it("evaluates retention fallback arguments even when explicit caps ignore them", () => {
    const events: string[] = [];
    const result = parseSessionConfig({
      enabled: true,
      get maxAgeDays() { events.push("raw.age"); return null; },
      get maxRows() { events.push("raw.rows"); return 3; },
    }, () => { events.push("defaults"); return createSessionDefaults(); });
    expect(events).toEqual(["raw.age", "defaults", "raw.rows", "defaults"]);
    expect(result.retention).toEqual({ enabled: true, maxAgeDays: null, maxRows: 3 });
  });

  it("retains effects of an ignored retention fallback getter on later fields", () => {
    let defaults = createSessionDefaults();
    Object.defineProperty(defaults.retention, "maxAgeDays", {
      configurable: true,
      get() {
        defaults = { retention: { enabled: false, maxAgeDays: 30, maxRows: 17 } };
        return 30;
      },
    });
    expect(parseSessionConfig({ maxAgeDays: null }, () => defaults))
      .toEqual({ retention: { enabled: false, maxAgeDays: null, maxRows: 17 } });
  });

  it("validates disabled retention and produces fresh normalized containers", () => {
    const error = validation(() => parseSessionConfig({ enabled: false, maxAgeDays: 0, maxRows: "bad" }, createSessionDefaults));
    expect(error.field).toBe("sessions.retention.maxAgeDays");
    expect(error.reason).toBe("expected positive integer, got 0");
    const defaults = createSessionDefaults();
    const a = parseSessionConfig({}, () => defaults);
    const b = parseSessionConfig({}, () => defaults);
    expect(a).not.toBe(b);
    expect(a.retention).not.toBe(b.retention);
    expect(a.retention).not.toBe(defaults.retention);
  });

  it("keeps tracing null fallback, explicit booleans and cap validation separate", () => {
    expect(parseTracingConfig({ enabled: null }, () => ({ trace: { enabled: true, maxBytesPerSession: 1024 } })))
      .toEqual({ trace: { enabled: true, maxBytesPerSession: 1024 } });
    expect(parseTracingConfig({ enabled: false }, createTracingDefaults).trace.enabled).toBe(false);
    expect(parseTracingConfig({}, createTracingDefaults).trace.enabled).toBeNull();
    expect(validation(() => parseTracingConfig({ enabled: false, maxBytesPerSession: 0 }, createTracingDefaults)).field)
      .toBe("tracing.trace.maxBytesPerSession");
    expect(parseTracingConfig({}, createTracingDefaults).trace)
      .not.toBe(parseTracingConfig({}, createTracingDefaults).trace);
  });

  it("reads tracing defaults per expression after within-call replacement", () => {
    let defaults = createTracingDefaults();
    const events: string[] = [];
    const result = parseTracingConfig({
      get enabled() { events.push("raw.enabled"); return undefined; },
      get maxBytesPerSession() {
        events.push("raw.cap");
        defaults = { trace: { enabled: false, maxBytesPerSession: 1024 } };
        return undefined;
      },
    }, () => { events.push("defaults"); return defaults; });
    expect(events).toEqual(["raw.enabled", "defaults", "raw.cap", "defaults"]);
    expect(result.trace).toEqual({ enabled: null, maxBytesPerSession: 1024 });
  });

  it("keeps early legacy/current tracing merge before memory validation", () => {
    const events: string[] = [];
    const result = parseUserConfigFile({
      telemetry: { trace: { get enabled() { events.push("legacy.enabled"); return false; } } },
      tracing: { trace: { get enabled() { events.push("current.enabled"); return undefined; } } },
      memory: { profile: { get enabled() { events.push("memory.enabled"); return true; } } },
    });
    expect(events).toEqual(["legacy.enabled", "current.enabled", "memory.enabled"]);
    expect(result.tracing.trace.enabled).toBeNull();
    expect(result).not.toHaveProperty("telemetry");
  });

  it("passes the early merged tracing snapshot to late normalization", () => {
    const input = {
      tracing: { trace: { enabled: true } },
      sessions: { retention: {
        get enabled() { input.tracing.trace.enabled = false; return undefined; },
      } },
    };
    expect(parseUserConfigFile(input).tracing.trace.enabled).toBe(true);
    expect(input.tracing.trace.enabled).toBe(false);
  });

  it("keeps resource validation in its original whole-config order", () => {
    expect(validation(() => parseUserConfigFile({
      sessions: { retention: { maxAgeDays: 0 } },
      tracing: { trace: { maxBytesPerSession: 0 } },
      memory: { profile: { maxTokens: 0 } },
      skills: { catalogTokenBudget: 0 },
    })).field).toBe("sessions.retention.maxAgeDays");
    expect(validation(() => parseUserConfigFile({
      tracing: { trace: { maxBytesPerSession: 0 } }, skills: { catalogTokenBudget: 0 },
    })).field).toBe("tracing.trace.maxBytesPerSession");
  });
});
