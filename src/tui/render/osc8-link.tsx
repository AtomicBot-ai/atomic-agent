import { Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface Osc8LinkProps {
  url: string;
  /** Label shown to the user; falls back to the URL when missing. */
  label?: string;
}

const OSC8_OPEN = "\u001b]8;;";
const OSC8_TERMINATOR = "\u001b\\";
const OSC8_CLOSE = `\u001b]8;;${OSC8_TERMINATOR}`;

/**
 * Wraps text with ANSI OSC 8 escape sequences so terminals that support
 * them (iTerm2, WezTerm, kitty, Windows Terminal 1.4+, modern gnome-
 * terminal) render a clickable hyperlink. Terminals that do not
 * understand the sequence silently strip the escape codes and display
 * the label text unchanged.
 */
export function Osc8Link({ url, label }: Osc8LinkProps): ReactElement {
  const display = label && label.length > 0 ? label : url;
  return (
    <Text color={theme.colors.info} underline>
      {wrapOsc8(display, url)}
    </Text>
  );
}

/** Pure helper exposed for tests: wrap any string in an OSC 8 hyperlink. */
export function wrapOsc8(text: string, url: string): string {
  if (!url) return text;
  return `${OSC8_OPEN}${url}${OSC8_TERMINATOR}${text}${OSC8_CLOSE}`;
}

export const OSC8_CONSTANTS = {
  open: OSC8_OPEN,
  close: OSC8_CLOSE,
  terminator: OSC8_TERMINATOR,
} as const;
