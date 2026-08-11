import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrivacyOrchestrator } from "./privacy-orchestrator.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { getConfig, resetConfigCache } from "../../config/index.js";

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

/** Minimal live-gate stand-in: one mutable level + a call log. */
function makeRuntime(initialLevel: number) {
  const calls: number[] = [];
  let level = initialLevel;
  const runtime = {
    getApprovalLevel: () => level,
    setApprovalLevel: (value: number) => {
      calls.push(value);
      level = value;
    },
    approvals: {
      sessionGrants: () => ({ categories: [], shapes: [] }),
    },
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

describe("PrivacyOrchestrator — approval level", () => {
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

  it("refresh() reports the LIVE gate level and mirrors it into the session", () => {
    const { runtime } = makeRuntime(5); // e.g. booted with --no-approval
    const { actions, bus } = makeBus();
    new PrivacyOrchestrator(runtime, bus).refresh();
    const synced = actions.find((a) => a.type === "privacy_synced");
    expect(synced?.approvalLevel).toBe(5);
    const mirrored = actions.find((a) => a.type === "approval_level_changed");
    expect(mirrored?.approvalLevel).toBe(5);
  });

  it("refresh() mirrors the live session grants into the panel snapshot", () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      setApprovalLevel: () => {},
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

  it("setApprovalLevel(5) hot-applies to the gate and persists agent.approvalLevel", async () => {
    const { runtime, calls } = makeRuntime(1);
    const { actions, bus } = makeBus();
    await new PrivacyOrchestrator(runtime, bus).setApprovalLevel(5);

    expect(calls).toEqual([5]); // live gate moved
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(5); // durable
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toContain("without asking");
    const synced = actions.filter((a) => a.type === "privacy_synced").at(-1);
    expect(synced?.approvalLevel).toBe(5);
  });

  it("setApprovalLevel(1) restores the strictest level live and in config.json", async () => {
    const { runtime, calls } = makeRuntime(5);
    const { actions, bus } = makeBus();
    await new PrivacyOrchestrator(runtime, bus).setApprovalLevel(1);

    expect(calls).toEqual([1]);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(1);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toContain("asks first");
  });

  it("names each mid-ladder level honestly in the settled message", async () => {
    const { runtime, bus, actions } = {
      ...makeRuntime(1),
      ...makeBus(),
    };
    const orch = new PrivacyOrchestrator(runtime, bus);
    await orch.setApprovalLevel(2);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toContain("2 (workspace)");
    expect(settled?.message).toContain("inside the project");
  });

  it("clamps out-of-range slash-command input before persisting", async () => {
    const { runtime, calls } = makeRuntime(1);
    const { bus } = makeBus();
    await new PrivacyOrchestrator(runtime, bus).setApprovalLevel(42);
    expect(calls).toEqual([5]);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(5);
  });

  it("surfaces a sticky error when the hot-apply throws", async () => {
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      setApprovalLevel: () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).setApprovalLevel(3);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toContain("boom");
  });

  it("names the already-rewritten config.json when persist won but hot-apply lost", async () => {
    // persistApprovalLevel runs first and succeeds (real state dir),
    // then the gate throws. The operator must learn the two surfaces
    // diverged: this process kept the old gate, the next boot will not.
    const { actions, bus } = makeBus();
    const runtime = {
      getApprovalLevel: () => 1,
      setApprovalLevel: () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).setApprovalLevel(4);

    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalLevel).toBe(4); // persist DID land
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toContain("config.json was already rewritten");
    expect(settled?.error).toContain("next start uses the new value");
  });
});
