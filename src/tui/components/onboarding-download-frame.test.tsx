import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OnboardingScreen } from "./onboarding-screen.js";
import {
  downloadAmbientRows,
  MIN_ATOM_ROWS,
} from "./onboarding-download-ambient.js";
import { countOnboardingDownloadBlockRows } from "./onboarding-download-step.js";
import { resetConfigCache } from "../../config/index.js";
import { ATOM_GLYPH } from "../onboarding/atom-field.js";
import { createOnboardingState } from "../onboarding/onboarding-state.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { renderAtSize, type SizedRenderResult } from "../test-sized-render.js";
import { FOOTER_ROWS, SURFACE_PADDING_TOP } from "./onboarding-surface-layout.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

/**
 * Counters chosen to fill `PROGRESS_TEMPLATE_LINE` exactly — the
 * runtime phase at 100% with three-digit gigabyte counts — so the
 * drawn bar row is as wide as the width the block was measured at and
 * the balance can be asserted to the cell. The weights have not
 * started, so the field is still live.
 */
const TEMPLATE_WIDE_PULL = {
  kind: "backend",
  modelId: "_backend",
  label: "llama.cpp runtime",
  percent: 100,
  transferredBytes: 400_100_000_000,
  totalBytes: 999_900_000_000,
  error: null,
} as const;

function downloadScreen() {
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step: "local_download" as const,
    localModelId: "gemma-4-e4b",
  };
  const base = createInitialTuiState(fakeSession(), 50);
  const state = {
    ...base,
    localModelsPanel: { ...base.localModelsPanel, pull: TEMPLATE_WIDE_PULL },
    onboarding,
  };
  return (
    <OnboardingScreen
      state={state}
      onboarding={onboarding}
      dispatch={() => {}}
      callbacks={{}}
    />
  );
}

describe("the download screen's frame", () => {
  let stateDir: string;
  let originalEnv: string | undefined;
  const views: SizedRenderResult[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-download-frame-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    while (views.length > 0) views.pop()?.unmount();
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function frameAt(size: { columns: number; rows: number }): string[] {
    const view = renderAtSize(downloadScreen(), size);
    views.push(view);
    return strip(view.lastFrame() ?? "").split("\n");
  }

  // Both target sizes keep the sm mark, and a fresh state dir means no
  // cloud provider — the meanwhile offer is on screen.
  const BLOCK_ROWS = countOnboardingDownloadBlockRows({ mark: "sm", offerCloud: true });

  for (const size of [
    { name: "full 100×30", columns: 100, rows: 30 },
    { name: "fallback 80×24", columns: 80, rows: 24 },
  ]) {
    it(`centres the text and keeps the atoms ambient at ${size.name}`, () => {
      const lines = frameAt(size);

      // The footer is pinned to the true last row of the terminal.
      expect(lines.length).toBe(size.rows);
      expect(lines.at(-1)).toContain("ctrl+c");

      // The bars sit balanced: their leading space matches the space
      // their row leaves on the right, within the odd-column cell. The
      // pull's counters fill the measured template, so the drawn row IS
      // the measured width (clamped by the terminal at 80 columns).
      const bars = lines.find((line) => line.includes("llama.cpp runtime")) ?? "";
      const leading = bars.length - bars.trimStart().length;
      const width = bars.trimEnd().length - leading;
      expect(width).toBeGreaterThan(0);
      expect(Math.abs(leading - (size.columns - width) / 2)).toBeLessThanOrEqual(1);
      expect(leading).toBeGreaterThan(0);

      // The block is centred vertically too: the first drawn row sits a
      // spacer's share below the surface padding (±1 for Yoga's split of
      // an odd remainder).
      const viewportRows = size.rows - SURFACE_PADDING_TOP - FOOTER_ROWS;
      const firstDrawn = lines.findIndex((line) => line.trim().length > 0);
      const expectedTop =
        SURFACE_PADDING_TOP + Math.floor((viewportRows - BLOCK_ROWS) / 2);
      expect(Math.abs(firstDrawn - expectedTop)).toBeLessThanOrEqual(1);

      // The skip row is the block's last line, under the cloud offer.
      const offerRow = lines.findIndex((line) => line.includes("press c"));
      const skipRow = lines.findIndex((line) => line.includes("press s"));
      expect(offerRow).toBeGreaterThan(0);
      expect(skipRow).toBeGreaterThan(offerRow);

      // The atoms drift below the text, never over it — when the budget
      // clears the field's minimum at all. The skip row costs the block
      // three rows, and at 80×24 that squeezes the ambience below
      // `MIN_ATOM_ROWS`: decoration yields to content, so the frame is
      // asserted against the same budget the field reads.
      const budget = downloadAmbientRows({
        viewportRows: size.rows - SURFACE_PADDING_TOP - FOOTER_ROWS,
        mark: "sm",
        offerCloud: true,
      });
      const atomRows = lines
        .map((line, index) => ({ line, index }))
        .filter((row) => row.line.includes(ATOM_GLYPH));
      if (budget >= MIN_ATOM_ROWS) {
        expect(atomRows.length).toBeGreaterThan(0);
      } else {
        expect(atomRows.length).toBe(0);
      }
      for (const row of atomRows) {
        expect(row.index).toBeGreaterThan(skipRow);
        expect(row.line).not.toContain("█");
        expect(row.line).not.toContain("░");
        expect(row.line).not.toContain("Downloading");
        expect(row.line).not.toContain("press c");
        expect(row.line).not.toContain("press s");
      }
    });
  }

  it("keeps the block centred once the download is done and the field has left", () => {
    const view = renderAtSize(
      (() => {
        const onboarding = {
          ...createOnboardingState("http://127.0.0.1:8080"),
          step: "local_download" as const,
          localModelId: "gemma-4-e4b",
        };
        const base = createInitialTuiState(fakeSession(), 50);
        const state = {
          ...base,
          localModelsPanel: {
            ...base.localModelsPanel,
            pull: { ...TEMPLATE_WIDE_PULL, kind: "chat" as const, modelId: "gemma-4-e4b" },
          },
          onboarding,
        };
        return (
          <OnboardingScreen
            state={state}
            onboarding={onboarding}
            dispatch={() => {}}
            callbacks={{}}
          />
        );
      })(),
      { columns: 100, rows: 30 },
    );
    views.push(view);
    const lines = strip(view.lastFrame() ?? "").split("\n");
    // Finished weights: no atoms, and the block has not moved for it.
    expect(lines.join("\n")).not.toContain(ATOM_GLYPH);
    const bars = lines.find((line) => line.includes("llama.cpp runtime")) ?? "";
    const leading = bars.length - bars.trimStart().length;
    expect(leading).toBeGreaterThan(0);
    expect(lines.length).toBe(30);
    expect(lines.at(-1)).toContain("ctrl+c");
  });
});
