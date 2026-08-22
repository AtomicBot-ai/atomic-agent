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
});
