import { describe, expect, it } from "vitest";
import {
  createHttpDefaults, parseHttpApprovalMode, parseHttpConfig,
} from "./http-config.js";
import {
  createProjectsDefaults, createToolsDefaults, createVisionDefaults,
  parseProjectsConfig, parseToolsConfig, parseVisionConfig,
} from "./tool-config.js";
import * as schema from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected tool-policy fixture validation to reject");
}

describe("outbound HTTP and tool configuration ownership", () => {
  it("preserves the public HTTP validator and original error identity", () => {
    expect(schema.parseHttpApprovalMode).toBe(parseHttpApprovalMode);
    expect(schema.ConfigValidationError).toBe(ConfigValidationError);
    const error = thrownError(() => parseHttpApprovalMode("ALWAYS", "synthetic.mode"));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({ field: "synthetic.mode", reason: 'expected one of never|writes|always, got "ALWAYS"' });
  });

  it("creates independent mutable defaults and fresh nested output objects", () => {
    const http = createHttpDefaults();
    const projects = createProjectsDefaults();
    const tools = createToolsDefaults();
    const vision = createVisionDefaults();
    expect(http).toStrictEqual({ enabled: true, approvalMode: "never", hostAllowlist: null, maxResponseBytes: 1_048_576, defaultTimeoutMs: 30_000 });
    expect(projects).toStrictEqual({ roots: [] });
    expect(tools).toStrictEqual({ shell: { defaultTimeoutMs: 600_000, jobMaxMs: 3_600_000, maxJobs: 3 } });
    expect(vision).toStrictEqual({ enabled: true, autoDetect: true, maxImageBytes: 8 * 1024 * 1024, maxImagesPerCall: 4 });
    expect(Object.keys(http)).toEqual(["enabled", "approvalMode", "hostAllowlist", "maxResponseBytes", "defaultTimeoutMs"]);
    expect(projects.roots).not.toBe(createProjectsDefaults().roots);
    expect(tools.shell).not.toBe(createToolsDefaults().shell);
    expect(vision).not.toBe(createVisionDefaults());
    http.hostAllowlist = ["synthetic.invalid"];
    projects.roots.push("synthetic root");
    tools.shell.maxJobs = 7;
    vision.enabled = false;
    expect(createHttpDefaults().hostAllowlist).toBeNull();
    expect(createProjectsDefaults().roots).toEqual([]);
    expect(createToolsDefaults().shell.maxJobs).toBe(3);
    expect(createVisionDefaults().enabled).toBe(true);
    const first = schema.parseUserConfigFile({});
    const second = schema.parseUserConfigFile({});
    expect(first.http).not.toBe(second.http);
    expect(first.projects.roots).not.toBe(second.projects.roots);
    expect(first.tools.shell).not.toBe(second.tools.shell);
    expect(first.vision).not.toBe(second.vision);
  });

  it.each([
    { version: 24, raw: undefined, expected: "never", reads: 0 },
    { version: 24, raw: null, expected: "never", reads: 0 },
    { version: 24, raw: "writes", expected: "never", reads: 0 },
    { version: 24, raw: "always", expected: "always", reads: 0 },
    { version: 24, raw: "never", expected: "never", reads: 0 },
    { version: 25, raw: undefined, expected: "always", reads: 1 },
    { version: 25, raw: null, expected: "always", reads: 1 },
    { version: 25, raw: "writes", expected: "writes", reads: 0 },
  ])("retains HTTP migration lookup branches at v$version for $raw", ({ version, raw, expected, reads }) => {
    const original = schema.USER_CONFIG_DEFAULTS.http;
    const defaults = createHttpDefaults();
    let lookups = 0;
    let modeReads = 0;
    Object.defineProperty(defaults, "approvalMode", { get() { modeReads += 1; return "always"; } });
    const input = { enabled: false, approvalMode: raw, hostAllowlist: [], maxResponseBytes: 1, defaultTimeoutMs: 1 };
    try {
      schema.USER_CONFIG_DEFAULTS.http = defaults;
      expect(parseHttpConfig(input, version, () => { lookups += 1; return defaults; }).approvalMode).toBe(expected);
      expect(lookups).toBe(reads);
      expect(modeReads).toBe(reads);
      modeReads = 0;
      expect(schema.parseUserConfigFile({ version, http: input }).http.approvalMode).toBe(expected);
      expect(modeReads).toBe(reads);
    } finally { schema.USER_CONFIG_DEFAULTS.http = original; }
  });

  it("preserves host/root list bytes, order, duplicates and null/default versus explicit-empty behavior", () => {
    const http = { ...createHttpDefaults(), hostAllowlist: [" synthetic.invalid ", "synthetic.invalid", "synthetic.invalid"] };
    const projects = { roots: [" synthetic root ", "same", "same"] };
    expect(parseHttpConfig({ hostAllowlist: null }, 25, () => http).hostAllowlist).toEqual(http.hostAllowlist);
    expect(parseHttpConfig({ hostAllowlist: null }, 25, () => http).hostAllowlist).not.toBe(http.hostAllowlist);
    expect(parseHttpConfig({ hostAllowlist: [] }, 25, () => http).hostAllowlist).toEqual([]);
    expect(parseProjectsConfig({ roots: null }, () => projects).roots).toEqual(projects.roots);
    expect(parseProjectsConfig({}, () => projects).roots).not.toBe(projects.roots);
    expect(parseProjectsConfig({ roots: [] }, () => projects).roots).toEqual([]);
    expect(parseHttpConfig({}, 25, createHttpDefaults).hostAllowlist).toBeNull();
  });

  it("retains shell zero/no-default and independent time limits without introducing a runtime clamp", () => {
    expect(parseToolsConfig({ defaultTimeoutMs: 0, jobMaxMs: 1, maxJobs: 1 }, createToolsDefaults).shell)
      .toStrictEqual({ defaultTimeoutMs: 0, jobMaxMs: 1, maxJobs: 1 });
    expect(parseToolsConfig({ defaultTimeoutMs: "2e3", jobMaxMs: 1 }, createToolsDefaults).shell.defaultTimeoutMs).toBe(2000);
    expect(schema.parseUserConfigFile({ tools: { shell: { defaultTimeoutMs: "2e3", jobMaxMs: 1 } } }).tools.shell.defaultTimeoutMs).toBe(2000);
  });

  it("short-circuits explicit scalar defaults in all four owners", () => {
    const noDefaults = () => { throw new Error("explicit fields must not read defaults"); };
    const http = { enabled: false, approvalMode: "never", hostAllowlist: [], maxResponseBytes: 1, defaultTimeoutMs: 1 };
    const vision = { enabled: false, autoDetect: false, maxImageBytes: 1, maxImagesPerCall: 1 };
    expect(parseHttpConfig(http, 25, noDefaults)).toStrictEqual(http);
    expect(parseProjectsConfig({ roots: [] }, noDefaults)).toStrictEqual({ roots: [] });
    expect(parseToolsConfig({ defaultTimeoutMs: 0, jobMaxMs: 1, maxJobs: 1 }, noDefaults).shell)
      .toStrictEqual({ defaultTimeoutMs: 0, jobMaxMs: 1, maxJobs: 1 });
    expect(parseVisionConfig(vision, noDefaults)).toStrictEqual(vision);
  });

  it("uses the early shell reference when a later LLM getter replaces its raw container", () => {
    const tools = { shell: { defaultTimeoutMs: 10 } };
    const root = schema.parseUserConfigFile({ tools, get llm() {
      tools.shell = { defaultTimeoutMs: 20 };
      return {};
    } });
    expect(tools.shell.defaultTimeoutMs).toBe(20);
    expect(root.tools.shell.defaultTimeoutMs).toBe(10);
  });

  it("observes default replacements per expression while retaining already parsed fields", () => {
    const originalHttp = schema.USER_CONFIG_DEFAULTS.http;
    const originalTools = schema.USER_CONFIG_DEFAULTS.tools;
    const events: string[] = [];
    try {
      schema.USER_CONFIG_DEFAULTS.http = createHttpDefaults();
      schema.USER_CONFIG_DEFAULTS.tools = createToolsDefaults();
      const root = schema.parseUserConfigFile({ http: {
        get enabled() { events.push("HTTP replacement"); schema.USER_CONFIG_DEFAULTS.http = { ...createHttpDefaults(), enabled: false, approvalMode: "always" }; return undefined; },
        get approvalMode() { events.push("HTTP second replacement"); schema.USER_CONFIG_DEFAULTS.http = { ...createHttpDefaults(), approvalMode: "writes", maxResponseBytes: 7 }; return undefined; },
      }, tools: { shell: {
        get defaultTimeoutMs() { events.push("shell replacement"); schema.USER_CONFIG_DEFAULTS.tools.shell = { defaultTimeoutMs: 0, jobMaxMs: 3, maxJobs: 2 }; return undefined; },
        get jobMaxMs() { events.push("whole tools replacement"); schema.USER_CONFIG_DEFAULTS.tools = { shell: { defaultTimeoutMs: 5, jobMaxMs: 1, maxJobs: 7 } }; return undefined; },
      } } });
      expect(events).toEqual(["HTTP replacement", "HTTP second replacement", "shell replacement", "whole tools replacement"]);
      expect(root.http.enabled).toBe(false);
      expect(root.http.approvalMode).toBe("writes");
      expect(root.http.maxResponseBytes).toBe(7);
      expect(root.tools.shell).toStrictEqual({ defaultTimeoutMs: 0, jobMaxMs: 1, maxJobs: 7 });
      schema.USER_CONFIG_DEFAULTS.tools.shell.maxJobs = 9;
      expect(root.tools.shell.maxJobs).toBe(7);
    } finally {
      schema.USER_CONFIG_DEFAULTS.http = originalHttp;
      schema.USER_CONFIG_DEFAULTS.tools = originalTools;
    }
  });

  it.each([
    { area: "http", raw: { enabled: false, maxResponseBytes: 0 }, field: "http.maxResponseBytes", reason: "expected positive integer, got 0" },
    { area: "http", raw: { enabled: false, defaultTimeoutMs: 0 }, field: "http.defaultTimeoutMs", reason: "expected positive integer, got 0" },
    { area: "tools", raw: { defaultTimeoutMs: -1 }, field: "tools.shell.defaultTimeoutMs", reason: "expected non-negative integer, got -1" },
    { area: "tools", raw: { maxJobs: 0 }, field: "tools.shell.maxJobs", reason: "expected positive integer, got 0" },
    { area: "vision", raw: { enabled: false, maxImageBytes: 0 }, field: "vision.maxImageBytes", reason: "expected positive integer, got 0" },
  ])("preserves disabled-policy validation and exact fields at $field", ({ area, raw, field, reason }) => {
    const direct = () => area === "http" ? parseHttpConfig(raw, 74, createHttpDefaults)
      : area === "tools" ? parseToolsConfig(raw, createToolsDefaults) : parseVisionConfig(raw, createVisionDefaults);
    const rootRaw = area === "tools" ? { tools: { shell: raw } } : { [area]: raw };
    for (const error of [thrownError(direct), thrownError(() => schema.parseUserConfigFile(rootRaw))]) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it.each([
    { raw: { agent: { tokenBudget: 0 }, http: { enabled: "bad" } }, field: "agent.tokenBudget" },
    { raw: { http: { enabled: "bad" }, web: { search: { maxResults: 0 } } }, field: "http.enabled" },
    { raw: { projects: { roots: [0] }, tools: { shell: { maxJobs: 0 } } }, field: "projects.roots[0]" },
    { raw: { tools: { shell: { maxJobs: 0 } }, memory: { profile: { maxTokens: 0 } } }, field: "tools.shell.maxJobs" },
    { raw: { memory: { profile: { maxTokens: 0 } }, vision: { enabled: "bad" } }, field: "memory.profile.maxTokens" },
    { raw: { vision: { enabled: "bad" }, skills: { catalogTokenBudget: 0 } }, field: "vision.enabled" },
  ])("retains nonadjacent late-slot validation order at $field", ({ raw, field }) => {
    expect(thrownError(() => schema.parseUserConfigFile(raw))).toMatchObject({ field });
  });
});
