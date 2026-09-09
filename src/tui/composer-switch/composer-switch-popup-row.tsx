import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { fitToWidth } from "../components/fit-to-width.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { fusionChipColors } from "../theme/fusion-tint.js";
import { chromeTheme } from "../theme/theme.js";
import type { ComposerSwitchRow } from "./composer-switch-rows.js";

/** Column reserved for the entry label when a detail column follows it. */
export const LABEL_WIDTH = 24;

export function SwitchRow({
  row,
  inner,
  selected,
  rowIndex,
  onActivate,
}: {
  row: ComposerSwitchRow;
  inner: number;
  selected: boolean;
  rowIndex: number;
  onActivate: (row: ComposerSwitchRow) => void;
}): ReactElement {
  const mouse = useMouseCommands();
  const marker = selected ? chromeTheme.glyphs.menuCursor : " ";
  const check = row.active ? `${chromeTheme.glyphs.check} ` : "";
  // The label column is reserved only when there is a detail column to
  // align: catalog ids differ past column 24, and truncating them
  // against an empty right half made neighbouring rows read identical.
  const labelBudget =
    row.detail.length > 0 ? Math.min(LABEL_WIDTH, inner) : inner;
  const prefix = ` ${marker} ${check}`;
  const label = fitToWidth(`${prefix}${row.label}`, labelBudget);
  const detail = fitToWidth(` ${row.detail}`, Math.max(0, inner - label.length));
  const body = (
    <>
      {/*
        Selection is weight plus the marker, not a second colour: on a
        painted panel a colour swap either fights the ground or is too
        faint to see, and the marker is the part that survives NO_COLOR.
      */}
      {row.emphasis === "fusion" ? (
        <FusionLabel prefix={prefix} word={row.label} width={label.length} selected={selected} />
      ) : (
        <Text color={chromeTheme.colors.railForeground} bold={selected}>
          {label}
        </Text>
      )}
      <Text color={chromeTheme.colors.railMuted}>{detail}</Text>
    </>
  );
  if (!mouse) return <Box>{body}</Box>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // One click acts, the way the operator menu's rows do: this list
        // was opened to pick something from it.
        mouse.dispatch({ type: "composer_switch_cursor_set", cursor: rowIndex });
        onActivate(row);
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}

/**
 * The fusion row's label: marker and check in the rail's ink, the word
 * itself as an orange chip. Same total width as a plain label so the
 * detail column does not move when the cursor lands here. The chip's
 * ink is measured against its own ground (`fusionChipColors`), which is
 * how the palette's page-orange reaches the rail without ever being
 * painted as text on it.
 */
function FusionLabel({
  prefix,
  word,
  width,
  selected,
}: {
  prefix: string;
  word: string;
  width: number;
  selected: boolean;
}): ReactElement {
  const chip = fusionChipColors();
  const chipText = ` ${word} `;
  const pad = Math.max(0, width - prefix.length - chipText.length);
  return (
    <Text>
      <Text color={chromeTheme.colors.railForeground} bold={selected}>
        {prefix}
      </Text>
      <Text backgroundColor={chip.background} color={chip.ink} bold>
        {chipText}
      </Text>
      <Text>{" ".repeat(pad)}</Text>
    </Text>
  );
}
