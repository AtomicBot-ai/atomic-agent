import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { atomRowBudget, OnboardingDownloadStep } from "./onboarding-download-step.js";
import { ATOM_GLYPH } from "../onboarding/atom-field.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

type View = ReturnType<typeof render>;

// Every mounted screen owns a running interval. Left alive, they pile up
// across the file and starve Ink's commits, which is enough to make a
// frame that should have moved look frozen.
const mounted: View[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function mount(node: React.ReactElement): View {
  const view = render(node);
  mounted.push(view);
  return view;
}

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

function pull(over: Partial<LocalModelsPullState> = {}): LocalModelsPullState {
  return {
    kind: "chat",
    modelId: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    percent: 38,
    transferredBytes: 1_600_000_000,
    totalBytes: 4_220_000_000,
    error: null,
    ...over,
  };
}

function step(props: Partial<React.ComponentProps<typeof OnboardingDownloadStep>> = {}) {
  return (
    <OnboardingDownloadStep
      pull={pull()}
      modelLabel="gemma-4-e4b"
      columns={100}
      rows={30}
      markHeader
      {...props}
    />
  );
}

describe("OnboardingDownloadStep", () => {
  it("says what is happening before the first progress event lands", () => {
    const view = mount(step({ pull: null }));
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Downloading gemma-4-e4b");
    expect(frame).toContain("starting");
  });

  it("reports bytes and percent for the phase in flight", () => {
    const view = mount(step());
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("model weights");
    expect(frame).toContain("38%");
    expect(frame).toContain("1.6 GB / 4.2 GB");
  });

  it("shows the runtime phase as done once the weights start", () => {
    const view = mount(step());
    const line = strip(view.lastFrame() ?? "")
      .split("\n")
      .find((row) => row.includes("llama.cpp runtime"));
    expect(line).toContain("done");
  });

  it("marks the weights as waiting while the runtime is still coming down", () => {
    const view = mount(
      step({ pull: pull({ kind: "backend", modelId: "_backend", percent: 6 }) }),
    );
    const frame = strip(view.lastFrame() ?? "");
    const weights = frame.split("\n").find((row) => row.includes("model weights"));
    expect(weights).toContain("waiting");
    expect(frame).toContain("6%");
  });

  it("surfaces a failed pull instead of a silent stall", () => {
    const view = mount(step({ pull: pull({ error: "connection reset" }) }));
    expect(strip(view.lastFrame() ?? "")).toContain("connection reset");
  });

  it("estimates a rate once a second sample arrives", async () => {
    const view = mount(step({ pull: pull({ transferredBytes: 1_000_000_000 }) }));
    expect(strip(view.lastFrame() ?? "")).toContain("estimating");
    view.rerender(step({ pull: pull({ transferredBytes: 1_400_000_000 }) }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(strip(view.lastFrame() ?? "")).toMatch(/\/s /);
  });
});

describe("atomRowBudget", () => {
  const table: { name: string; input: Parameters<typeof atomRowBudget>[0]; rows: number }[] = [
    {
      name: "a full-size terminal with the offer showing",
      input: { rows: 30, markHeader: true, hasError: false, offerCloud: true },
      rows: 13,
    },
    {
      name: "the same terminal once the offer is spent",
      input: { rows: 30, markHeader: true, hasError: false, offerCloud: false },
      rows: 17,
    },
    {
      name: "an error line pushing the field down two rows",
      input: { rows: 30, markHeader: true, hasError: true, offerCloud: true },
      rows: 11,
    },
    {
      name: "a header that dropped its mark",
      input: { rows: 30, markHeader: false, hasError: false, offerCloud: true },
      rows: 14,
    },
    {
      name: "a terminal with no room left at all",
      input: { rows: 17, markHeader: true, hasError: false, offerCloud: true },
      rows: 0,
    },
    {
      name: "a terminal smaller than its own chrome",
      input: { rows: 6, markHeader: true, hasError: false, offerCloud: true },
      rows: 0,
    },
  ];

  for (const row of table) {
    it(`gives ${row.rows} rows to ${row.name}`, () => {
      expect(atomRowBudget(row.input)).toBe(row.rows);
    });
  }
});

describe("the atom field under the bars", () => {
  const lines = (view: { lastFrame(): string | undefined }): string[] =>
    strip(view.lastFrame() ?? "").split("\n");

  it("drifts in the free space below the offer", () => {
    const rows = lines(mount(step()));
    const atomRow = rows.findIndex((row) => row.includes(ATOM_GLYPH));
    const barRow = rows.findIndex((row) => row.includes("model weights"));
    const offerRow = rows.findIndex((row) => row.includes("press c"));
    expect(atomRow).toBeGreaterThan(barRow);
    expect(atomRow).toBeGreaterThan(offerRow);
  });

  it("never lands on a bar row or on the offer", () => {
    const rows = lines(mount(step()));
    for (const row of rows) {
      if (!row.includes(ATOM_GLYPH)) continue;
      expect(row).not.toContain("█");
      expect(row).not.toContain("░");
      expect(row).not.toContain("press c");
      expect(row).not.toContain("Downloading");
    }
  });

  it("stays inside the rows the budget reserved for it", () => {
    const rows = lines(mount(step()));
    const barRow = rows.findIndex((row) => row.includes("model weights"));
    const budget = atomRowBudget({
      rows: 30,
      markHeader: true,
      hasError: false,
      offerCloud: true,
    });
    const drawn = rows.filter((row) => row.includes(ATOM_GLYPH)).length;
    expect(barRow).toBeGreaterThanOrEqual(0);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(budget);
  });

  it("stays out of a terminal with no room to spare", () => {
    const frame = strip(mount(step({ rows: 18 })).lastFrame() ?? "");
    expect(frame).not.toContain(ATOM_GLYPH);
    expect(frame).toContain("model weights");
  });

  /**
   * Polls for a frame that differs, rather than sleeping for one step
   * and asserting. Ink commits at its own pace under the testing
   * library, far slower than any step interval, so the deadline is
   * generous and the assertion is on progress, never on timing.
   */
  async function frameMoves(view: View, deadlineMs: number): Promise<boolean> {
    const first = strip(view.lastFrame() ?? "");
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (strip(view.lastFrame() ?? "") !== first) return true;
    }
    return false;
  }

  it("drifts on its own while the download runs", async () => {
    expect(await frameMoves(mount(step({ atomStepMs: 20 })), 4000)).toBe(true);
  });

  it("clears out once the weights are all the way down", () => {
    const frame = strip(mount(step({ pull: pull({ percent: 100 }) })).lastFrame() ?? "");
    expect(frame).not.toContain(ATOM_GLYPH);
  });

  it("goes still the moment there is nothing left to wait for", async () => {
    // A failed pull ends the wait: no field, and no interval left
    // repainting a screen under a bar that will never move again.
    const stalled = mount(step({ pull: pull({ error: "connection reset" }), atomStepMs: 20 }));
    expect(strip(stalled.lastFrame() ?? "")).not.toContain(ATOM_GLYPH);
    expect(await frameMoves(stalled, 500)).toBe(false);
  });
});
