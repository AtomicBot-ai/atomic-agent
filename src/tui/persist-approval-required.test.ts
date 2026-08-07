import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistApprovalRequired } from "./persist-approval-required.js";
import { getConfig, resetConfigCache } from "../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("persistApprovalRequired", () => {
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

  it("writes agent.approvalRequired=false to config.json and getConfig() picks it up", () => {
    expect(getConfig().agent.approvalRequired).toBe(true); // shipped default
    persistApprovalRequired(false);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalRequired).toBe(false);
    expect(getConfig().agent.approvalRequired).toBe(false);
  });

  it("round-trips back to true", () => {
    persistApprovalRequired(false);
    persistApprovalRequired(true);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalRequired).toBe(true);
    expect(getConfig().agent.approvalRequired).toBe(true);
  });

  it("preserves the sibling agent.* keys", () => {
    const before = getConfig().agent;
    persistApprovalRequired(false);
    const after = getConfig().agent;
    expect(after.maxSteps).toBe(before.maxSteps);
    expect(after.tokenBudget).toBe(before.tokenBudget);
    expect(after.toolTimeoutMs).toBe(before.toolTimeoutMs);
  });
});
