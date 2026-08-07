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

/** Minimal live-gate stand-in: one mutable flag + a call log. */
function makeRuntime(initialApprovalRequired: boolean) {
  const calls: boolean[] = [];
  let required = initialApprovalRequired;
  const runtime = {
    isApprovalRequired: () => required,
    setApprovalRequired: (value: boolean) => {
      calls.push(value);
      required = value;
    },
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

describe("PrivacyOrchestrator — approve everything", () => {
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

  it("refresh() reports the LIVE gate state and mirrors it into the session", () => {
    const { runtime } = makeRuntime(false); // e.g. booted with --no-approval
    const { actions, bus } = makeBus();
    new PrivacyOrchestrator(runtime, bus).refresh();
    const synced = actions.find((a) => a.type === "privacy_synced");
    expect(synced?.approveEverything).toBe(true);
    const mirrored = actions.find(
      (a) => a.type === "approval_required_changed",
    );
    expect(mirrored?.approvalRequired).toBe(false);
  });

  it("toggle ON hot-applies to the gate and persists agent.approvalRequired=false", async () => {
    const { runtime, calls } = makeRuntime(true);
    const { actions, bus } = makeBus();
    await new PrivacyOrchestrator(runtime, bus).toggleApproveEverything();

    expect(calls).toEqual([false]); // live gate flipped to auto-approve
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalRequired).toBe(false); // durable
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toContain("without asking");
    const synced = actions.filter((a) => a.type === "privacy_synced").at(-1);
    expect(synced?.approveEverything).toBe(true);
  });

  it("toggle OFF restores approvals live and in config.json", async () => {
    const { runtime, calls } = makeRuntime(false);
    const { actions, bus } = makeBus();
    await new PrivacyOrchestrator(runtime, bus).toggleApproveEverything();

    expect(calls).toEqual([true]);
    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalRequired).toBe(true);
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.message).toContain("ask for approval again");
  });

  it("surfaces a sticky error when the hot-apply throws", async () => {
    const { actions, bus } = makeBus();
    const runtime = {
      isApprovalRequired: () => true,
      setApprovalRequired: () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).toggleApproveEverything();
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toContain("boom");
  });

  it("names the already-rewritten config.json when persist won but hot-apply lost", async () => {
    // persistApprovalRequired runs first and succeeds (real state dir),
    // then the gate throws. The operator must learn the two surfaces
    // diverged: this process kept the old gate, the next boot will not.
    const { actions, bus } = makeBus();
    const runtime = {
      isApprovalRequired: () => true,
      setApprovalRequired: () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    await new PrivacyOrchestrator(runtime, bus).toggleApproveEverything();

    const onDisk = JSON.parse(
      readFileSync(getConfig().paths.userConfigFile, "utf8"),
    );
    expect(onDisk.agent.approvalRequired).toBe(false); // persist DID land
    const settled = actions.find((a) => a.type === "privacy_action_settled");
    expect(settled?.error).toContain("config.json was already rewritten");
    expect(settled?.error).toContain("next start uses the new value");
  });
});
