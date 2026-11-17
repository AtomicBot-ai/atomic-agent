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

  it("refresh() reports offline mode unsupported on a runtime without the switch", () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: { sessionGrants: () => ({ categories: [], shapes: [] }) },
    } as unknown as AgentRuntime;
    new PrivacyOrchestrator(runtime, bus).refresh();
    const synced = actions.find((a) => a.type === "privacy_synced");
    expect(synced?.offline).toEqual({
      supported: false,
      enabled: false,
      egress: null,
    });
  });

  it("toggleOffline() does nothing to a runtime without the switch", async () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: { sessionGrants: () => ({ categories: [], shapes: [] }) },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).toggleOffline();
    expect(actions.some((a) => a.type === "privacy_action_started")).toBe(false);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toContain("not available");
  });

  it("toggleOffline() flips the agent's switch and re-reads its counter", async () => {
    const { actions, bus } = makeBus();
    let enabled = false;
    const setEnabled = vi.fn(async (on: boolean) => {
      enabled = on;
    });
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: { sessionGrants: () => ({ categories: [], shapes: [] }) },
      offlineMode: {
        isEnabled: () => enabled,
        setEnabled,
        egress: () => ({
          bytesOut: 0,
          requestsOut: 0,
          requestsBlocked: 1,
          since: "2026-11-12T10:00:00.000Z",
        }),
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).toggleOffline();
    expect(setEnabled).toHaveBeenCalledWith(true);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toBe("offline mode on");
    const synced = actions.filter((a) => a.type === "privacy_synced").pop();
    expect(synced?.offline).toEqual({
      supported: true,
      enabled: true,
      egress: {
        bytesOut: 0,
        requestsOut: 0,
        requestsBlocked: 1,
        since: "2026-11-12T10:00:00.000Z",
      },
    });
  });

  it("toggleOffline() shows the agent's error and still re-reads", async () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      approvals: { sessionGrants: () => ({ categories: [], shapes: [] }) },
      offlineMode: {
        isEnabled: () => false,
        setEnabled: async () => {
          throw new Error("config is read-only");
        },
        egress: () => ({ bytesOut: 10, requestsOut: 1, requestsBlocked: 0, since: "2026-11-12T10:00:00.000Z" }),
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).toggleOffline();
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toBe("offline mode toggle failed: config is read-only");
    const synced = actions.filter((a) => a.type === "privacy_synced").pop();
    expect((synced?.offline as { enabled: boolean }).enabled).toBe(false);
  });
});
