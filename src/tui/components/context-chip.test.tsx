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
    tokens: 55_050,
    contextWindow: 131_072,
    percent: 42,
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
  it("draws the gauge and the percentage", () => {
    expect(label(usage())).toBe(" context [===     ]  42%");
  });

  it("keeps a fixed width from one digit to three", () => {
    const widths = new Set(
      [7, 42, 100].map((percent) => label(usage({ percent })).length),
    );
    expect(widths.size).toBe(1);
  });

  /**
   * A cloud model nobody has stated a window for still has a real token
   * count. Drawing a gauge would mean inventing the scale it is drawn
   * against.
   */
  it("shows the raw count, and no gauge, when the window is unknown", () => {
    expect(
      label(usage({ percent: null, contextWindow: null, tokens: 34_812 })),
    ).toBe(" context 34.8k");
    expect(
      label(usage({ percent: null, contextWindow: null, tokens: 812 })),
    ).toBe(" context 812");
  });
});

describe("the chip's ground", () => {
  it("steps through three shades of the palette's accent", () => {
    setActiveTheme(THEMES["github-dark"]);
    const ground = theme.colors.railBackground;
    const accent = theme.colors.accent;
    expect(groundFor(usage({ percent: 32 }))).toBe(mixColor(accent, ground, 0.6));
    expect(groundFor(usage({ percent: 33 }))).toBe(mixColor(accent, ground, 0.3));
    expect(groundFor(usage({ percent: 65 }))).toBe(mixColor(accent, ground, 0.3));
    expect(groundFor(usage({ percent: 66 }))).toBe(accent);
    expect(groundFor(usage({ percent: 100 }))).toBe(accent);
  });

  /**
   * Trimming is the packer working as designed, not a fault, so the
   * state gets its own hue rather than a warn colour — and it outranks
   * the fill, because "some of this conversation is gone" is the more
   * important of the two facts.
   */
  it("turns violet once the transcript has been trimmed, at any fill", () => {
    setActiveTheme(THEMES["github-dark"]);
    expect(groundFor(usage({ percent: 12, droppedTurns: 3 }))).toBe(
      theme.colors.accentAlt,
    );
    expect(groundFor(usage({ percent: 100, droppedTurns: 3 }))).toBe(
      theme.colors.accentAlt,
    );
  });

  it("sits at the quiet end when the fill is unknown", () => {
    setActiveTheme(THEMES["github-dark"]);
    expect(groundFor(usage({ percent: null, contextWindow: null }))).toBe(
      mixColor(theme.colors.accent, theme.colors.railBackground, 0.6),
    );
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
