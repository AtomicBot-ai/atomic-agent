import { Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * A raised control: `+ new`, `≡ Menu`, `send →`.
 *
 * The design draws these as DOS-style buttons — a near-white face, dark
 * text, a light bevel on the top/left and a dark one on the bottom/right.
 * A terminal cell has no sub-cell bevel to draw, so the raised look falls
 * back to what raised meant before bevels existed: a light face under
 * dark text. `chipBackground` / `chipForeground` carry that pair per
 * palette, so a chip stays legible on all twelve — including this one,
 * where the rail it sits on is itself a colour.
 *
 * The padding spaces are part of the control: a chip with no ground
 * either side of its label reads as highlighted text rather than as a
 * button.
 */
export function Chip({
  label,
  tone = "raised",
}: {
  label: string;
  /**
   * `raised` is the button face. `badge` is the flatter, accent-tinted
   * variant used for status — the `RUN` pill — which the design tints
   * rather than raises.
   */
  tone?: "raised" | "badge";
}): ReactElement {
  if (tone === "badge") {
    return (
      <Text
        color={theme.colors.accent}
        backgroundColor={theme.colors.badgeBackground}
        bold
      >
        {` ${label} `}
      </Text>
    );
  }
  return (
    <Text
      color={theme.colors.chipForeground}
      backgroundColor={theme.colors.chipBackground}
      bold
    >
      {` ${label} `}
    </Text>
  );
}

/**
 * The design letter-spaces the `RUN` badge. A terminal grid cannot do
 * fractional tracking, so the one honest approximation is a full space
 * between letters — which doubles the word's width. That is affordable
 * for a three-letter status word and absurd for `OBSERVE`, so anything
 * longer than four characters is only upper-cased.
 */
const MAX_TRACKED_LENGTH = 4;

export function tracked(label: string): string {
  const upper = label.toUpperCase();
  if (upper.length > MAX_TRACKED_LENGTH) return upper;
  return upper.split("").join(" ");
}
