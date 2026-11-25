import chalk from "chalk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrandBadge } from "./brand-badge.js";
import { BRAND_SLOT_WIDTH, BRANDS, modelBrand } from "./brand-badges.js";

function frameOf(node: Parameters<typeof render>[0]): string {
  const view = render(node);
  const frame = view.lastFrame() ?? "";
  view.unmount();
  return frame;
}

describe("BrandBadge, plain (chalk level 0, as under NO_COLOR)", () => {
  it("draws the letters and the gap in exactly the slot width", () => {
    const frame = frameOf(
      <Text>
        <BrandBadge brand={BRANDS.openrouter} />
        OpenRouter
      </Text>,
    );
    expect(frame).toBe(" OR  OpenRouter");
    expect(frame.indexOf("OpenRouter")).toBe(BRAND_SLOT_WIDTH);
  });

  it("keeps the label column for a one-letter brand", () => {
    const frame = frameOf(
      <Text>
        <BrandBadge brand={BRANDS.anthropic} />
        Anthropic
      </Text>,
    );
    expect(frame.indexOf("Anthropic")).toBe(BRAND_SLOT_WIDTH);
  });

  it("draws an unknown brand as a blank of the same width, no monogram", () => {
    const frame = frameOf(
      <Text>
        <BrandBadge brand={modelBrand("my-own-model")} />
        my-own-model
      </Text>,
    );
    expect(frame).toBe(`${" ".repeat(BRAND_SLOT_WIDTH)}my-own-model`);
  });
});

describe("BrandBadge, coloured", () => {
  let previousLevel: typeof chalk.level;

  beforeEach(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousLevel;
  });

  it("paints the brand colour behind the letters", () => {
    const frame = frameOf(<BrandBadge brand={BRANDS.telegram} />);
    // #26A5E4 as a truecolor background.
    expect(frame).toContain("\u001b[48;2;38;165;228m");
    expect(frame).toContain("TG");
  });

  it("paints nothing for an unknown brand", () => {
    const frame = frameOf(<BrandBadge brand={null} />);
    expect(frame).not.toContain("\u001b[48;");
  });
});
