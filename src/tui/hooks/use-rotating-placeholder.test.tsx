import { Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRotatingPlaceholder } from "./use-rotating-placeholder.js";

interface ProbeProps {
  phrases: readonly string[];
  intervalMs?: number;
}

function Probe({ phrases, intervalMs }: ProbeProps): ReactElement {
  const value = useRotatingPlaceholder(phrases, intervalMs);
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
});
