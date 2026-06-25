import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { THEME_NAMES, THEMES, theme, type ThemeName } from "../theme/theme.js";

export interface ThemePickerProps {
  /** Highlighted row index into {@link THEME_NAMES}. */
  cursor: number;
  /** Theme name that was active when the picker opened (the "current" mark). */
  original: string;
}

const MAX_ROWS = 12;

// The palette roles shown as inline swatches so the operator previews the
// actual colours of each theme without leaving the list.
const SWATCH_ROLES = [
  "accent",
  "success",
  "error",
  "warn",
  "reasoning",
] as const;

/**
 * Interactive theme list rendered above the editor when
 * `state.themePickerOpen` is true. Up/Down move (with live preview applied by
 * the app shell), Enter commits + persists, Esc reverts. Each row previews the
 * theme's own colours via small swatches.
 */
export function ThemePicker(props: ThemePickerProps): ReactElement {
  const { cursor, original } = props;
  const clamped = Math.max(0, Math.min(cursor, THEME_NAMES.length - 1));
  const windowStart = computeWindowStart(clamped, THEME_NAMES.length, MAX_ROWS);
  const visible = THEME_NAMES.slice(windowStart, windowStart + MAX_ROWS);
  const visibleCursor = clamped - windowStart;
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(
    0,
    THEME_NAMES.length - windowStart - visible.length,
  );
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.muted}>
        themes ({THEME_NAMES.length}) — ↑↓ preview · Enter apply · Esc cancel
      </Text>
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {visible.map((name, idx) => (
        <ThemeRow
          key={name}
          name={name}
          selected={idx === visibleCursor}
          current={name === original}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
    </Box>
  );
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}

function ThemeRow({
  name,
  selected,
  current,
}: {
  name: ThemeName;
  selected: boolean;
  current: boolean;
}): ReactElement {
  const colors = THEMES[name].colors;
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const marker = current ? theme.glyphs.assistantMarker : " ";
  return (
    <Box>
      <Text
        color={selected ? theme.colors.accentSoft : theme.colors.muted}
        bold={selected}
      >
        {chevron} {marker} {name.padEnd(18)}
      </Text>
      <Text>{"  "}</Text>
      {SWATCH_ROLES.map((role) => (
        <Text key={role} color={colors[role]}>
          {theme.glyphs.bullet}
        </Text>
      ))}
      {current ? (
        <Text color={theme.colors.muted}>{"  (current)"}</Text>
      ) : null}
    </Box>
  );
}
