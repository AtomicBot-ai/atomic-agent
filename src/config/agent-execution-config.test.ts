import { describe, expect, it } from "vitest";
import {
  createAgentTaskDefaults,
  createProviderWaitDefaults,
  parseAgentTask,
  parseProviderWait,
} from "./agent-execution-config.js";
import {
  ConfigValidationError,
  parseUserConfigFile,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "./config-validation-error.js";

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected execution-policy fixture validation to reject");
}

describe("agent execution policy configuration", () => {
  it("creates independent mutable defaults in the existing property order", () => {
    const task = createAgentTaskDefaults();
    const otherTask = createAgentTaskDefaults();
    const wait = createProviderWaitDefaults();
    const otherWait = createProviderWaitDefaults();
    expect(task).toStrictEqual({ maxSteps: 1000, maxDurationMs: 7_200_000, autoContinue: true });
    expect(wait).toStrictEqual({ enabled: true, maxWaitMs: 300_000 });
    expect(Object.keys(task)).toEqual(["maxSteps", "maxDurationMs", "autoContinue"]);
    expect(Object.keys(wait)).toEqual(["enabled", "maxWaitMs"]);
    expect(task).not.toBe(otherTask);
    expect(wait).not.toBe(otherWait);
    task.maxSteps = 7;
    wait.enabled = false;
    expect(otherTask.maxSteps).toBe(1000);
    expect(otherWait.enabled).toBe(true);
    expect(createAgentTaskDefaults()).toStrictEqual(otherTask);
    expect(createProviderWaitDefaults()).toStrictEqual(otherWait);
  });

  it("returns supplied defaults by reference for missing and null blocks", () => {
    const task = { maxSteps: 31, maxDurationMs: 47, autoContinue: false };
    const wait = { enabled: false, maxWaitMs: 59 };
    expect(parseAgentTask(undefined, task)).toBe(task);
    expect(parseAgentTask(null, task)).toBe(task);
    expect(parseProviderWait(undefined, wait)).toBe(wait);
    expect(parseProviderWait(null, wait)).toBe(wait);
    const missing = parseUserConfigFile({});
    const nullBlocks = parseUserConfigFile({ agent: { task: null, providerWait: null } });
    expect(missing.agent.task).toBe(USER_CONFIG_DEFAULTS.agent.task);
    expect(nullBlocks.agent.task).toBe(missing.agent.task);
    expect(missing.agent.providerWait).toBe(USER_CONFIG_DEFAULTS.agent.providerWait);
    expect(nullBlocks.agent.providerWait).toBe(missing.agent.providerWait);
  });

  it("normalizes present blocks into fresh objects and falls back on null fields", () => {
    const task = { maxSteps: 31, maxDurationMs: 47, autoContinue: false };
    const wait = { enabled: false, maxWaitMs: 59 };
    const normalizedTask = parseAgentTask({}, task);
    const normalizedWait = parseProviderWait({}, wait);
    expect(normalizedTask).toStrictEqual(task);
    expect(normalizedWait).toStrictEqual(wait);
    expect(normalizedTask).not.toBe(task);
    expect(normalizedTask).not.toBe(parseAgentTask({}, task));
    expect(normalizedWait).not.toBe(wait);
    expect(normalizedWait).not.toBe(parseProviderWait({}, wait));
    expect(parseAgentTask({ maxSteps: null, maxDurationMs: null, autoContinue: null, ignored: 9 }, task))
      .toStrictEqual(task);
    expect(parseProviderWait({ enabled: null, maxWaitMs: null, ignored: 9 }, wait)).toStrictEqual(wait);
    expect(parseAgentTask({ maxSteps: "1e2" }, task))
      .toStrictEqual({ maxSteps: 100, maxDurationMs: 47, autoContinue: false });
    expect(parseProviderWait({ maxWaitMs: "2.0" }, wait)).toStrictEqual({ enabled: false, maxWaitMs: 2 });
  });

  it("preserves numeric-string and boolean coercion including explicit false", () => {
    const rawTask = { maxSteps: " 1e2 ", maxDurationMs: "2.0", autoContinue: "OFF" };
    const rawWait = { enabled: "No", maxWaitMs: "+3" };
    const expectedTask = { maxSteps: 100, maxDurationMs: 2, autoContinue: false };
    const expectedWait = { enabled: false, maxWaitMs: 3 };
    expect(parseAgentTask(rawTask, createAgentTaskDefaults())).toStrictEqual(expectedTask);
    expect(parseProviderWait(rawWait, createProviderWaitDefaults())).toStrictEqual(expectedWait);
    const composed = parseUserConfigFile({ agent: { task: rawTask, providerWait: rawWait } });
    expect(composed.agent.task).toStrictEqual(expectedTask);
    expect(composed.agent.providerWait).toStrictEqual(expectedWait);
    expect(parseAgentTask({ autoContinue: false }, createAgentTaskDefaults()).autoContinue).toBe(false);
    expect(parseProviderWait({ enabled: false }, createProviderWaitDefaults()).enabled).toBe(false);
    expect(parseAgentTask({ autoContinue: "YeS" }, createAgentTaskDefaults()).autoContinue).toBe(true);
    expect(parseProviderWait({ enabled: "ON" }, createProviderWaitDefaults()).enabled).toBe(true);
  });

  it("retains acceptance of object instances without adding plain-object restrictions", () => {
    class TaskFixture {
      maxSteps = 11;
      autoContinue = false;
    }
    const taskDefaults = createAgentTaskDefaults();
    const waitDefaults = createProviderWaitDefaults();
    expect(parseAgentTask(new TaskFixture(), taskDefaults))
      .toStrictEqual({ ...taskDefaults, maxSteps: 11, autoContinue: false });
    expect(parseAgentTask(new Date(0), taskDefaults)).toStrictEqual(taskDefaults);
    expect(parseProviderWait(new Date(0), waitDefaults)).toStrictEqual(waitDefaults);
  });

  it("keeps task ceilings independent of the per-leg agent step budget", () => {
    const config = parseUserConfigFile({ agent: { maxSteps: 25, task: { maxSteps: 1, maxDurationMs: 1 } } });
    expect(config.agent.maxSteps).toBe(25);
    expect(config.agent.task).toStrictEqual({ maxSteps: 1, maxDurationMs: 1, autoContinue: true });
  });

  it.each([
    { policy: "task", raw: [], field: "agent.task", reason: "expected object, got []" },
    { policy: "task", raw: "bad", field: "agent.task", reason: 'expected object, got "bad"' },
    { policy: "providerWait", raw: [], field: "agent.providerWait", reason: "expected object, got []" },
    { policy: "providerWait", raw: false, field: "agent.providerWait", reason: "expected object, got false" },
    { policy: "task", raw: { maxSteps: 0 }, field: "agent.task.maxSteps", reason: "expected positive integer, got 0" },
    { policy: "task", raw: { maxDurationMs: "2ms" }, field: "agent.task.maxDurationMs", reason: 'expected positive integer, got "2ms"' },
    { policy: "task", raw: { autoContinue: " true " }, field: "agent.task.autoContinue", reason: 'expected boolean, got " true "' },
    { policy: "providerWait", raw: { enabled: 0 }, field: "agent.providerWait.enabled", reason: "expected boolean, got 0" },
    { policy: "providerWait", raw: { maxWaitMs: 1.5 }, field: "agent.providerWait.maxWaitMs", reason: "expected positive integer, got 1.5" },
    { policy: "providerWait", raw: { enabled: false, maxWaitMs: 0 }, field: "agent.providerWait.maxWaitMs", reason: "expected positive integer, got 0" },
  ])("preserves owner and root validation for $field ($reason)", ({ policy, raw, field, reason }) => {
    const ownerError = thrownError(() => policy === "task"
      ? parseAgentTask(raw, createAgentTaskDefaults())
      : parseProviderWait(raw, createProviderWaitDefaults()));
    const rootError = thrownError(() => parseUserConfigFile({ agent: { [policy]: raw } }));
    expect(ConfigValidationError).toBe(OwnedValidationError);
    for (const error of [ownerError, rootError]) {
      expect(error).toBeInstanceOf(OwnedValidationError);
      expect(error).toMatchObject({ name: "ConfigValidationError", field, reason, message: `invalid config: ${field}: ${reason}` });
    }
  });

  it("observes root default property mutations while present blocks retain prior snapshots", () => {
    const originalAgent = USER_CONFIG_DEFAULTS.agent;
    const task = originalAgent.task;
    const wait = originalAgent.providerWait;
    const savedTask = { ...task };
    const savedWait = { ...wait };
    try {
      const absentBefore = parseUserConfigFile({});
      const presentBefore = parseUserConfigFile({ agent: { task: {}, providerWait: {} } });
      task.maxSteps = 37;
      task.maxDurationMs = 43;
      task.autoContinue = false;
      wait.enabled = false;
      wait.maxWaitMs = 61;
      const absentAfter = parseUserConfigFile({});
      const presentAfter = parseUserConfigFile({ agent: { task: {}, providerWait: {} } });
      expect(absentAfter.agent.task).toBe(task);
      expect(absentAfter.agent.providerWait).toBe(wait);
      expect(absentBefore.agent.task).toBe(task);
      expect(absentBefore.agent.task.maxSteps).toBe(37);
      expect(absentBefore.agent.providerWait.maxWaitMs).toBe(61);
      expect(presentAfter.agent.task).toStrictEqual(task);
      expect(presentAfter.agent.providerWait).toStrictEqual(wait);
      expect(presentAfter.agent.task).not.toBe(task);
      expect(presentAfter.agent.providerWait).not.toBe(wait);
      expect(presentBefore.agent.task).toStrictEqual(savedTask);
      expect(presentBefore.agent.providerWait).toStrictEqual(savedWait);
    } finally {
      Object.assign(task, savedTask);
      Object.assign(wait, savedWait);
      originalAgent.task = task;
      originalAgent.providerWait = wait;
      USER_CONFIG_DEFAULTS.agent = originalAgent;
    }
  });

  it("reads nested and whole-agent default replacements without retargeting previous results", () => {
    const originalAgent = USER_CONFIG_DEFAULTS.agent;
    const originalTask = originalAgent.task;
    const originalWait = originalAgent.providerWait;
    try {
      const before = parseUserConfigFile({});
      const replacementTask = { maxSteps: 67, maxDurationMs: 71, autoContinue: false };
      const replacementWait = { enabled: false, maxWaitMs: 73 };
      originalAgent.task = replacementTask;
      originalAgent.providerWait = replacementWait;
      const nested = parseUserConfigFile({});
      const nestedPresent = parseUserConfigFile({ agent: { task: {}, providerWait: {} } });
      expect(nested.agent.task).toBe(replacementTask);
      expect(nested.agent.providerWait).toBe(replacementWait);
      expect(nestedPresent.agent.task).toStrictEqual(replacementTask);
      expect(nestedPresent.agent.providerWait).toStrictEqual(replacementWait);
      expect(before.agent.task).toBe(originalTask);
      expect(before.agent.providerWait).toBe(originalWait);
      const nextTask = { maxSteps: 79, maxDurationMs: 83, autoContinue: true };
      const nextWait = { enabled: true, maxWaitMs: 89 };
      USER_CONFIG_DEFAULTS.agent = { ...originalAgent, task: nextTask, providerWait: nextWait };
      const whole = parseUserConfigFile({});
      const wholePresent = parseUserConfigFile({ agent: { task: {}, providerWait: {} } });
      expect(whole.agent.task).toBe(nextTask);
      expect(whole.agent.providerWait).toBe(nextWait);
      expect(wholePresent.agent.task).toStrictEqual(nextTask);
      expect(wholePresent.agent.providerWait).toStrictEqual(nextWait);
      expect(wholePresent.agent.task).not.toBe(nextTask);
      expect(wholePresent.agent.providerWait).not.toBe(nextWait);
      expect(nested.agent.task).toBe(replacementTask);
      expect(nested.agent.providerWait).toBe(replacementWait);
      expect(before.agent.task).toBe(originalTask);
      expect(before.agent.providerWait).toBe(originalWait);
    } finally {
      originalAgent.task = originalTask;
      originalAgent.providerWait = originalWait;
      USER_CONFIG_DEFAULTS.agent = originalAgent;
    }
  });
});
