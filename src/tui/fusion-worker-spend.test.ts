import { describe, expect, it } from "vitest";
import {
  formatFusionLiveWorker,
  fusionWorkerActionsHint,
  reduceFusionLiveWorkers,
} from "./fusion-live-workers.js";
import {
  dispatchSlashCommand,
  parseWorkerCommand,
} from "./commands/slash-command-handler.js";

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
      "/worker stop <id> · /worker escalate <id> · /worker steer <id> <note> — running: ui",
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

  it("parses /worker steer <id> <note> and keeps the note as typed (ATO-568)", () => {
    expect(
      dispatchSlashCommand("/worker steer ui use the  existing Button, not a new one").fusionWorkerAction,
    ).toEqual({
      action: "steer",
      taskId: "ui",
      text: "use the  existing Button, not a new one",
    });
    // Multi-line notes survive: only the ends are trimmed.
    expect(parseWorkerCommand("steer core first line\nsecond line  ")).toEqual({
      action: "steer",
      taskId: "core",
      text: "first line\nsecond line",
    });
  });

  it("refuses a steer with no note or no id, and a stop with extra words", () => {
    expect(parseWorkerCommand("steer ui")).toBeNull();
    expect(parseWorkerCommand("steer ui    ")).toBeNull();
    expect(parseWorkerCommand("steer")).toBeNull();
    expect(parseWorkerCommand("stop ui now")).toBeNull();
    expect(parseWorkerCommand("")).toBeNull();
    const bad = dispatchSlashCommand("/worker steer ui");
    expect(bad.fusionWorkerAction).toBeUndefined();
    expect(bad.systemMessage).toMatch(/\/worker steer <id> <note>/);
  });
});
