import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import type { TuiAction } from "../tui-action.js";
import { decideOnboarding } from "./needs-onboarding.js";
import {
  ONBOARDING_RERUN_RESET,
  reopenOnboarding,
} from "./rerun-onboarding.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const STAMP = "2026-09-01T10:00:00.000Z";

describe("reopenOnboarding", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-rerun-"));
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

  function stampEverything(): void {
    persistOnboardingState({
      completedAt: STAMP,
      introSeenAt: STAMP,
      skippedAt: STAMP,
      proposedSecondBackendAt: STAMP,
      localSetupSeenAt: STAMP,
      importOfferedAt: STAMP,
    });
  }

  it("clears every onboarding stamp, the once-only offers included", () => {
    stampEverything();
    expect(decideOnboarding().needed).toBe(false);
    reopenOnboarding(() => {});
    expect(getConfig().tui.onboarding).toEqual(ONBOARDING_RERUN_RESET);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.tui.onboarding).toEqual(ONBOARDING_RERUN_RESET);
    // Nothing configured in this temp state dir, so with the stamps gone
    // the next launch reads as a fresh install again.
    expect(decideOnboarding()).toEqual({
      needed: true,
      reason: "fresh_install",
    });
  });

  it("opens the flow on its splash", () => {
    stampEverything();
    const dispatched: TuiAction[] = [];
    reopenOnboarding((action) => dispatched.push(action));
    expect(dispatched).toHaveLength(1);
    const [action] = dispatched;
    expect(action?.type).toBe("onboarding_set");
    if (action?.type !== "onboarding_set") return;
    expect(action.onboarding?.step).toBe("intro");
    expect(action.onboarding?.outcome).toBeNull();
    expect(action.onboarding?.chatUrl).toBe(getConfig().localModels.url);
  });

  it("leaves everything outside tui.onboarding byte-for-byte alone", () => {
    stampEverything();
    const path = getConfig().paths.userConfigFile;
    const before = JSON.parse(readFileSync(path, "utf8"));
    reopenOnboarding(() => {});
    const after = JSON.parse(readFileSync(path, "utf8"));
    const withoutStamps = (file: { tui: Record<string, unknown> }) => ({
      ...file,
      tui: { ...file.tui, onboarding: undefined },
    });
    expect(withoutStamps(after)).toEqual(withoutStamps(before));
  });
});
