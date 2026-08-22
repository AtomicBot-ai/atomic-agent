import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { llmHealthLook } from "../components/llm-health-badge.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import { LocalStatusControl } from "./composer-local-status-control.js";
import type { ComposerLocalStatus } from "./composer-local-status.js";
import type { ComposerBackendMeta } from "./composer-switch-rows.js";
import type { ComposerSwitchKind } from "./composer-switch-state.js";

export interface ComposerMetaControlsProps {
  backend: ComposerBackendMeta | null;
  provider: string | null;
  model: string | null;
  /**
   * The managed-local route's third control: daemon status word + RAM
   * (`healthy · 4.4 GB`). Non-null only on that route; when present it
   * also owns the status word, so the backend control shows its dot
   * alone instead of saying the same word twice.
   */
  localStatus?: ComposerLocalStatus | null;
  /**
   * Mouse layer the click targets register on. The composer floats over
   * the chat log with a `MOUSE_LAYER_PANEL` backstop behind it (see
   * `composer-overlay.tsx`), and a control left on the base layer would
   * lose every click to that backstop — the registry offers higher
   * layers first.
   */
  mouseLayer?: number;
}

/**
 * The composer toolbar's route statement, as three controls:
 * `● cloud · anthropic · claude-opus-5` — and, on a probed local
 * backend, the probe's word after the dot: `○ local down · …`.
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
  localStatus,
  mouseLayer,
}: ComposerMetaControlsProps): ReactElement | null {
  if (!backend && !provider && !model && !localStatus) return null;
  return (
    <>
      {backend ? (
        <BackendControl
          backend={backend}
          showWord={!localStatus}
          mouseLayer={mouseLayer}
        />
      ) : null}
      {provider ? (
        <Control
          kind="provider"
          label={provider}
          lead={Boolean(backend)}
          shrink={1}
          mouseLayer={mouseLayer}
        />
      ) : null}
      {model ? (
        <Control
          kind="model"
          label={model}
          lead={Boolean(backend || provider)}
          shrink={3}
          mouseLayer={mouseLayer}
        />
      ) : null}
      {localStatus ? (
        <LocalStatusControl
          status={localStatus}
          lead={Boolean(backend || provider || model)}
          mouseLayer={mouseLayer}
        />
      ) : null}
    </>
  );
}

export interface ComposerBackendLook {
  readonly glyph: string;
  readonly color: string;
  /** Status word after the backend label, `null` when the dot alone is honest. */
  readonly word: string | null;
}

/**
 * What the backend control shows for its status — or `null` for silence.
 *
 * `unknown` draws nothing at all: the shared glyph table's `·` is the
 * very character the row uses as a separator, and the old health pill
 * never appeared in this state either (`localConfigured` gated it), so
 * silence *is* the pill's information content. Cloud keeps its
 * historical green dot but no word — there is no probe behind it, and
 * printing "healthy" would claim an observation nobody made. Local and
 * custom carry the probe's word (healthy / probing / down / error) the
 * way the pill did. `unreachable`'s grey is swapped for the rail-aware
 * token: `theme.colors.muted` was picked against the normal ground and
 * lands near 2.5:1 on the rail (the caveat `prompt-meta-bar.tsx`
 * documents).
 */
export function composerBackendLook(
  backend: ComposerBackendMeta,
): ComposerBackendLook | null {
  if (backend.status === "unknown") return null;
  const look = llmHealthLook(backend.status);
  return {
    glyph: look.glyph,
    color:
      backend.status === "unreachable" ? theme.colors.railMuted : look.color,
    word: backend.kind === "cloud" ? null : look.label,
  };
}

function BackendControl({
  backend,
  showWord,
  mouseLayer,
}: {
  backend: ComposerBackendMeta;
  /**
   * False on the managed-local route, where the daemon-status control
   * at the row's end carries the word — repeating it here would state
   * the same fact twice on one line. The dot stays either way.
   */
  showWord: boolean;
  mouseLayer?: number;
}): ReactElement {
  const look = composerBackendLook(backend);
  return (
    <>
      <Control
        kind="backend"
        label={backend.kind}
        glyph={
          look ? (
            <Text color={look.color} bold>{`${look.glyph} `}</Text>
          ) : undefined
        }
        mouseLayer={mouseLayer}
      />
      {showWord && look?.word ? (
        <StatusWord word={look.word} mouseLayer={mouseLayer} />
      ) : null}
    </>
  );
}

/**
 * The probe's word after the backend label — "a word where space
 * allows", literally: its own flex item with a `flexShrink` above the
 * model's, so it is the first thing on the row to give up columns, and
 * the dot still carries the status once it has.
 */
function StatusWord({
  word,
  mouseLayer,
}: {
  word: string;
  mouseLayer?: number;
}): ReactElement {
  const mouse = useMouseCommands();
  // Clicking the word opens the same switch as the label it annotates —
  // a dead cell in the middle of a clickable phrase reads as a bug.
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      mouse.dispatch({ type: "composer_switch_opened", kind: "backend" });
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
  return (
    <Box ref={ref} flexShrink={4} minWidth={0}>
      <Text wrap="truncate" color={theme.colors.railMuted}>
        {" "}
        {word}
      </Text>
    </Box>
  );
}

function Control({
  kind,
  label,
  glyph,
  lead = false,
  shrink = 0,
  mouseLayer,
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
  /** See `ComposerMetaControlsProps.mouseLayer`. */
  mouseLayer?: number;
}): ReactElement {
  const mouse = useMouseCommands();
  // `useMouseTarget` rather than the `MouseTarget` wrapper: the box needs
  // `minWidth={0}` for Yoga to shrink it at all, and outside a provider
  // (component tests, the wizard's separate Ink tree) the hook hands back
  // an inert ref, so one code path covers both worlds.
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      mouse.dispatch({ type: "composer_switch_opened", kind });
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
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
