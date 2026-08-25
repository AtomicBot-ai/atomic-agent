import { Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRotatingPlaceholder } from "./use-rotating-placeholder.js";

interface ProbeProps {
  phrases: readonly string[];
  intervalMs?: number;
  active?: boolean;
}

function Probe({ phrases, intervalMs, active }: ProbeProps): ReactElement {
  const value = useRotatingPlaceholder(phrases, intervalMs, active);
  return <Text>{value ?? "<undef>"}</Text>;
}

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("useRotatingPlaceholder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders <undef> for an empty list", () => {
    const { lastFrame, unmount } = render(<Probe phrases={[]} />);
    expect(strip(lastFrame() ?? "")).toContain("<undef>");
    unmount();
  });

  it("returns the only entry without scheduling a timer", () => {
    const spy = vi.spyOn(global, "setInterval");
    const { lastFrame, unmount } = render(<Probe phrases={["only"]} />);
    expect(strip(lastFrame() ?? "")).toContain("only");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    unmount();
  });

  it("cycles through entries on the given interval", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { lastFrame, rerender, unmount } = render(
      <Probe phrases={["a", "b", "c"]} intervalMs={1000} />,
    );
    expect(strip(lastFrame() ?? "")).toContain("a");
    vi.advanceTimersByTime(1000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} />);
    expect(strip(lastFrame() ?? "")).toContain("b");
    vi.advanceTimersByTime(1000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} />);
    expect(strip(lastFrame() ?? "")).toContain("c");
    vi.advanceTimersByTime(1000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} />);
    expect(strip(lastFrame() ?? "")).toContain("a");
    unmount();
  });

  /**
   * The repaint that was not going anywhere.
   *
   * The phrase is drawn only while the composer is empty, but the timer
   * ran regardless — so from the first character typed, the app took a
   * full Ink frame every four seconds to advance a string nobody could
   * see. On a terminal that renders as bytes arrive, a full frame is a
   * visible flicker.
   */
  it("schedules nothing while inactive", () => {
    const spy = vi.spyOn(global, "setInterval");
    const { unmount } = render(
      <Probe phrases={["a", "b", "c"]} intervalMs={1000} active={false} />,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    unmount();
  });

  it("stops the timer when it goes inactive, and restarts when it returns", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { lastFrame, rerender, unmount } = render(
      <Probe phrases={["a", "b", "c"]} intervalMs={1000} active />,
    );
    vi.advanceTimersByTime(1000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} active />);
    expect(strip(lastFrame() ?? "")).toContain("b");

    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} active={false} />);
    vi.advanceTimersByTime(5000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} active={false} />);
    // Five intervals passed and the phrase did not move, which means no
    // render was scheduled for it either.
    expect(strip(lastFrame() ?? "")).toContain("b");

    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} active />);
    vi.advanceTimersByTime(1000);
    rerender(<Probe phrases={["a", "b", "c"]} intervalMs={1000} active />);
    expect(strip(lastFrame() ?? "")).toContain("c");
    unmount();
  });

  it("defaults to active, so existing callers are unchanged", () => {
    const spy = vi.spyOn(global, "setInterval");
    const { unmount } = render(<Probe phrases={["a", "b"]} intervalMs={1000} />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    unmount();
  });
});
