import { describe, expect, it } from "vitest";
import { createAgentDefaults } from "./agent-defaults.js";
import type { UserAgentConfig } from "./agent-types.js";
import {
  CONVERSATION_MAX_PAIRS_MAX,
  CONVERSATION_MAX_PAIRS_MIN,
  parseAgentConfig,
  parseApprovalLevel,
  parseReadScope,
  READ_SCOPES,
} from "./agent-parser.js";
import {
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
} from "../config-schema.js";
import { ConfigValidationError } from "../config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected parsing to fail");
}

describe("agent configuration ownership", () => {
  it("preserves public scalar policy semantics and bounds without context or task clamping", () => {
    expect(READ_SCOPES).toEqual(["working-dir", "unrestricted"]);
    expect(parseReadScope("unrestricted", "scope")).toBe("unrestricted");
    expect(parseApprovalLevel("3", "approval")).toBe(3);
    expect([CONVERSATION_MAX_PAIRS_MIN, CONVERSATION_MAX_PAIRS_MAX]).toEqual([1, 1000]);
    const defaults = createAgentDefaults();
    const parsed = parseAgentConfig({
      maxSteps: 100, task: { maxSteps: 1 }, approvalLevel: "5",
      conversationMaxTokens: 0, sessionSectionsMaxTokens: 0,
      conversationMaxPairs: 1000, conversationLowWater: 1,
    }, () => defaults);
    expect(parsed.maxSteps).toBe(100);
    expect(parsed.task.maxSteps).toBe(1);
    expect(parsed.approvalLevel).toBe(5);
    expect(parsed.conversationMaxTokens).toBe(0);
    expect(parsed.sessionSectionsMaxTokens).toBe(0);
    expect(parsed.conversationLowWater).toBe(1);
    expect(thrownError(() => parseAgentConfig({ conversationMaxPairs: 1001 }, () => defaults)))
      .toBeInstanceOf(ConfigValidationError);
  });

  it("constructs the old ordered mutable defaults and fresh execution policies", () => {
    const first = createAgentDefaults();
    const second = createAgentDefaults();
    expect(first).toEqual(USER_CONFIG_DEFAULTS.agent);
    expect(Object.keys(first)).toEqual([
      "tokenBudget", "maxSteps", "providerWait", "task", "toolTimeoutMs",
      "readScope", "approvalLevel", "conversationMaxTokens", "conversationMaxPairs",
      "nameSessions", "conversationLowWater", "sessionSectionsMaxTokens", "worldSnapshotMaxTokens",
    ]);
    expect(first.providerWait).not.toBe(second.providerWait);
    expect(first.task).not.toBe(second.task);
    first.providerWait.maxWaitMs = 1;
    first.task.maxSteps = 1;
    expect(second.providerWait.maxWaitMs).toBe(300_000);
    expect(second.task.maxSteps).toBe(1000);
  });

  it("evaluates both approval arguments eagerly even when the new key wins", () => {
    const events: string[] = [];
    const defaults = createAgentDefaults();
    const raw = {
      get approvalLevel() { events.push("new"); return "3"; },
      get approvalRequired() { events.push("legacy"); return "invalid ignored value"; },
    };
    expect(parseAgentConfig(raw, () => defaults).approvalLevel).toBe(3);
    expect(events).toEqual(["new", "legacy"]);
    const error = new Error("legacy getter observed");
    expect(thrownError(() => parseAgentConfig({
      approvalLevel: 3,
      get approvalRequired() { throw error; },
    }, () => defaults))).toBe(error);
  });

  it("reads present policy defaults unconditionally after their raw getters", () => {
    const defaults = createAgentDefaults();
    const events: string[] = [];
    const selected = {
      ...defaults,
      get providerWait() { events.push("default-wait"); return defaults.providerWait; },
      get task() { events.push("default-task"); return defaults.task; },
    };
    const raw = {
      ...defaults,
      get providerWait() { events.push("raw-wait"); return { enabled: false, maxWaitMs: 1 }; },
      get task() { events.push("raw-task"); return { maxSteps: 2, maxDurationMs: 3, autoContinue: false }; },
    };
    const parsed = parseAgentConfig(raw, () => {
      events.push("read-defaults");
      return selected;
    });
    expect(events).toEqual([
      "raw-wait", "read-defaults", "default-wait",
      "raw-task", "read-defaults", "default-task",
    ]);
    expect(parsed.providerWait).toEqual({ enabled: false, maxWaitMs: 1 });
    expect(parsed.task).toEqual({ maxSteps: 2, maxDurationMs: 3, autoContinue: false });
    expect(parsed.task).not.toBe(defaults.task);
  });

  it("preserves absent policy references while refreshing defaults after raw getters", () => {
    let current = createAgentDefaults();
    const savedWait = current.providerWait;
    const savedTask = current.task;
    const first = parseAgentConfig({}, () => current);
    expect(first.providerWait).toBe(savedWait);
    expect(first.task).toBe(savedTask);
    const nextWait = { enabled: false, maxWaitMs: 2 };
    const nextTask = { maxSteps: 3, maxDurationMs: 4, autoContinue: false };
    const second = parseAgentConfig({
      get providerWait() { current = { ...current, providerWait: nextWait }; return undefined; },
      get task() { current = { ...current, task: nextTask }; return null; },
    }, () => current);
    expect(second.providerWait).toBe(nextWait);
    expect(second.task).toBe(nextTask);
    expect(first.providerWait).toBe(savedWait);
    expect(first.task).toBe(savedTask);
  });

  it("uses the mutable approval default only in the final fallback branch without validating it", () => {
    const defaults = createAgentDefaults();
    let reads = 0;
    const selected = {
      ...defaults,
      get approvalLevel(): UserAgentConfig["approvalLevel"] { reads++; return 4; },
    };
    expect(parseAgentConfig({ approvalLevel: 2 }, () => selected).approvalLevel).toBe(2);
    expect(parseAgentConfig({ approvalRequired: false }, () => selected).approvalLevel).toBe(5);
    expect(parseAgentConfig({ approvalRequired: true }, () => selected).approvalLevel).toBe(1);
    expect(reads).toBe(0);
    expect(parseAgentConfig({ approvalLevel: null, approvalRequired: null }, () => selected).approvalLevel).toBe(4);
    expect(reads).toBe(1);
    const savedDescriptor = Object.getOwnPropertyDescriptor(selected, "approvalLevel");
    try {
      Object.defineProperty(selected, "approvalLevel", { value: 9, configurable: true });
      expect(parseAgentConfig({}, () => selected).approvalLevel).toBe(9);
    } finally {
      if (savedDescriptor) Object.defineProperty(selected, "approvalLevel", savedDescriptor);
    }
  });

  it("keeps per-expression outer lookups current without rewriting field/message strings", () => {
    let current = createAgentDefaults();
    const parsed = parseAgentConfig({
      get tokenBudget() { current = { ...current, tokenBudget: 7 }; return undefined; },
      get maxSteps() { current = { ...current, maxSteps: 8 }; return null; },
    }, () => current);
    expect(parsed.tokenBudget).toBe(7);
    expect(parsed.maxSteps).toBe(8);
    expect(thrownError(() => parseAgentConfig({
      readScope: "invalid", approvalLevel: "invalid",
    }, () => current))).toEqual(new ConfigValidationError(
      "agent.readScope", 'expected working-dir|unrestricted, got "invalid"',
    ));
  });

  it("matches root composition and preserves replacement defaults with finally restoration", () => {
    const saved = USER_CONFIG_DEFAULTS.agent;
    try {
      USER_CONFIG_DEFAULTS.agent = {
        ...saved, tokenBudget: 11, approvalLevel: 4,
        task: { maxSteps: 12, maxDurationMs: 13, autoContinue: false },
      };
      const direct = parseAgentConfig({}, () => USER_CONFIG_DEFAULTS.agent);
      const root = parseUserConfigFile({ agent: {} }).agent;
      expect(root).toEqual(direct);
      expect(root.task).toBe(USER_CONFIG_DEFAULTS.agent.task);
      expect(root.providerWait).toBe(USER_CONFIG_DEFAULTS.agent.providerWait);
      expect(Object.keys(direct)).toEqual([
        "tokenBudget", "maxSteps", "providerWait", "nameSessions", "task", "toolTimeoutMs",
        "readScope", "approvalLevel", "conversationMaxTokens", "conversationMaxPairs",
        "conversationLowWater", "sessionSectionsMaxTokens", "worldSnapshotMaxTokens",
      ]);
    } finally {
      USER_CONFIG_DEFAULTS.agent = saved;
    }
  });
});
