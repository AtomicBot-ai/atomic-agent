import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import type { ContextUsageView } from "../select-context-usage.js";
import { mixColor } from "../theme/mix-color.js";
import { getActiveTheme, setActiveTheme, THEMES, theme } from "../theme/theme.js";
import { ContextChip, groundFor } from "./context-chip.js";

const original = getActiveTheme();
afterAll(() => setActiveTheme(original));

const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

function usage(overrides: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    tokens: 14_100,
    contextWindow: 1_000_000,
    percent: 1,
    conversationTokens: 6400,
    conversationCap: 32_000,
    conversationPercent: 20,
    capSource: "config",
    droppedTurns: 0,
    sections: [],
    ...overrides,
  };
}

/**
 * The chip's own text, minus colour. Ink drops the trailing pad cell
 * when the chip is the whole frame; inside the composer the bar's own
 * ground paints it, so the expectations here stop at the last glyph.
 */
function label(view: ContextUsageView): string {
  const { lastFrame, unmount } = render(<ContextChip usage={view} />);
  const text = (lastFrame() ?? "").replace(SGR, "");
  unmount();
  return text;
}

describe("ContextChip", () => {
  /**
   * The bar and the numbers are the same quantity: how full the model's
   * real context window is.
   *
   * It used to gauge the transcript against the packer's own ceiling,
   * which is a real number and the wrong one to lead with. That ceiling
   * is internal, it moves for reasons the operator did not cause, and it
   * answers neither of the questions actually being asked at the
   * composer — is there room for what I am about to send, and has
   * anything already been forgotten?
   */
  it("gauges the prompt against the model's window, and prints both", () => {
    expect(label(usage())).toBe(" context [        ]      14.1k/1M");
  });

  it("fills as the window fills", () => {
    expect(label(usage({ percent: 0 }))).toContain("[        ]");
    expect(label(usage({ percent: 50 }))).toContain("[====    ]");
    expect(label(usage({ percent: 100 }))).toContain("[========]");
  });

  /**
   * The whole point of the change. Dropped turns are the moment the
   * agent stops knowing things it knew a minute ago and the answers
   * quietly start getting worse — so the chip says it in words. A
   * colour alone was never going to carry that.
   */
  it("says out loud when history has been dropped", () => {
    expect(label(usage({ droppedTurns: 3 }))).toContain("3 lost");
    expect(label(usage())).not.toContain("lost");
  });

  it("counts the loss even with nothing else to gauge", () => {
    const bare = usage({
      contextWindow: null,
      percent: null,
      conversationCap: null,
      conversationPercent: null,
      droppedTurns: 2,
    });
    expect(label(bare)).toContain("2 lost");
  });

  /**
   * The bar sits left of the numbers and the chip is right-anchored, so
   * a tail that grew a cell at 10k would shove the gauge sideways
   * mid-session.
   */
  it("holds a steady width as the numbers grow", () => {
    const widths = new Set(
      [90, 6400, 31_900].map((tokens) => label(usage({ tokens })).length),
    );
    expect(widths.size).toBe(1);
  });

  /**
   * With no window published there is no honest scale for it, so the
   * transcript's own cap is the only one left — and it is labelled, so
   * the number cannot be mistaken for a window.
   */
  it("falls back to the transcript cap when the window is unknown", () => {
    expect(label(usage({ percent: null, contextWindow: null }))).toBe(
      " context [==      ]      6.4k/32k cap",
    );
  });

  it("shows the raw count when there is no scale at all", () => {
    expect(
      label(
        usage({
          contextWindow: null,
          percent: null,
          conversationCap: null,
          conversationPercent: null,
          tokens: 34_812,
        }),
      ),
    ).toBe(" context 34.8k");
  });
});

describe("the chip's ground", () => {
  it("steps through three shades of the palette's accent", () => {
    setActiveTheme(THEMES["classic-dark"]);
    const ground = theme.colors.railBackground;
    const accent = theme.colors.accent;
    // The ramp follows the bar, and the bar follows the window now.
    const at = (percent: number): string => groundFor(usage({ percent }));
    expect(at(32)).toBe(mixColor(accent, ground, 0.6));
    expect(at(33)).toBe(mixColor(accent, ground, 0.3));
    expect(at(65)).toBe(mixColor(accent, ground, 0.3));
    expect(at(66)).toBe(accent);
    expect(at(100)).toBe(accent);
  });

  /**
   * Trimming is the packer working as designed, not a fault, so the
   * state gets its own hue rather than a warn colour — and it outranks
   * the fill, because "some of this conversation is gone" is the more
   * important of the two facts.
   */
  it("turns violet once the transcript has been trimmed, at any fill", () => {
    setActiveTheme(THEMES["classic-dark"]);
    expect(groundFor(usage({ conversationPercent: 12, droppedTurns: 3 }))).toBe(
      theme.colors.accentAlt,
    );
    expect(groundFor(usage({ conversationPercent: 100, droppedTurns: 3 }))).toBe(
      theme.colors.accentAlt,
    );
  });

  it("sits at the quiet end when the fill is unknown", () => {
    setActiveTheme(THEMES["classic-dark"]);
    expect(
      groundFor(usage({ conversationPercent: null, conversationCap: null })),
    ).toBe(mixColor(theme.colors.accent, theme.colors.railBackground, 0.6));
  });
});

function press(x: number, y: number, button: "left" | "right" = "left"): TuiMouseEvent {
  return {
    kind: "press",
    button,
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe("clicking the chip", () => {
  /**
   * Mounted in a real registry so the click goes through genuine Yoga
   * hit-testing rather than a hand-fed rectangle — the same shape as
   * `prompt-meta-bar.test.tsx`.
   */
  async function mount(): Promise<{
    registry: MouseTargetRegistry;
    actions: TuiAction[];
    frame: () => string;
    unmount: () => void;
  }> {
    const registry = new MouseTargetRegistry();
    const actions: TuiAction[] = [];
    const { lastFrame, unmount } = render(
      <MouseProvider
        registry={registry}
        dispatch={(action) => actions.push(action)}
        callbacks={{} as TuiAppCallbacks}
        getState={() => ({}) as TuiState}
      >
        <ContextChip usage={usage()} />
      </MouseProvider>,
    );
    // Ink commits on its own throttle and React registers the target in
    // the effect after that commit, so a freshly mounted chip is not
    // hit-testable on the very first tick.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { registry, actions, frame: () => (lastFrame() ?? "").replace(SGR, ""), unmount };
  }

  it("opens the detail panel", async () => {
    const { registry, actions, frame, unmount } = await mount();
    const x = frame().indexOf("context");
    expect(registry.dispatch(press(x, 0))).toBe(true);
    expect(actions).toEqual([{ type: "context_panel_toggled" }]);
    unmount();
  });

  it("ignores a right-button press", async () => {
    const { registry, actions, frame, unmount } = await mount();
    const x = frame().indexOf("context");
    expect(registry.dispatch(press(x, 0, "right"))).toBe(false);
    expect(actions).toEqual([]);
    unmount();
  });
});
