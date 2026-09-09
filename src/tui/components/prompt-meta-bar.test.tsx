import { EventEmitter } from "node:events";
import { Box, render as inkRender } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { ComposerBackendMeta } from "../composer-switch/composer-switch-rows.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { PromptMetaBar } from "./prompt-meta-bar.js";
import { PromptShell } from "./prompt-shell.js";
import { ProviderOutageReadout } from "./provider-outage-readout.js";

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
    expect(frame).toContain("send");
    unmount();
  });
});

describe("the model label", () => {
  const renderModel = (model: string): string => {
    const { lastFrame, unmount } = render(
      <PromptShell
        value=""
        focus
        model={model}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = strip(lastFrame() ?? "");
    unmount();
    return frame;
  };

  /**
   * Fusion names both legs. Spending the whole budget left-to-right ate
   * the local half outright — "vendor/some-very-long-name ⇄ q…" — which
   * hides the model that actually executes most of the steps.
   */
  it("keeps both fusion legs identifiable", () => {
    const frame = renderModel(
      "vendor/some-very-long-cloud-model ⇄ qwen3-4b-instruct-q4.gguf",
    );
    expect(frame).toContain("vendor/some-v…");
    expect(frame).toContain("qwen3-4b-inst…");
  });

  it("still trims a single long name the way it always did", () => {
    expect(renderModel("vendor/an-extremely-long-single-model-name")).toContain(
      "vendor/an-extremely-long-single…",
    );
  });
});

/**
 * ink-testing-library pins its stdout at 100 columns, and the row's
 * whole job here is to degrade well at widths on either side of that.
 * Its Stdout is a dozen lines; this is the same thing with the width as
 * a parameter.
 */
class SizedStdout extends EventEmitter {
  _lastFrame: string | undefined;
  constructor(readonly columns: number) {
    super();
  }
  write = (frame: string): void => {
    this._lastFrame = frame;
  };
}

const ROUTE = {
  backend: { kind: "custom", status: "healthy" } as ComposerBackendMeta,
  provider: "llama.cpp",
  model: "qwen3-30b-a3b-instruct",
};

function renderMetaBarAt(columns: number, leftSlot: ReactElement | null): string[] {
  const stdout = new SizedStdout(columns);
  const instance = inkRender(
    <PromptMetaBar
      leftSlot={leftSlot}
      backend={ROUTE.backend}
      provider={ROUTE.provider}
      model={ROUTE.model}
      rightSlot={null}
      contextSlot={null}
      modeSlot={null}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      // Ink batches its writes behind log-update otherwise, and the
      // frame is still empty when a synchronous test reads it.
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  const frame = strip(stdout._lastFrame ?? "");
  instance.unmount();
  return frame.split("\n").map((line) => line.replace(/\s+$/, ""));
}

const OUTAGE_LINE = "waiting for provider 42s/300s — connection dropped mid-reply";

/**
 * The readout used to sit in a `flexShrink={0}` slot, so it took the
 * left end of the bar outright: at 160 columns the route was gone, and
 * at 110 the readout itself was cut away and the row carried nothing at
 * all. Both halves are checked at every width — the provider is exactly
 * what an operator looks left for when the link is down.
 */
describe("the meta bar while the provider is down", () => {
  const readout = (
    <ProviderOutageReadout text={OUTAGE_LINE} givenUp={false} />
  );

  it.each([80, 100, 110, 160])("keeps the route at %i columns", (columns) => {
    const frame = renderMetaBarAt(columns, readout).join("\n");
    // Backend word, provider and model all still on the row. Below ~110
    // the last two lose a character each to Yoga's rounding — the row
    // simply needs more columns than the terminal has — but the route
    // reads as a route, which is the whole point.
    expect(frame).toContain("custom");
    expect(frame).toContain("llama.c");
    expect(frame).toContain("qwen3-30b");
    // Something of the readout survives too — a truncated warning is
    // still a warning, and it is the click target for the LLM pane.
    expect(frame).toContain("waiting for provider");
  });

  it.each([110, 160])("carries both statements whole at %i columns", (columns) => {
    const frame = renderMetaBarAt(columns, readout).join("\n");
    expect(frame).toContain(OUTAGE_LINE);
    expect(frame).toContain("custom · llama.cpp · qwen3-30b-a3b-instruct");
  });

  it.each([80, 100, 110, 160])("stays one row tall at %i columns", (columns) => {
    // Ink wraps rather than clips, and a second line here would push the
    // composer's bottom border down.
    const lines = renderMetaBarAt(columns, readout);
    // `paddingY={1}` — one blank, the row, one blank.
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
  });

  it("spends the columns it loses on itself, not on the route", () => {
    // 80 is 30 columns short of what the full row wants. The readout
    // gives up 29 of them; the route gives up two characters.
    const tail = (lines: string[]): string =>
      lines.join("\n").split("waiting for provider")[1] ?? "";
    const lost =
      tail(renderMetaBarAt(160, readout)).length -
      tail(renderMetaBarAt(80, readout)).length;
    expect(lost).toBeGreaterThanOrEqual(25);
  });

  it("opens the LLM pane when the readout is clicked", async () => {
    // Where the route the outage is about is configured — the same deep
    // link the `download model` slot uses.
    const actions: TuiAction[] = [];
    const registry = new MouseTargetRegistry();
    const { lastFrame, unmount } = render(
      <MouseProvider
        registry={registry}
        dispatch={(action) => actions.push(action)}
        callbacks={noopCallbacks}
        getState={() => ({}) as TuiState}
      >
        <Box width={100}>
          <PromptMetaBar
            leftSlot={
              <ProviderOutageReadout text={OUTAGE_LINE} givenUp={false} />
            }
            backend={ROUTE.backend}
            provider={ROUTE.provider}
            model={ROUTE.model}
            rightSlot={null}
            contextSlot={null}
            modeSlot={null}
          />
        </Box>
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const { x, y } = locate(lastFrame() ?? "", "waiting for provider");
    expect(registry.dispatch(click(x, y))).toBe(true);
    expect(actions).toContainEqual({ type: "tab_changed", tab: "llm" });
    unmount();
  });
});
