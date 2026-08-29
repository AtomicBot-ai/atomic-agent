import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { llmHealthLook } from "../components/llm-health-badge.js";
import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import { openLocalModelsPane } from "./composer-switch-activate.js";
import type { ComposerBackendMeta } from "./composer-switch-rows.js";
import type { ComposerSwitchKind } from "./composer-switch-state.js";

/** What the model slot says when the local route has no weights on disk. */
export const DOWNLOAD_MODEL_LABEL = "download model";

export interface ComposerMetaControlsProps {
  backend: ComposerBackendMeta | null;
  provider: string | null;
  model: string | null;
  /**
   * Replaces the model slot with `download model` and points it at the
   * local models pane. Set on the managed-local route when nothing is
   * on disk — see `selectComposerNeedsModelDownload`.
   */
  needsModelDownload?: boolean;
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
 * `● cloud · anthropic · claude-opus-5`.
 *
 * **No status word.** The row used to spell the probe out — `○ local
 * down · …` next to the backend, and a fourth control carrying
 * `healthy · 4.4 GB` on the managed-local route. Both are gone: the
 * words tracked a probe that reported `down` against working daemons
 * often enough that operators learned to ignore the whole right-hand
 * end of the row, and the RAM figure cost a `ps` child process every
 * three seconds to produce. The dot keeps the status it can actually
 * stand behind, and the Models pane owns the detail.
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
 * lands around 2:1 on the classic-dark ground (see `theme-palettes.ts`).
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
  needsModelDownload = false,
  mouseLayer,
}: ComposerMetaControlsProps): ReactElement | null {
  if (!backend && !provider && !model && !needsModelDownload) return null;
  return (
    <>
      {backend ? <BackendControl backend={backend} mouseLayer={mouseLayer} /> : null}
      {provider ? (
        <Control
          kind="provider"
          label={provider}
          lead={Boolean(backend)}
          shrink={1}
          mouseLayer={mouseLayer}
        />
      ) : null}
      {needsModelDownload ? (
        <DownloadModelControl
          lead={Boolean(backend || provider)}
          mouseLayer={mouseLayer}
        />
      ) : model ? (
        <Control
          kind="model"
          label={model}
          lead={Boolean(backend || provider)}
          shrink={3}
          mouseLayer={mouseLayer}
        />
      ) : null}
    </>
  );
}

/**
 * The model slot when the local route has nothing to run: a call to
 * action rather than a switch. Clicking it goes where the download
 * actually happens — the model switch popup would only list the empty
 * catalog and its own deep link to the same pane.
 */
function DownloadModelControl({
  lead,
  mouseLayer,
}: {
  lead: boolean;
  mouseLayer?: number;
}): ReactElement {
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse || !isPrimaryPress(hit.event)) return false;
      openLocalModelsPane(mouse.dispatch);
      return true;
    },
    mouseLayer === undefined ? {} : { layer: mouseLayer },
  );
  return (
    <Box ref={ref} flexShrink={3} minWidth={0}>
      <Text wrap="truncate">
        {lead ? (
          <Text color={theme.colors.railMuted}>
            {" "}
            {theme.glyphs.dotSeparator}{" "}
          </Text>
        ) : null}
        {/*
          The rail's own warn, not the route's `railForeground`: this
          slot is the one thing on the bar the operator has to act on,
          and in the route's own tone it reads as just another label.
          `railWarn` rather than `warnStrong` because this text lands on
          the rail ground, and `warnStrong` is picked to be read on the
          page — on the rail it was one of the pairs the contrast audit
          caught.
        */}
        <Text color={theme.colors.railWarn} bold>
          {DOWNLOAD_MODEL_LABEL}
        </Text>
      </Text>
    </Box>
  );
}

export interface ComposerBackendLook {
  readonly glyph: string;
  readonly color: string;
  /**
   * Retained for callers that render the probe in full — the Models
   * pane does. The composer row deliberately shows the dot alone.
   */
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
 * way the pill did.
 *
 * The look is asked for on the `"rail"` ground: this control sits on the
 * meta bar, and every dot the table hands back for the page — green,
 * amber, red — was picked to be read against the terminal's own
 * background. Only `unreachable` used to be corrected for that, one
 * token at a time; the ground is now a parameter, so all five come back
 * right.
 */
export function composerBackendLook(
  backend: ComposerBackendMeta,
): ComposerBackendLook | null {
  if (backend.status === "unknown") return null;
  const look = llmHealthLook(backend.status, "rail");
  return {
    glyph: look.glyph,
    color: look.color,
    word: backend.kind === "cloud" ? null : look.label,
  };
}

function BackendControl({
  backend,
  mouseLayer,
}: {
  backend: ComposerBackendMeta;
  mouseLayer?: number;
}): ReactElement {
  const look = composerBackendLook(backend);
  return (
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
