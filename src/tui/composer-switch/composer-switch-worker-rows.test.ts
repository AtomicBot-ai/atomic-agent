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
  it("lists the downloaded local models, then every worker count, then the deep link", () => {
    const rows = selectWorkerRows(fusionState());
    expect(rows[0]?.label).toBe("qwen-3.5-4b");
    expect(rows[0]?.detail).toBe("worker model");
    expect(rows.slice(1, 9).map((row) => row.label)).toEqual([
      "1 worker",
      "2 workers",
      "3 workers",
      "4 workers",
      "5 workers",
      "6 workers",
      "7 workers",
      "8 workers",
    ]);
    expect(rows.at(-1)?.label).toBe("Download more models…");
  });

  it("marks the model in force and the count in force", () => {
    const rows = selectWorkerRows(fusionState({ workers: 4 }));
    expect(rows.filter((row) => row.active).map((row) => row.label)).toEqual([
      "qwen-3.5-4b",
      "4 workers",
    ]);
  });

  it("carries the intents the activation path branches on", () => {
    const rows = selectWorkerRows(fusionState());
    expect(rows.find((row) => row.label === "qwen-3.5-4b")?.intent).toEqual({
      kind: "fusionWorkerModel",
      modelId: "qwen-3.5-4b",
    });
    expect(rows.find((row) => row.label === "3 workers")?.intent).toEqual({
      kind: "fusionWorkers",
      workers: 3,
    });
  });

  it("says the slot count is the operator's problem on an external server", () => {
    const base = fusionState();
    const external = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        configMode: "external" as const,
      },
    };
    expect(
      selectWorkerRows(external).find((row) => row.label === "2 workers")
        ?.detail,
    ).toBe("external server — set --parallel yourself");
    expect(
      selectWorkerRows(base).find((row) => row.label === "2 workers")?.detail,
    ).toBe("llama-server --parallel 2 · restart to apply");
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
  it("counts the workers on the fusion route", () => {
    expect(selectComposerWorkersLabel(fusionState())).toBe("2 workers");
    expect(selectComposerWorkersLabel(fusionState({ workers: 1 }))).toBe(
      "1 worker",
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
