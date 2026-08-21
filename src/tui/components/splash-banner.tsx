import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { computeChatViewportRows, computeChatWidth } from "../layout.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import { Logo } from "./logo.js";
import {
  computeSplashFit,
  SPLASH_TIPS,
  type SplashFit,
  type SplashSize,
  type SplashTip,
  type TipDescriptions,
} from "./splash-fit.js";

/**
 * Welcome screen shown in place of an empty chat-log. Renders the brand
 * `Logo` (atomic-plus mark + wordmark) vertically centred via flexGrow
 * spacers, with a compact tip-list underneath that surfaces the most
 * useful slash commands.
 *
 * Everything on it is sized against the live terminal: the mark shrinks
 * (34×20 → 17×10 → one line) as the window narrows or shortens, the tip
 * list drops entries from its tail, and the tip descriptions collapse to
 * terse copy before disappearing entirely. See `splash-fit.ts` for the
 * breakpoints — this component only renders the plan it is handed.
 *
 * Visibility is decided by the parent (`ChatLog`) based on
 * `messages.length === 0`, so restoring a historical session via
 * `/sessions` swaps the banner out for the transcript.
 */
export interface SplashBannerProps {
  /**
   * Explicit surface size, bypassing the terminal measurement. Only
   * used by tests — ink-testing-library's stdout stub reports a fixed
   * 100×0, which would pin every rendered frame to one breakpoint.
   */
  size?: SplashSize;
}

export function SplashBanner({ size }: SplashBannerProps = {}): ReactElement {
  const terminal = useTerminalSize();
  const surface: SplashSize = size ?? {
    columns: computeChatWidth(terminal.columns, terminal.rows),
    rows: computeChatViewportRows(terminal.rows, terminal.columns),
  };
  const fit = computeSplashFit(surface);
  const tips = SPLASH_TIPS.slice(0, fit.tipCount);
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingX={2}>
      <Box flexGrow={1} />
      {fit.logo === "none" ? null : (
        <Logo variant={fit.logo} wordmark={fit.wordmark} tagline={fit.tagline} />
      )}
      {tips.length > 0 ? (
        <Box
          marginTop={fit.logo === "none" ? 0 : 1}
          flexDirection="column"
        >
          {tips.map((tip) => (
            <Tip key={tip.label} tip={tip} fit={fit} />
          ))}
        </Box>
      ) : null}
      <Box flexGrow={1} />
    </Box>
  );
}

interface TipProps {
  tip: SplashTip;
  fit: SplashFit;
}

function Tip({ tip, fit }: TipProps): ReactElement {
  const label =
    fit.labelWidth > 0 ? tip.label.padEnd(fit.labelWidth, " ") : tip.label;
  const mouse = useMouseCommands();
  const row = (
    <Text wrap="truncate">
      <Text color={theme.colors.muted}>  {theme.glyphs.bullet} </Text>
      <Text color={theme.colors.accent}>{label}</Text>
      <Text color={theme.colors.muted}>{description(tip, fit.descriptions)}</Text>
    </Text>
  );
  if (!mouse) return row;
  return (
    <MouseTarget
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // Put the command in the composer rather than running it: the
        // row is a suggestion, and Enter is the operator's to press.
        // `/model` and friends take arguments, and a click that fired
        // them outright would rob a mis-click of its undo.
        if (mouse.getState().chatFocus !== "editor") {
          mouse.dispatch({ type: "chat_focus_set", focus: "editor" });
        }
        // Trailing space, matching the palette's own completion: it
        // leaves the caret past the command and keeps `slashPrefix`
        // from re-opening the palette over the buffer we just seeded.
        mouse.dispatch({ type: "input_changed", value: `${tip.command} ` });
        return true;
      }}
    >
      {row}
    </MouseTarget>
  );
}

function description(tip: SplashTip, mode: TipDescriptions): string {
  if (mode === "full") return tip.description;
  if (mode === "short") return tip.short;
  return "";
}
