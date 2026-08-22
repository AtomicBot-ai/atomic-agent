import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadAmbientRows,
  MIN_ATOM_ROWS,
  OnboardingDownloadAmbient,
} from "./onboarding-download-ambient.js";
import { ATOM_COLLISION_GLYPH, ATOM_GLYPH } from "../onboarding/atom-field.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

type View = ReturnType<typeof render>;

// Every mounted field owns a running interval. Left alive, they pile up
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

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

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

function ambient(
  props: Partial<React.ComponentProps<typeof OnboardingDownloadAmbient>> = {},
) {
  return (
    <OnboardingDownloadAmbient
      pull={pull()}
      pullError={null}
      columns={98}
      viewportRows={28}
      mark="sm"
      offerCloud
      {...props}
    />
  );
}

describe("downloadAmbientRows", () => {
  /**
   * Expected values are `floor((viewportRows − block)/2) − 1`, the
   * bottom spacer's share of the free rows minus the one-row gap that
   * keeps the atoms off the offer. Blocks: sm mark 14 rows with the
   * offer (10 without), xs mark 13 — pinned by the download step's own
   * row-count test.
   */
  const table: {
    name: string;
    input: Parameters<typeof downloadAmbientRows>[0];
    rows: number;
  }[] = [
    {
      name: "a full-size terminal with the offer showing",
      input: { viewportRows: 28, mark: "sm", offerCloud: true },
      rows: 6,
    },
    {
      name: "the same terminal once the offer is spent",
      input: { viewportRows: 28, mark: "sm", offerCloud: false },
      rows: 8,
    },
    {
      name: "a header that dropped its mark",
      input: { viewportRows: 28, mark: "xs", offerCloud: true },
      rows: 6,
    },
    {
      name: "the 80×24 fallback terminal",
      input: { viewportRows: 22, mark: "sm", offerCloud: true },
      rows: 3,
    },
    {
      name: "a terminal with a gap but no field",
      input: { viewportRows: 18, mark: "sm", offerCloud: true },
      rows: 1,
    },
    {
      name: "a terminal smaller than the block itself",
      input: { viewportRows: 10, mark: "sm", offerCloud: true },
      rows: 0,
    },
  ];

  for (const row of table) {
    it(`gives ${row.rows} rows to ${row.name}`, () => {
      expect(downloadAmbientRows(row.input)).toBe(row.rows);
    });
  }
});

describe("OnboardingDownloadAmbient", () => {
  it("draws no more rows than the placement's budget allows", () => {
    const view = mount(ambient());
    const lines = strip(view.lastFrame() ?? "").split("\n");
    const budget = downloadAmbientRows({
      viewportRows: 28,
      mark: "sm",
      offerCloud: true,
    });
    expect(lines.length).toBe(budget);
    expect(lines.some((line) => line.includes(ATOM_GLYPH))).toBe(true);
  });

  it("stays out when the budget dips under the minimum", () => {
    // 18 viewport rows leave one free row below the block: a gap, not a
    // field, so nothing mounts at all.
    const view = mount(ambient({ viewportRows: 18 }));
    expect(downloadAmbientRows({ viewportRows: 18, mark: "sm", offerCloud: true }))
      .toBeLessThan(MIN_ATOM_ROWS);
    expect(strip(view.lastFrame() ?? "")).not.toContain(ATOM_GLYPH);
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
    expect(await frameMoves(mount(ambient({ atomStepMs: 20 })), 4000)).toBe(true);
  });

  it("clears out once the weights are all the way down", () => {
    const frame = strip(mount(ambient({ pull: pull({ percent: 100 }) })).lastFrame() ?? "");
    expect(frame).not.toContain(ATOM_GLYPH);
  });

  it("keeps drifting while the runtime phase reports 100%", () => {
    // Only finished weights end the wait: the runtime zip landing at
    // 100% just means the weights are about to start.
    const view = mount(
      ambient({ pull: pull({ kind: "backend", modelId: "_backend", percent: 100 }) }),
    );
    expect(strip(view.lastFrame() ?? "")).toContain(ATOM_GLYPH);
  });

  it("goes still the moment the pull fails", async () => {
    // Driven the way a real failure arrives, not hand-built: the pull
    // runs, then `local_models_pull_failed` nulls it and sets the
    // panel's error line. The field must leave with it — no atoms, and
    // no interval repainting a screen under a bar that will never move
    // again.
    const view = mount(ambient({ atomStepMs: 20 }));
    expect(strip(view.lastFrame() ?? "")).toContain(ATOM_GLYPH);
    view.rerender(ambient({ pull: null, pullError: "connection reset", atomStepMs: 20 }));
    expect(strip(view.lastFrame() ?? "")).not.toContain(ATOM_GLYPH);
    expect(await frameMoves(view, 500)).toBe(false);
  });

  /** Atoms visible in a frame, hot or cold — a collision is still an atom. */
  const atomsDrawn = (frame: string): number =>
    frame.split(ATOM_GLYPH).length + frame.split(ATOM_COLLISION_GLYPH).length - 2;

  it("thins the population when the pane is only just tall enough", () => {
    // 22 viewport rows budget three rows of field, the smallest that
    // draws at all (the table above). A full population there is hot 22%
    // of the time; two keep the collision an event (measured 2% — see
    // atom-field.test.ts). The default geometry's 97×6 pane earns more.
    const small = atomsDrawn(strip(mount(ambient({ viewportRows: 22 })).lastFrame() ?? ""));
    const full = atomsDrawn(strip(mount(ambient()).lastFrame() ?? ""));
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThanOrEqual(2);
    expect(full).toBeGreaterThan(2);
  });

  it("re-fits the population when the terminal shrinks mid-download", async () => {
    // The interval survives a resize by design; the population must
    // not. The step is parked hours out so the only thing that can
    // change the frame is the resize rebuild itself: the settled frame
    // must be the very placement a fresh mount at the small geometry
    // draws — same seed, same count arithmetic — not the old field
    // clipped to fewer rows.
    const PARKED_STEP_MS = 3_600_000;
    const fresh = strip(
      mount(ambient({ viewportRows: 22, atomStepMs: PARKED_STEP_MS })).lastFrame() ?? "",
    );
    expect(atomsDrawn(fresh)).toBe(2);
    const view = mount(ambient({ atomStepMs: PARKED_STEP_MS }));
    expect(atomsDrawn(strip(view.lastFrame() ?? ""))).toBe(3);
    view.rerender(ambient({ viewportRows: 22, atomStepMs: PARKED_STEP_MS }));
    // The rebuild lands in an effect, one Ink commit after the resize.
    const until = Date.now() + 4000;
    while (strip(view.lastFrame() ?? "") !== fresh && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(strip(view.lastFrame() ?? "")).toBe(fresh);
  });
});
