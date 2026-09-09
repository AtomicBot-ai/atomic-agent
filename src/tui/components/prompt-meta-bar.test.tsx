import { EventEmitter } from "node:events";
import { Box, Text, render as inkRender } from "ink";
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
import { META_SLOT_SHRINK, PromptMetaBar } from "./prompt-meta-bar.js";
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

/**
 * The bar's right-hand group, at the width `tui-app` really gives it:
 * the context readout and the mode chip, both `flexShrink={0}`, are
 * about fifty columns the left half never sees. Rendering the row
 * without them was measuring a bar with fifty columns of slack in it —
 * so nothing on the left ever had to shrink, and every assertion below
 * about *which* half gives way passed by having no pressure to resolve.
 * (Measured: with these two null, making the readout's head shrinkable
 * changed no frame at any width in this file.)
 */
const RIGHT_GROUP = (
  <>
    <Text>{"context [==      ] 1/20 tasks ·  6.2k/32.8k"}</Text>
    <Text>{" default "}</Text>
  </>
);

function renderMetaBarAt(
  columns: number,
  leftSlot: ReactElement | null,
): string[] {
  const stdout = new SizedStdout(columns);
  const instance = inkRender(
    <PromptMetaBar
      leftSlot={leftSlot}
      backend={ROUTE.backend}
      provider={ROUTE.provider}
      model={ROUTE.model}
      rightSlot={null}
      contextSlot={RIGHT_GROUP}
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

const OUTAGE_HEAD = "waiting for provider 42s/300s";
const OUTAGE_TAIL = " — connection dropped mid-reply";
const OUTAGE_LINE = `${OUTAGE_HEAD}${OUTAGE_TAIL}`;

/**
 * The readout used to sit in a `flexShrink={0}` slot, so it took the
 * left end of the bar outright and the whole route statement was pushed
 * off it — the provider gone from exactly the place someone looks when
 * the link is down. Both halves are checked at each width.
 *
 * `columns` here is the **composer's inner width**, not the terminal's:
 * the rail and the frame take about forty columns, so a 160-column
 * terminal renders this bar at 119. Every number below is a bar width,
 * and the ladder they describe is the one measured live under a PTY
 * against a provider that kills the socket mid-stream.
 */
describe("the meta bar while the provider is down", () => {
  const readout = (
    <ProviderOutageReadout
      head={OUTAGE_HEAD}
      tail={OUTAGE_TAIL}
      givenUp={false}
    />
  );

  it.each([119, 130, 160, 200])(
    "keeps the route legible at %i columns",
    (columns) => {
      // The backend word whole, and enough of the provider and the model
      // to name them.
      const frame = renderMetaBarAt(columns, readout).join("\n");
      expect(frame).toContain("● custom");
      expect(frame).toContain("llam");
      expect(frame).toContain("qwen3-30b");
    },
  );

  it.each([90, 110])(
    "still names the backend at %i columns, where the model cannot fit",
    (columns) => {
      // The readout's numbers win this trade — the head is whole at both
      // — but the row is not empty the way it was: the backend word is
      // still there, which is what says *which* link is down.
      const frame = renderMetaBarAt(columns, readout).join("\n");
      expect(frame).toContain("● c");
    },
  );

  it.each([140, 160, 200])("carries the route whole at %i columns", (columns) => {
    expect(renderMetaBarAt(columns, readout).join("\n")).toContain(
      "● custom · llama.cpp · qwen3-30b-a3b-instruct",
    );
  });

  it.each([90, 110, 119, 130, 160])(
    "keeps the readout's numbers at %i columns",
    (columns) => {
      // `waiting` alone says the link is down, which the colour already
      // said; the counter is what says the wait is still progressing
      // rather than hung. It is in the head, which does not shrink — and
      // this is the assertion that says so, so it has to run on a row
      // that is actually under pressure. It is: at 110 the model name is
      // already losing characters to keep this whole.
      const frame = renderMetaBarAt(columns, readout).join("\n");
      expect(frame).toContain(OUTAGE_HEAD);
    },
  );

  it("degrades to the head alone before it gives up the head", () => {
    // 75 columns is past what the row can carry: the head is clipped by
    // the bar's own `overflow="hidden"` rather than by any shrink, and
    // what survives is still the front of the state word. Recorded
    // rather than wished away — "never shrinks" is a shrink-order claim,
    // not a promise about a row narrower than one statement.
    const frame = renderMetaBarAt(75, readout).join("\n");
    expect(frame).toContain("waiting for provide");
    expect(frame).not.toContain("custom");
  });

  it("gives the reason the columns nothing else wants", () => {
    // The tail grows from nothing into the leftovers, so it appears
    // exactly when the row can afford it and never at the route's
    // expense: not at 119, where the route is still losing characters,
    // and whole once the route is whole with room to spare.
    expect(renderMetaBarAt(200, readout).join("\n")).toContain(OUTAGE_LINE);
    expect(renderMetaBarAt(119, readout).join("\n")).not.toContain(
      "connection dropped",
    );
  });

  it("carries both statements whole at 200 columns", () => {
    const frame = renderMetaBarAt(200, readout).join("\n");
    expect(frame).toContain(OUTAGE_LINE);
    expect(frame).toContain("custom · llama.cpp · qwen3-30b-a3b-instruct");
  });

  it("does not open a gap between the reason and the route", () => {
    // The tail is capped at its own text: growing past it would leave a
    // run of blanks in front of the separator.
    expect(renderMetaBarAt(200, readout).join("\n")).toContain(
      "mid-reply · ● custom",
    );
  });

  it.each([75, 90, 110, 119, 130, 160, 200])(
    "stays one row tall at %i columns",
    (columns) => {
      // Ink wraps rather than clips, and a second line here would push
      // the composer's bottom border down.
      const lines = renderMetaBarAt(columns, readout);
      // `paddingY={1}` — one blank, the row, one blank.
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
    },
  );

  it.each([75, 90, 110, 119, 130, 160, 200])(
    "stays one row tall through the other two phases at %i columns",
    (columns) => {
      // A retry carries no reason at all, and a given-up badge is a
      // different head with a different colour; neither may wrap either.
      for (const slot of [
        <ProviderOutageReadout
          head="retrying provider (attempt 2) — 8s"
          tail={null}
          givenUp={false}
        />,
        <ProviderOutageReadout
          head="provider unreachable"
          tail=" — no connection"
          givenUp
        />,
      ]) {
        const lines = renderMetaBarAt(columns, slot);
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
      }
    },
  );

  it("leaves a short composer notice next to the route", () => {
    // The other slot: it shrinks the ordinary way and must not be padded
    // out to some readout-sized floor.
    const notice = (
      <Text wrap="truncate">saved</Text>
    );
    expect(renderMetaBarAt(160, notice).join("\n")).toContain(
      "saved · ● custom",
    );
  });

  it("makes a long composer notice yield to the route", () => {
    // `META_SLOT_SHRINK`, the reason the slot is no longer `flexShrink={0}`:
    // a notice that kept its own width took the left end of the bar and
    // pushed the route off it, which is the same failure the outage
    // readout had. The notice gives up characters; the model name still
    // reads.
    const notice = (
      <Box flexShrink={META_SLOT_SHRINK} minWidth={0}>
        <Text wrap="truncate">
          saved settings to ~/.atomic-agent/config.json
        </Text>
      </Box>
    );
    const frame = renderMetaBarAt(110, notice).join("\n");
    expect(frame).toContain("qwen3-30b");
    expect(frame).not.toContain("config.json");
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
              <ProviderOutageReadout
                head={OUTAGE_HEAD}
                tail={OUTAGE_TAIL}
                givenUp={false}
              />
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
    const { x, y } = locate(lastFrame() ?? "", OUTAGE_HEAD);
    expect(registry.dispatch(click(x, y))).toBe(true);
    expect(actions).toContainEqual({ type: "tab_changed", tab: "llm" });
    unmount();
  });
});
