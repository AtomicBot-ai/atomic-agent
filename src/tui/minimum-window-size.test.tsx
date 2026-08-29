import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

/**
 * Both screens, against the floor.
 *
 * `useTerminalSize` is mocked rather than driven through a fake stdout
 * because ink-testing-library pins its own stream at 100 columns and
 * reports no rows — the hook is the seam the whole layout reads, so
 * moving it is what actually changes the size the app believes it has.
 */
let SIZE = { columns: 80, rows: 24 };
vi.mock("./hooks/use-terminal-size.js", () => ({
  useTerminalSize: () => SIZE,
}));

import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import { createOnboardingState } from "./onboarding/onboarding-state.js";
import type { TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/tiny",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 1,
  maxSteps: 10,
  skillCount: 0,
};

const CALLBACKS: TuiAppCallbacks = {
  onAbort: () => {},
  onQuit: () => {},
  onApprovalDecision: () => {},
  onMessageSubmitted: () => {},
};

function strip(frame: string): string {
  return frame.replace(/\[[0-9;]*m/g, "");
}

function frameAt(
  size: { columns: number; rows: number },
  onboarding = false,
): string {
  SIZE = size;
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={CALLBACKS}
      {...(onboarding
        ? { initialLayout: { onboarding: createOnboardingState() } }
        : {})}
    />,
  );
  const out = strip(app.lastFrame() ?? "");
  app.unmount();
  return out;
}

describe("the main screen below the floor", () => {
  it("draws the card instead of a frame it cannot fit", () => {
    const body = frameAt({ columns: 30, rows: 10 });
    expect(body).toContain("terminal too small");
    expect(body).toContain("needs 40x16");
    expect(body).toContain("this one is 30x10");
  });

  it("stays within the window it was given", () => {
    // The point of the whole change: Ink 7 overlaps rather than clips,
    // so a frame taller than the terminal is two UIs on top of each
    // other. Measured before this, the main screen came out at 16 rows
    // whatever it was given — 14, 12, 8 or 5.
    for (const rows of [15, 12, 8, 5, 2]) {
      const rendered = frameAt({ columns: 30, rows }).split("\n");
      expect(rendered.length, `${rows}-row window`).toBeLessThanOrEqual(rows);
    }
  });

  it("draws the real app at the floor exactly", () => {
    const body = frameAt({ columns: 40, rows: 16 });
    expect(body).not.toContain("terminal too small");
  });

  it("draws the real app at ordinary sizes", () => {
    expect(frameAt({ columns: 80, rows: 24 })).not.toContain(
      "terminal too small",
    );
  });
});

describe("the first-run screen below the floor", () => {
  it("takes the card too, rather than a garbled wizard", () => {
    // Ordered above the onboarding branch on purpose: this is the first
    // thing a new operator ever sees, and the one screen that has no
    // way of knowing the window is what is wrong.
    const body = frameAt({ columns: 30, rows: 10 }, true);
    expect(body).toContain("terminal too small");
  });

  it("still runs the flow at the floor", () => {
    const body = frameAt({ columns: 40, rows: 16 }, true);
    expect(body).not.toContain("terminal too small");
  });
});
