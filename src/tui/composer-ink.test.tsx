import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Ink resolves chalk's colour level once, at import time, from the
// terminal it thinks it has — and under a test runner that is none, so
// every frame comes back stripped and every assertion below would be
// vacuously true. `vi.hoisted` runs before the imports, which is the
// only place the flag can still be read. Same trick as
// `composer-meta-controls.test.tsx`.
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { PromptShell } from "./components/prompt-shell.js";
import { contrastRatio } from "./theme/color-contrast.js";
import {
  setActiveTheme,
  THEMES,
  THEME_NAMES,
  type ThemeName,
} from "./theme/theme.js";

/** SGR truecolour foreground for `#rrggbb`. */
function ink(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `[38;2;${r};${g};${b}m`;
}

function frameWith(value: string): string {
  const { lastFrame, unmount } = render(
    <Box width={80}>
      <PromptShell
        value={value}
        onChange={() => {}}
        onSubmit={() => {}}
        focus
        backend={null}
        model={null}
        provider={null}
        leftSlot={null}
        rightSlot={null}
        contextSlot={null}
        modeSlot={null}
      />
    </Box>,
  );
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

/**
 * The composer sits on a panel the *app* paints (`badgeBackground`), and
 * the buffer used to be drawn with no foreground at all — inheriting the
 * terminal's default ink. That only works while the panel and the
 * terminal agree about which way round light and dark are, and they need
 * not: `classic-light` paints a near-white panel, so anyone running a
 * light palette in a dark terminal typed light text onto it and could
 * not read what they were writing.
 */
describe("what colour the composer types in", () => {
  it("gives the buffer an explicit colour on every palette", () => {
    for (const name of THEME_NAMES) {
      setActiveTheme(THEMES[name]);
      const frame = frameWith("hello world");
      const colors = THEMES[name].colors;
      // `readableOn` picks whichever end of the chip pair reads better
      // on the panel; whichever it picked has to actually be emitted.
      const chosen =
        contrastRatio(colors.badgeBackground, colors.chipBackground) >=
        contrastRatio(colors.badgeBackground, colors.chipForeground)
          ? colors.chipBackground
          : colors.chipForeground;
      expect(frame, `${name}: buffer text is uncoloured`).toContain(
        `${ink(chosen)}hello world`,
      );
    }
  });

  it("keeps that colour readable against the panel it sits on", () => {
    for (const name of THEME_NAMES) {
      const colors = THEMES[name].colors;
      const chosen =
        contrastRatio(colors.badgeBackground, colors.chipBackground) >=
        contrastRatio(colors.badgeBackground, colors.chipForeground)
          ? colors.chipBackground
          : colors.chipForeground;
      const ratio = contrastRatio(chosen, colors.badgeBackground);
      expect(ratio, `${name}: ${ratio.toFixed(2)}:1 on the composer panel`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("picks dark ink on the light palette and light ink on the dark one", () => {
    // The regression stated as the two cases that actually shipped.
    const light = THEMES["classic-light" as ThemeName].colors;
    const dark = THEMES["classic-dark" as ThemeName].colors;
    setActiveTheme(THEMES["classic-light" as ThemeName]);
    expect(frameWith("abc")).toContain(`${ink(light.chipBackground)}abc`);
    setActiveTheme(THEMES["classic-dark" as ThemeName]);
    expect(frameWith("abc")).toContain(`${ink(dark.chipBackground)}abc`);
  });
});
