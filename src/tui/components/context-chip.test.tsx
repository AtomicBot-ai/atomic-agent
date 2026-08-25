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
   * The bar and the numbers are the same quantity: how full the
   * transcript is against the ceiling it gets packed to. Gauging the
   * prompt against the model's window instead would sit at 1% all
   * session on this model and never say anything.
   */
  it("gauges the transcript against its cap, and prints both", () => {
    expect(label(usage())).toBe(" context [==      ]   6.4k/32k cap");
  });

  it("says `cap` only where the number could be mistaken for the window", () => {
    // The word exists to stop `6.4k/32k` reading as a 32k context
    // window, which is what it read as for anyone who had set their own
    // `-c`. Where the window itself is what binds — or where the
    // operator switched the ceiling off — the number *is* the window's
    // remainder and the disclaimer would be noise.
    expect(label(usage({ capSource: "window" }))).not.toContain("cap");
    expect(label(usage({ capSource: "auto" }))).not.toContain("cap");
    expect(label(usage({ capSource: "floor" }))).not.toContain("cap");
  });

  /**
   * The bar sits left of the numbers and the chip is right-anchored, so
   * a tail that grew a cell at 10k would shove the gauge sideways
   * mid-session.
   */
  it("holds a steady width as the numbers grow", () => {
    const widths = new Set(
      [90, 6400, 31_900].map(
        (conversationTokens) => label(usage({ conversationTokens })).length,
      ),
    );
    expect(widths.size).toBe(1);
  });

  it("fills as the transcript approaches the cap", () => {
    expect(label(usage({ conversationPercent: 0 }))).toContain("[        ]");
    expect(label(usage({ conversationPercent: 50 }))).toContain("[====    ]");
    expect(label(usage({ conversationPercent: 100 }))).toContain("[========]");
  });

  /**
   * An unknown *window* no longer costs the bar anything — the cap is
   * on every built prompt either way. Only a session with no cap at all
   * falls back to the bare total.
   */
  it("still gauges when the model's window is unknown", () => {
    expect(label(usage({ percent: null, contextWindow: null }))).toBe(
      " context [==      ]   6.4k/32k cap",
    );
  });

  it("shows the raw count, and no gauge, when no cap is known", () => {
    expect(
      label(
        usage({ conversationCap: null, conversationPercent: null, tokens: 34_812 }),
      ),
    ).toBe(" context 34.8k");
    expect(
      label(
        usage({ conversationCap: null, conversationPercent: null, tokens: 812 }),
      ),
    ).toBe(" context 812");
  });
});

describe("the chip's ground", () => {
  it("steps through three shades of the palette's accent", () => {
    setActiveTheme(THEMES["classic-dark"]);
    const ground = theme.colors.railBackground;
    const accent = theme.colors.accent;
    const at = (conversationPercent: number): string =>
      groundFor(usage({ conversationPercent }));
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
