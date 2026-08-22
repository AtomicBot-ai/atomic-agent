import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { llmHealthLook } from "../components/llm-health-badge.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import type { ComposerBackendMeta } from "./composer-switch-rows.js";
import type { ComposerSwitchKind } from "./composer-switch-state.js";

export interface ComposerMetaControlsProps {
  backend: ComposerBackendMeta | null;
  provider: string | null;
  model: string | null;
}

/**
 * The composer toolbar's route statement, as three controls:
 * `● cloud · anthropic · claude-opus-5`.
 *
 * **Order.** Where it runs, who serves it, which model — the order the
 * route is actually decided in. The model used to come first, which put
 * the most volatile label in the position the eye anchors on and left
 * the provider reading as a footnote to it.
 *
 * **Tone.** All three are `railForeground`: this row states what the
 * agent *is*, and the old palette said the opposite by drawing the
 * provider in `railMuted` and the backend word in a literal `gray`. The
 * dot keeps its status colour and the separators stay muted, so the
 * three words read as three things rather than one long string. Nothing
 * here reaches for `accentSoft` — that token is a fill, and as text it
 * lands around 2:1 on the atomic-retro ground (see `theme-palettes.ts`).
 *
 * **Width.** Ink does not clip an over-wide row, it wraps it, and a
 * second line here would push the composer's bottom border down. So the
 * row fits by shrinking rather than by being cut off: the model gives
 * first, the provider second, the backend word and the separators never.
 *
 * Each word is a button. Clicking one opens its switch; `ctrl+r` opens
 * the strip from the keyboard and the arrows walk it, because a control
 * only a mouse can reach is not a control in a terminal app.
 */
export function ComposerMetaControls({
  backend,
  provider,
  model,
}: ComposerMetaControlsProps): ReactElement | null {
  if (!backend && !provider && !model) return null;
  return (
    <>
      {backend ? <BackendControl backend={backend} /> : null}
      {provider ? (
        <Control
          kind="provider"
          label={provider}
          lead={Boolean(backend)}
          shrink={1}
        />
      ) : null}
      {model ? (
        <Control
          kind="model"
          label={model}
          lead={Boolean(backend || provider)}
          shrink={3}
        />
      ) : null}
    </>
  );
}

function BackendControl({
  backend,
}: {
  backend: ComposerBackendMeta;
}): ReactElement {
  const look = llmHealthLook(backend.status);
  return (
    <Control
      kind="backend"
      label={backend.kind}
      glyph={<Text color={look.color} bold>{`${look.glyph} `}</Text>}
    />
  );
}

function Control({
  kind,
  label,
  glyph,
  lead = false,
  shrink = 0,
}: {
  kind: ComposerSwitchKind;
  label: string;
  glyph?: ReactElement;
  /**
   * Draw the dot separator that precedes this control. It belongs to the
   * control rather than sitting between two of them so that the pair
   * truncates as one unit: a separator of its own would survive the
   * label it introduces and leave the row ending in a dangling dot.
   */
  lead?: boolean;
  /**
   * How eagerly this control gives up columns. The model goes first and
   * the provider second; the backend word is a handful of characters
   * that name the whole route, and losing it costs more than either.
   */
  shrink?: number;
}): ReactElement {
  const mouse = useMouseCommands();
  // `useMouseTarget` rather than the `MouseTarget` wrapper: the box needs
  // `minWidth={0}` for Yoga to shrink it at all, and outside a provider
  // (component tests, the wizard's separate Ink tree) the hook hands back
  // an inert ref, so one code path covers both worlds.
  const ref = useMouseTarget((hit) => {
    if (!mouse || !isPrimaryPress(hit.event)) return false;
    mouse.dispatch({ type: "composer_switch_opened", kind });
    return true;
  });
  return (
    <Box ref={ref} flexShrink={shrink} minWidth={0}>
      <Text wrap="truncate">
        {lead ? (
          <Text color={theme.colors.railMuted}>
            {" "}
            {theme.glyphs.dotSeparator}{" "}
          </Text>
        ) : null}
        {glyph ?? null}
        <Text color={theme.colors.railForeground} bold>
          {label}
        </Text>
      </Text>
    </Box>
  );
}
