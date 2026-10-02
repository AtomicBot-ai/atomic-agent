import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrivacyOrchestrator } from "./privacy-orchestrator.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { resetConfigCache } from "../../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

interface Emitted {
  type: string;
  [key: string]: unknown;
}

function makeBus() {
  const actions: Emitted[] = [];
  return {
    actions,
    bus: {
      subscribe: () => () => {},
      emit: (action: unknown) => {
        actions.push(action as Emitted);
      },
    },
  };
}

describe("PrivacyOrchestrator", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "privacy-orch-"));
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

  it("refresh() mirrors the LIVE gate level into the session", () => {
    // The panel no longer shows a ladder, but the diagnostics line
    // still needs the truth (e.g. after a --no-approval boot).
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 5,
      approvals: {
        sessionGrants: () => ({ categories: [], shapes: [] }),
      },
    } as unknown as AgentRuntime;
    new PrivacyOrchestrator(runtime, bus).refresh();
    const mirrored = actions.find((a) => a.type === "approval_level_changed");
    expect(mirrored?.approvalLevel).toBe(5);
    const synced = actions.find((a) => a.type === "privacy_synced");
    expect(synced).toBeDefined();
    expect(synced?.approvalLevel).toBeUndefined();
  });

  it("refresh() mirrors the live session grants into the panel snapshot", () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: {
        sessionGrants: () => ({ categories: ["shell"], shapes: ["git"] }),
      },
    } as unknown as AgentRuntime;
    new PrivacyOrchestrator(runtime, bus).refresh();
    const synced = actions.find((a) => a.type === "privacy_synced");
    expect(synced?.sessionGrants).toEqual({
      categories: ["shell"],
      shapes: ["git"],
    });
  });

  it("passes where an opt-out came from to the runtime", async () => {
    const { bus } = makeBus();
    const setAnalyticsEnabled = vi.fn(async (..._args: unknown[]) => {});
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: { sessionGrants: () => ({ categories: [], shapes: [] }) },
      setAnalyticsEnabled,
    } as unknown as AgentRuntime;
    const orchestrator = new PrivacyOrchestrator(runtime, bus);
    await orchestrator.setAnalyticsEnabled(false, "slash");
    expect(setAnalyticsEnabled).toHaveBeenLastCalledWith(false, "slash");
    // The settings-tab toggle flips the (now false) value back on.
    await orchestrator.toggleAnalytics();
    expect(setAnalyticsEnabled).toHaveBeenLastCalledWith(true, "settings");
  });
});
