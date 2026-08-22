import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { DownloadChip } from "./download-chip.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function pull(over: Partial<LocalModelsPullState> = {}): LocalModelsPullState {
  return {
    kind: "chat",
    modelId: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    percent: 61,
    transferredBytes: 2_600_000_000,
    totalBytes: 4_220_000_000,
    error: null,
    ...over,
  };
}

describe("DownloadChip", () => {
  it("names the model and its progress in one row", () => {
    const view = render(<DownloadChip pull={pull()} />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("gemma-4-e4b");
    expect(frame).toContain("61%");
    expect(frame.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
  });

  /** Two samples, so the rate — and therefore the ETA — exists. */
  async function frameAt(budget: number): Promise<string> {
    const view = render(
      <DownloadChip pull={pull({ transferredBytes: 2_000_000_000 })} budget={budget} />,
    );
    view.rerender(<DownloadChip pull={pull()} budget={budget} />);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return strip(view.lastFrame() ?? "");
  }

  it("sheds the ETA, then the bar, as the row fills up", async () => {
    const wide = await frameAt(60);
    expect(wide).toContain("█");
    expect(wide).toMatch(/minute|second/);

    const medium = await frameAt(30);
    expect(medium).toContain("█");
    expect(medium).not.toMatch(/minute|second/);

    const tight = await frameAt(14);
    expect(tight).toContain("61%");
    expect(tight).not.toContain("█");
  });

  it("disappears rather than wrapping the one-row bar", () => {
    const view = render(<DownloadChip pull={pull()} budget={6} />);
    expect(strip(view.lastFrame() ?? "").trim()).toBe("");
  });

  it("names the runtime rather than a model id during the backend pull", () => {
    const view = render(<DownloadChip pull={pull({ kind: "backend", modelId: "_backend" })} />);
    expect(strip(view.lastFrame() ?? "")).toContain("llama.cpp");
  });

  describe("an 87-char custom Hugging Face id", () => {
    // The worst case `buildCustomModelId` can emit: `custom-` plus an
    // 80-char slug. Uncapped, this alone out-spent every row budget.
    const LONG_ID = `custom-${"unsloth-qwen3-coder-30b-a3b-instruct-gguf-q4-k-m".padEnd(80, "x")}`;
    // The displayed cap: 29 chars of the id, then an ellipsis.
    const SHOWN = `${LONG_ID.slice(0, 29)}…`;

    function longFrame(budget: number): string {
      const view = render(<DownloadChip pull={pull({ modelId: LONG_ID })} budget={budget} />);
      return strip(view.lastFrame() ?? "");
    }

    it("really is the id builder's worst case", () => {
      expect(LONG_ID).toHaveLength(87);
    });

    it("draws at most 30 label columns, ellipsis included, in the full form", async () => {
      // Two renders so the rate — and therefore the ETA — exists.
      const view = render(
        <DownloadChip
          pull={pull({ modelId: LONG_ID, transferredBytes: 2_000_000_000 })}
          budget={100}
        />,
      );
      view.rerender(<DownloadChip pull={pull({ modelId: LONG_ID })} budget={100} />);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const frame = strip(view.lastFrame() ?? "");
      expect(frame).toContain(SHOWN);
      expect(frame).not.toContain(LONG_ID);
      expect(frame).toContain("█");
      expect(frame).toMatch(/minute|second/);
      expect(frame.length).toBeLessThanOrEqual(100);
    });

    it("keeps the bar form inside a 60-column budget instead of overflowing", () => {
      const frame = longFrame(60);
      expect(frame).toContain(SHOWN);
      expect(frame).toContain("█");
      expect(frame).not.toMatch(/minute|second/);
      expect(frame.length).toBeLessThanOrEqual(60);
    });

    it("sheds to percent-only at a budget where a short id still gets its bar", () => {
      // Budget 30 is the medium form for `gemma-4-e4b` above; the
      // capped label prices the bar form at 49 columns, so the chip
      // drops the name rather than pushing the header onto a second row.
      const frame = longFrame(30);
      expect(frame).not.toContain("█");
      expect(frame).not.toContain(SHOWN);
      expect(frame).toContain("61%");
      expect(frame.length).toBeLessThanOrEqual(30);
    });

    it("still disappears under the minimal budget", () => {
      expect(longFrame(6).trim()).toBe("");
    });
  });
});
