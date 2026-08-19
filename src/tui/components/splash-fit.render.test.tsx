import { render } from "ink-testing-library";
import { Box } from "ink";
import { describe, expect, it } from "vitest";
import { computeChatViewportRows, computeChatWidth } from "../layout.js";
import { SplashBanner } from "./splash-banner.js";

function lines(frame: string): string[] {
  return frame
    .replace(/\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
}

/**
 * Regression guard for the "small window garbles the start page" bug,
 * modelled on `manage-panel-fit.test.tsx`. Ink 7 does NOT clip a frame
 * taller than the terminal — it overlaps earlier lines — and it wraps a
 * line wider than the surface into confetti. The splash therefore has
 * to plan its own size, and the plan has to survive contact with Yoga.
 *
 * ink-testing-library pins its stdout at 100 columns and reports no
 * rows at all, so each case renders `SplashBanner` at an explicit
 * surface size inside a `Box` of that width — the same geometry the
 * chat column hands it in production.
 */
const TERMINALS: ReadonlyArray<{ columns: number; rows: number }> = [
  { columns: 40, rows: 12 },
  { columns: 60, rows: 20 },
  { columns: 80, rows: 24 },
  { columns: 100, rows: 30 },
  { columns: 100, rows: 50 },
];

describe("SplashBanner fit", () => {
  it.each(TERMINALS)("fits a $columns x $rows terminal", (terminal) => {
    const size = {
      columns: computeChatWidth(terminal.columns),
      rows: computeChatViewportRows(terminal.rows),
    };
    const { lastFrame } = render(
      <Box width={size.columns}>
        <SplashBanner size={size} />
      </Box>,
    );
    const rendered = lines(lastFrame() ?? "");
    const widest = rendered.reduce((acc, line) => Math.max(acc, line.length), 0);
    expect(widest).toBeLessThanOrEqual(size.columns);
    expect(rendered.length).toBeLessThanOrEqual(size.rows);
    // A splash with no recognisable brand mark is not a splash — except
    // on a surface with no room for one, where drawing it anyway is the
    // bug this file guards against. The mark is half-block art below
    // full size, so match the glyphs rather than the source shading.
    if (size.rows >= 6) {
      expect(rendered.join("\n")).toMatch(/ATOMIC AGENT|:::|[█▀▄]/u);
    }
  });

  it("renders the full artwork, wordmark and every tip when there is room", () => {
    const size = { columns: 96, rows: 40 };
    const { lastFrame } = render(
      <Box width={size.columns}>
        <SplashBanner size={size} />
      </Box>,
    );
    const frame = lines(lastFrame() ?? "").join("\n");
    expect(frame).toContain("::::::::::::::::::::::::::::::::::");
    expect(frame).toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("Local AI-First Agent");
    expect(frame).toContain("/import");
  });

  it("collapses to the smallest mark and bare labels on a tiny surface", () => {
    const size = { columns: 24, rows: 10 };
    const { lastFrame } = render(
      <Box width={size.columns}>
        <SplashBanner size={size} />
      </Box>,
    );
    const frame = lines(lastFrame() ?? "").join("\n");
    // The mini mark is scaled from the full drawing, not a text stand-in.
    expect(frame).toMatch(/[█▀▄]/u);
    expect(frame).not.toContain("▄▀█ ▀█▀ █▀█");
    expect(frame).toContain("/help");
    expect(frame).not.toContain("list all slash commands");
  });
});
