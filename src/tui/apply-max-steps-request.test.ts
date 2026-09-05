import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { applyMaxStepsRequest } from "./apply-max-steps-request.js";

interface MaxStepsTarget {
  getMaxSteps(): number;
  setMaxSteps(maxSteps: number): void;
}

function target(initial: number): MaxStepsTarget {
  let current = initial;
  return {
    getMaxSteps: () => current,
    setMaxSteps: (maxSteps) => {
      current = maxSteps;
    },
  };
}

describe("applyMaxStepsRequest", () => {
  let previousStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "atomic-apply-max-steps-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reports the active value without touching config", () => {
    const result = applyMaxStepsRequest(null, target(7));

    expect(result).toEqual({
      message: "current max_steps: 7",
      warning: false,
    });
    expect(existsSync(join(stateDir, "config.json"))).toBe(false);
  });

  it("updates the live target and persists the validated value", () => {
    const runtime = target(7);

    const result = applyMaxStepsRequest(41, runtime);

    expect(runtime.getMaxSteps()).toBe(41);
    expect(result).toEqual({
      message: "max_steps updated from 7 to 41",
      warning: false,
    });
    expect(getConfig().agent.maxSteps).toBe(41);
  });

  it("keeps the live update when persistence fails", () => {
    mkdirSync(join(stateDir, "config.json"));
    const runtime = target(7);

    const result = applyMaxStepsRequest(41, runtime);

    expect(runtime.getMaxSteps()).toBe(41);
    expect(result.warning).toBe(true);
    expect(result.message).toContain("max_steps updated to 41 (runtime only");
  });
});
