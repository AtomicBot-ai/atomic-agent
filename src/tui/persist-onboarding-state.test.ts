import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistOnboardingState } from "./persist-onboarding-state.js";
import { getConfig, resetConfigCache } from "../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const STAMP = "2026-08-21T18:04:05.000Z";
const LATER = "2026-08-22T09:00:00.000Z";

describe("persistOnboardingState", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-persist-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes a stamp to config.json and getConfig() picks it up", () => {
    expect(getConfig().tui.onboarding.completedAt).toBeNull();
    persistOnboardingState({ completedAt: STAMP });
    const onDisk = JSON.parse(readFileSync(getConfig().paths.userConfigFile, "utf8"));
    expect(onDisk.tui.onboarding.completedAt).toBe(STAMP);
    expect(getConfig().tui.onboarding.completedAt).toBe(STAMP);
  });

  it("merges rather than replaces — a second field keeps the first", () => {
    persistOnboardingState({ introSeenAt: STAMP });
    persistOnboardingState({ completedAt: LATER });
    expect(getConfig().tui.onboarding).toEqual({
      completedAt: LATER,
      introSeenAt: STAMP,
      skippedAt: null,
      proposedSecondBackendAt: null,
      localSetupSeenAt: null,
    });
  });

  it("round-trips localSetupSeenAt through the file", () => {
    persistOnboardingState({ localSetupSeenAt: STAMP });
    const onDisk = JSON.parse(readFileSync(getConfig().paths.userConfigFile, "utf8"));
    expect(onDisk.tui.onboarding.localSetupSeenAt).toBe(STAMP);
    expect(getConfig().tui.onboarding.localSetupSeenAt).toBe(STAMP);
  });

  it("leaves the rest of tui alone", () => {
    persistOnboardingState({ skippedAt: STAMP });
    expect(getConfig().tui.theme).toBe("auto");
    expect(getConfig().tui.mouse).toBe(true);
  });
});
