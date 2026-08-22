import chalk from "chalk";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseHexColor } from "../theme/parse-hex-color.js";
import {
  getActiveTheme,
  setActiveTheme,
  THEMES,
  type TuiTheme,
} from "../theme/theme.js";
import { renderPickList } from "./wizard-pick-list.js";

/**
 * Constrain the list to a fixed inner width so the truncation guard is
 * deterministic regardless of the test host's real terminal size —
 * `wrap="truncate-end"` clips to the parent Box, so a 40-column Box is
 * a stand-in for a 40-column terminal.
 */
function narrow(node: ReturnType<typeof renderPickList>, columns: number) {
  return render(<Box width={columns}>{node}</Box>);
}

/**
 * Longest line any rendered frame row reaches, in physical columns.
 * A wrapped row would split one option across two lines and desync the
 * windowed height math, so the guard is: no visible line exceeds the
 * viewport width, and no option's text bleeds onto a second line.
 */
function widestLine(frame: string): number {
  return Math.max(0, ...frame.split("\n").map((line) => line.length));
}

describe("renderPickList narrow-width rendering", () => {
  const longLabel =
    "Together AI — broad open-weight catalog vendored without a key, long enough to overflow";

  it("truncates a long option instead of wrapping it onto a second line", () => {
    const { lastFrame } = narrow(
      renderPickList({
        title: "Provider",
        options: [{ label: longLabel }, { label: "Short one" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      40,
    );
    const frame = lastFrame() ?? "";
    // The whole frame stays within the viewport — no wrapped overflow.
    expect(widestLine(frame)).toBeLessThanOrEqual(40);
    // The long label is present but clipped: its head shows, its tail does not.
    expect(frame).toContain("Together AI");
    expect(frame).not.toContain("overflow");
    // The following option is never fused into the truncated row: it
    // still appears on its own line intact.
    expect(frame).toContain("Short one");
  });

  it("leaves a short option intact", () => {
    const { lastFrame } = narrow(
      renderPickList({
        title: "Provider",
        options: [{ label: "OpenRouter" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      80,
    );
    expect(lastFrame() ?? "").toContain("OpenRouter");
  });
});

/** The truecolor SGR Ink emits for a hex foreground, e.g. `ESC[38;2;r;g;bm`. */
function foregroundSgr(hex: string): string {
  const rgb = parseHexColor(hex);
  if (!rgb) throw new Error(`unparseable palette colour: ${hex}`);
  return `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

/**
 * The colours the cloud/provider screens are painted in, asserted on the
 * house palette because it is the only one of the twelve where `accent`
 * and `accentSoft` differ — everywhere else the two hexes are equal and
 * the distinction is invisible to a frame test.
 *
 * `ink-testing-library` renders at chalk level 0, which drops every SGR
 * sequence before `lastFrame()` sees it, so the level is raised for this
 * block and put back afterwards. The neighbouring width tests measure
 * `line.length` and would count escape bytes as columns.
 */
describe("renderPickList colours", () => {
  const house = THEMES["atomic-retro"].colors;
  let previousTheme: TuiTheme;
  let previousLevel: typeof chalk.level;

  beforeEach(() => {
    previousTheme = getActiveTheme();
    previousLevel = chalk.level;
    setActiveTheme(THEMES["atomic-retro"]);
    chalk.level = 3;
  });

  afterEach(() => {
    setActiveTheme(previousTheme);
    chalk.level = previousLevel;
  });

  function coloured() {
    return render(
      <Box width={60}>
        {renderPickList({
          title: "Chat model (OpenRouter)",
          options: [{ label: "first-model" }, { label: "second-model" }],
          cursor: 1,
          moveHint: "j/k move",
          actionsHint: "Enter select · Esc back",
        })}
      </Box>,
    );
  }

  function lineWith(frame: string, needle: string): string {
    const line = frame.split("\n").find((row) => row.includes(needle));
    if (line === undefined) throw new Error(`no frame line contains ${needle}`);
    return line;
  }

  it("paints the title in the text-safe accent, not the fill", () => {
    const frame = coloured().lastFrame() ?? "";
    const title = "Chat model (OpenRouter)";
    expect(frame).toContain(`${foregroundSgr(house.accent)}${title}`);
    expect(frame).not.toContain(`${foregroundSgr(house.accentSoft)}${title}`);
  });

  it("paints the selected row in the text-safe accent, and only that row", () => {
    const frame = coloured().lastFrame() ?? "";
    // Asserted on the sequence immediately before the label rather than
    // on the whole line: every row is bracketed by the box border, which
    // now carries the accent too and would satisfy a line-wide match.
    expect(frame).toContain(`${foregroundSgr(house.accent)}> second-model`);
    expect(frame).not.toContain(
      `${foregroundSgr(house.accentSoft)}> second-model`,
    );
    // The unselected row stays on the default foreground: the accent is
    // what marks the cursor, so a second accented row would erase it.
    expect(frame).toContain("  first-model");
    expect(frame).not.toContain(`${foregroundSgr(house.accent)}  first-model`);
  });

  it("draws the frame in the text-safe accent too", () => {
    // A border is box-drawing glyphs, not a ground, so it is measured
    // against the terminal like any other ink.
    const frame = coloured().lastFrame() ?? "";
    expect(lineWith(frame, "╭")).toContain(foregroundSgr(house.accent));
    expect(frame).not.toContain(foregroundSgr(house.accentSoft));
  });
});
