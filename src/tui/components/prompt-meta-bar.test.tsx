import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { appendFileReference } from "./prompt-meta-bar.js";
import { PromptShell } from "./prompt-shell.js";

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

/**
 * Screen position of `needle`'s first cell. Stripping SGR codes leaves
 * the visual grid intact, so the column/row returned here are the same
 * cells a terminal would report for a click on that label.
 */
function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = strip(frame).split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${strip(frame)}`);
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

const noopCallbacks = {} as TuiAppCallbacks;

/**
 * `PromptShell` inside a real registry. The buttons only need dispatch
 * to exist — they act through their own props — but the registry is the
 * real one so the click goes through genuine Yoga hit-testing rather
 * than a hand-fed rectangle.
 */
async function mountWithMouse(node: ReactElement): Promise<{
  registry: MouseTargetRegistry;
  frame: () => string;
  unmount: () => void;
}> {
  const registry = new MouseTargetRegistry();
  const { lastFrame, unmount } = render(
    <MouseProvider
      registry={registry}
      dispatch={() => {}}
      callbacks={noopCallbacks}
      getState={() => ({}) as TuiState}
    >
      {node}
    </MouseProvider>,
  );
  // Ink commits on its own throttle and React registers the click
  // targets in the effect after that commit, so a freshly mounted
  // button is not hit-testable on the very first tick.
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { registry, frame: () => lastFrame() ?? "", unmount };
}

describe("appendFileReference", () => {
  it("seeds an empty draft", () => {
    expect(appendFileReference("")).toBe("file: ");
  });

  it("separates the marker from existing prose", () => {
    expect(appendFileReference("summarise")).toBe("summarise file: ");
  });

  it("does not double the space when the draft already ends in one", () => {
    expect(appendFileReference("summarise ")).toBe("summarise file: ");
    expect(appendFileReference("summarise\n")).toBe("summarise\nfile: ");
  });
});

describe("composer buttons", () => {
  it("submits the live buffer when Send is clicked", async () => {
    const sent: string[] = [];
    const { registry, frame, unmount } = await mountWithMouse(
      <PromptShell
        value="ship it"
        focus
        onChange={() => {}}
        onSubmit={(value) => sent.push(value)}
      />,
    );
    const { x, y } = locate(frame(), "send");
    expect(registry.dispatch(click(x, y))).toBe(true);
    expect(sent).toEqual(["ship it"]);
    unmount();
  });

  it("stays inert while the buffer is blank", async () => {
    const sent: string[] = [];
    const { registry, frame, unmount } = await mountWithMouse(
      <PromptShell
        value="   "
        focus
        onChange={() => {}}
        onSubmit={(value) => sent.push(value)}
      />,
    );
    const { x, y } = locate(frame(), "send");
    expect(registry.dispatch(click(x, y))).toBe(false);
    expect(sent).toEqual([]);
    unmount();
  });

  it("stays inert while the editor is disabled", async () => {
    const sent: string[] = [];
    const { registry, frame, unmount } = await mountWithMouse(
      <PromptShell
        value="ship it"
        focus
        disabled
        onChange={() => {}}
        onSubmit={(value) => sent.push(value)}
      />,
    );
    const { x, y } = locate(frame(), "send");
    expect(registry.dispatch(click(x, y))).toBe(false);
    expect(sent).toEqual([]);
    unmount();
  });

  it("appends the file marker when the file button is clicked", async () => {
    const changed: string[] = [];
    const { registry, frame, unmount } = await mountWithMouse(
      <PromptShell
        value="explain"
        focus
        onChange={(value) => changed.push(value)}
        onSubmit={() => {}}
      />,
    );
    const { x, y } = locate(frame(), "+ file");
    expect(registry.dispatch(click(x, y))).toBe(true);
    expect(changed).toEqual(["explain file: "]);
    unmount();
  });

  it("ignores a right-button press on Send", async () => {
    const sent: string[] = [];
    const { registry, frame, unmount } = await mountWithMouse(
      <PromptShell
        value="ship it"
        focus
        onChange={() => {}}
        onSubmit={(value) => sent.push(value)}
      />,
    );
    const { x, y } = locate(frame(), "send");
    expect(
      registry.dispatch({ ...click(x, y), button: "right" }),
    ).toBe(false);
    expect(sent).toEqual([]);
    unmount();
  });

  it("renders without a mouse provider at all", () => {
    const { lastFrame, unmount } = render(
      <PromptShell value="" focus onChange={() => {}} onSubmit={() => {}} />,
    );
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("+ file");
    expect(frame).toContain("send");
    unmount();
  });
});
