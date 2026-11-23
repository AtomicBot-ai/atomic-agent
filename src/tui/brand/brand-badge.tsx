import { Text } from "ink";
import type { ReactElement } from "react";
import { readableOn } from "../theme/readable-foreground.js";
import { brandBadgeText, type Brand } from "./brand-badges.js";

/**
 * The brand badge plus the one-cell gap after it, always
 * `BRAND_SLOT_WIDTH` cells (ATO-1635).
 *
 * A known brand is its letters on the brand colour, the `badge` tone of
 * `Chip` with the vendor's own ground instead of the accent. The ink is
 * measured against that ground (`readableOn`), so a pale brand (Hugging
 * Face yellow) gets dark letters and a deep one (OpenAI purple) light
 * letters. Ink lowers the hex to whatever the terminal can show and drops
 * it under NO_COLOR, where the letters still say who the row is.
 *
 * An unknown brand is the same width in plain spaces: a custom endpoint
 * or a user's own server lines up with its neighbours and wears nothing
 * it did not earn.
 *
 * Rendered as a nested `Text`, so it can sit inside a row's own `Text`
 * (and its `wrap="truncate-end"`) without splitting the row in two.
 */
export function BrandBadge({ brand }: { brand: Brand | null }): ReactElement {
  if (!brand) return <Text>{`${brandBadgeText(null)} `}</Text>;
  return (
    <Text>
      <Text backgroundColor={brand.hex} color={readableOn(brand.hex)} bold>
        {brandBadgeText(brand)}
      </Text>
      {" "}
    </Text>
  );
}
