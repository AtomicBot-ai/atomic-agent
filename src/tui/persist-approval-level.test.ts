import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistApprovalLevel } from "./persist-approval-level.js";
import { getConfig, resetConfigCache } from "../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("persistApprovalLevel", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "approval-persist-"));
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

  it("writes agent.approvalLevel to config.json and getConfig() picks it up", () => {
    expect(getConfig().agent.approvalLevel).toBe(1); // shipped default
    persistApprovalLevel(3);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(3);
    expect(getConfig().agent.approvalLevel).toBe(3);
  });

  it("round-trips back to level 1", () => {
    persistApprovalLevel(5);
    persistApprovalLevel(1);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(1);
    expect(getConfig().agent.approvalLevel).toBe(1);
  });

  it("never writes the legacy agent.approvalRequired key back", () => {
    persistApprovalLevel(2);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect("approvalRequired" in onDisk.agent).toBe(false);
  });

  it("preserves the sibling agent.* keys", () => {
    const before = getConfig().agent;
    persistApprovalLevel(4);
    const after = getConfig().agent;
    expect(after.maxSteps).toBe(before.maxSteps);
    expect(after.tokenBudget).toBe(before.tokenBudget);
    expect(after.toolTimeoutMs).toBe(before.toolTimeoutMs);
  });
});
