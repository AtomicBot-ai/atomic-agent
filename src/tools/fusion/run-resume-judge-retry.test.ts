import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionRunStore, type FusionRunCheckpoint } from "./run-checkpoint.js";
import { planResume } from "./run-resume.js";

/**
 * After a judge-ordered retry the checkpoint row lists both attempts'
 * changed files (ATO-2488), as the live result does (ATO-1700). The
 * retry's own row carried only its files, so a run resumed after it
 * reported a shorter list.
 */

const TARGET = { providerId: "cloud", model: "judge-model" };
const TASK = [{ id: "t", title: "T", instructions: "write a.txt with the score", files: ["a.txt"] }];

function mode(): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    judge: TARGET,
  };
}

describe("a judge retry keeps the first attempt's files in the checkpoint (ATO-2488)", () => {
  let dir: string;
  let runsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "judge-retry-files-"));
    runsDir = mkdtempSync(join(tmpdir(), "judge-retry-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it("writes the merged list, so a resume carries both files", async () => {
    const store = new FusionRunStore({ dir: runsDir });
    // The run completes and its file is removed: keep what it last wrote.
    let last: FusionRunCheckpoint | undefined;
    const write = store.write.bind(store);
    store.write = (checkpoint) => {
      last = JSON.parse(JSON.stringify(checkpoint)) as FusionRunCheckpoint;
      write(checkpoint);
    };
    let judged = 0;
    let attempt = 0;
    let minted = 0;
    const deps = {
      runTurn: async (
        _session: unknown,
        _message: string,
        options: { eventHook?: (e: unknown) => void },
      ) => {
        attempt += 1;
        writeFileSync(join(dir, "a.txt"), `attempt ${attempt}`);
        const path = join(dir, attempt === 1 ? "a.txt" : "b.txt");
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: {
              tool: "os.fs.write",
              status: "ok",
              summary: "wrote",
              details: { path, diffstat: { added: attempt, removed: 0 } },
              truncated: false,
            },
            batchIndex: 0,
            batchSize: 1,
          },
        });
        return {
          session: createEmptySessionState({ id: "s-w", workingDir: dir }),
          reason: "reply",
          stepCount: 1,
        } as RunTurnResult;
      },
      createEphemeralSession: (meta: never) => {
        minted += 1;
        return createEmptySessionState({
          id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
          workingDir: dir,
          metadata: { fusionWorker: { ...(meta as object) } },
        });
      },
      approvals: {
        setSessionPolicy: () => {},
        clearSessionPolicy: () => {},
        fanoutScopes: new FanoutScopeRegistry(),
      },
      approvalRequired: false,
      emitEvent: () => {},
      workingDir: dir,
      slotManager: { poolSize: () => 4 },
      resolveRunMode: () => mode(),
      workerSupportsSlotAffinity: () => false,
      warmWorkerBackend: async () => {},
      outputCharCap: 4000,
      logger: new StructuredLogger({ level: "error", sinks: [] }),
      // Red on the first attempt, green on the retry.
      escalationComplete: async () => {
        judged += 1;
        return { content: JSON.stringify({ items: [{ id: "a2", pass: judged > 1, why: "x" }] }) };
      },
      runCheckpoints: store,
    } as unknown as FusionDelegateDeps;

    const result = await buildFusionDelegateTool(deps).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const both = [
      { path: join(dir, "a.txt"), added: 1, removed: 0 },
      { path: join(dir, "b.txt"), added: 2, removed: 0 },
    ];
    expect(attempt).toBe(2);
    expect(result.details.diffstats).toEqual(both);
    // The row as a restart would read it, and what the resume reports.
    expect(last?.tasks.find((t) => t.id === "t")?.result?.diffstats).toEqual(both);
    expect(planResume(last!).carried[0]?.diffstats).toEqual(both);
  });
});
