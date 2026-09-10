import { describe, expect, it } from "vitest";

import {
  cloudState,
  fusionState,
  localState,
} from "./composer-switch-fixtures.js";
import { selectComposerSwitchRows } from "./composer-switch-rows.js";
import {
  selectComposerWorkersLabel,
  selectWorkerRows,
} from "./composer-switch-worker-rows.js";

describe("the workers switch", () => {
  it("offers both kinds for the worker slot, and no counts", () => {
    // The slot takes either kind: the models on disk, and every cloud
    // provider that is not already holding the orchestrator slot. The
    // count rows are gone — the machine sizes the pool and the
    // orchestrator sizes each fan-out.
    const rows = selectWorkerRows(fusionState());
    expect(rows[0]?.label).toBe("qwen-3.5-4b");
    expect(rows[0]?.detail).toBe("workers · on this machine");
    expect(rows.map((row) => row.label)).toEqual([
      "qwen-3.5-4b",
      "aimlapi",
      "Download more models…",
    ]);
    expect(rows.find((row) => row.label === "aimlapi")?.intent).toEqual({
      kind: "fusionLeg",
      leg: "worker",
      providerId: "aimlapi",
    });
    expect(rows.some((row) => /worker(s)?$/.test(row.label))).toBe(false);
  });

  it("never offers the orchestrator's own provider as its workers", () => {
    // Fanning out to the model that is doing the orchestrating buys
    // nothing and doubles the bill.
    const rows = selectWorkerRows(fusionState());
    expect(rows.some((row) => row.label === "openrouter")).toBe(false);
  });

  it("marks the model in force", () => {
    const rows = selectWorkerRows(fusionState({ workers: 4 }));
    expect(rows.filter((row) => row.active).map((row) => row.label)).toEqual([
      "qwen-3.5-4b",
    ]);
  });

  it("carries the one intent the activation path still branches on", () => {
    const rows = selectWorkerRows(fusionState());
    expect(rows.find((row) => row.label === "qwen-3.5-4b")?.intent).toEqual({
      kind: "fusionWorkerModel",
      modelId: "qwen-3.5-4b",
    });
    expect(rows.some((row) => row.intent?.kind === "fusionWorkers")).toBe(false);
  });

  it("never offers a model that is not on disk", () => {
    const base = fusionState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: base.localModelsPanel.rows.map((row) => ({
          ...row,
          downloaded: false,
        })),
      },
    };
    expect(
      selectWorkerRows(state).some(
        (row) => row.intent.kind === "fusionWorkerModel",
      ),
    ).toBe(false);
  });

  it("is the switch's rows for the `workers` kind", () => {
    const state = fusionState();
    expect(selectComposerSwitchRows(state, "workers")).toEqual(
      selectWorkerRows(state),
    );
  });
});

describe("the meta bar's worker label", () => {
  it("states the machine's capacity on the fusion route, not a setting", () => {
    // "up to N": N is what this machine serves at once, not a number
    // anyone picked and not a promise about this turn.
    expect(selectComposerWorkersLabel(fusionState())).toBe("up to 2 workers");
    expect(selectComposerWorkersLabel(fusionState({ workers: 1 }))).toBe(
      "up to 1 worker",
    );
  });

  it("says nothing anywhere else", () => {
    expect(selectComposerWorkersLabel(cloudState())).toBeNull();
    expect(selectComposerWorkersLabel(localState())).toBeNull();
    expect(
      selectComposerWorkersLabel(fusionState({ effective: "cloud" })),
    ).toBeNull();
  });
});
