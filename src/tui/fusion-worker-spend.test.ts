import { describe, expect, it } from "vitest";
import {
  formatFusionLiveWorker,
  fusionWorkerActionsHint,
  reduceFusionLiveWorkers,
} from "./fusion-live-workers.js";
import { dispatchSlashCommand } from "./commands/slash-command-handler.js";

const base = {
  type: "fusion_worker" as const,
  taskId: "ui",
  title: "UI",
  role: "worker" as const,
  model: "small",
};

describe("a worker row's $ and tokens, and its actions", () => {
  it("shows tokens, spend and the id the actions take while the worker runs", () => {
    let rows = reduceFusionLiveWorkers([], { ...base, phase: "started" }, 0);
    rows = reduceFusionLiveWorkers(
      rows,
      { ...base, phase: "usage", contextTokens: 8_000, tokens: 41_200, spentUsd: 0.031 },
      0,
    );
    const line = formatFusionLiveWorker(rows[0]!, 12_000);
    expect(line).toContain("41.2k tok · $0.03");
    expect(fusionWorkerActionsHint(rows)).toBe(
      "/worker stop <id> · /worker escalate <id> — running: ui",
    );
    // A finished row keeps its totals; nothing is left to act on.
    rows = reduceFusionLiveWorkers(rows, { ...base, phase: "finished" }, 20_000);
    expect(formatFusionLiveWorker(rows[0]!, 30_000)).toContain("$0.03");
    expect(fusionWorkerActionsHint(rows)).toBeNull();
  });

  it("shows no $ for an unpriced (local) worker, only tokens", () => {
    let rows = reduceFusionLiveWorkers([], { ...base, phase: "started" }, 0);
    rows = reduceFusionLiveWorkers(rows, { ...base, phase: "usage", tokens: 900 }, 0);
    expect(formatFusionLiveWorker(rows[0]!, 1_000)).not.toContain("$");
  });

  it("parses /worker stop|escalate <id> and refuses anything else", () => {
    expect(dispatchSlashCommand("/worker stop ui").fusionWorkerAction).toEqual({
      action: "stop",
      taskId: "ui",
    });
    expect(dispatchSlashCommand("/worker escalate core").fusionWorkerAction).toEqual({
      action: "escalate",
      taskId: "core",
    });
    const bad = dispatchSlashCommand("/worker kill ui");
    expect(bad.fusionWorkerAction).toBeUndefined();
    expect(bad.systemMessage).toMatch(/usage: \/worker stop <id>/);
  });
});
