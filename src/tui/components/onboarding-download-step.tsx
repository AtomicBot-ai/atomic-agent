import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useAtomField } from "../hooks/use-atom-field.js";
import { atomPopulation } from "../onboarding/atom-field.js";
import {
  formatBytes,
  formatEta,
  useTransferRate,
} from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { theme } from "../theme/theme.js";
import { OnboardingAtomField } from "./onboarding-atom-field.js";

const BAR_WIDTH = 36;
/** Phase-name column, so the two bars start on the same cell. */
const PHASE_LABEL_COLUMNS = 20;
const PHASE_LABELS = ["llama.cpp runtime", "model weights"] as const;
/** Blank cells between the bar and what follows it. */
const PHASE_GAP = "  ";

/**
 * The widest a phase line's trailing text ever gets: a full percentage
 * and two three-digit byte counts.
 *
 * A template rather than the live counters, for the same reason the
 * wait-or-jump screen uses one — the block is centred on this measure,
 * and measuring numbers that change every few hundred milliseconds
 * would walk the whole screen left and right for the length of the
 * download.
 */
const PHASE_TRAILING = "100%   999.9 GB / 999.9 GB";

const CLOUD_OFFER = [
  "┃  Don\u2019t want to wait? Set up a cloud model in the meantime —",
  "┃  it takes about a minute, and the download keeps running.",
] as const;
/** Set bold on the second offer line: it is the key, not the sentence. */
const CLOUD_OFFER_KEY = "    press c";

/**
 * Widest line this step draws, for the block that centres it.
 *
 * The error line is left out on purpose: it carries whatever the pull
 * failed with, and sizing the surface to an arbitrary string would
 * resize the screen around a message. It wraps inside the block instead.
 */
export function measureOnboardingDownloadStep(props: {
  modelLabel: string;
  offerCloudMeanwhile?: boolean;
}): number {
  return widestLine([
    headingLine(props.modelLabel),
    `${" ".repeat(PHASE_LABEL_COLUMNS + BAR_WIDTH)}${PHASE_GAP}${PHASE_TRAILING}`,
    ...(props.offerCloudMeanwhile === false
      ? []
      : [CLOUD_OFFER[0], `${CLOUD_OFFER[1]}${CLOUD_OFFER_KEY}`]),
  ]);
}

function headingLine(modelLabel: string): string {
  return `Downloading ${modelLabel}. You can leave this running.`;
}

/**
 * Fixed rather than drawn from the clock: the field is ambience, so
 * there is nothing to gain from a different arrangement each launch, and
 * a reproducible one can be asserted in a test and described in a bug
 * report.
 */
const ATOM_SEED = 20260821;

/** Below this the free space is a gap, not a field, and stays empty. */
const MIN_ATOM_ROWS = 3;

/**
 * The download, as its own screen.
 *
 * The panel's banner reports a percentage and a byte count; a
 * multi-gigabyte pull also raises "how long", which a percentage cannot
 * answer. Rate and ETA are derived here from the same progress events.
 *
 * Two phases share one progress slot in state — the llama.cpp runtime
 * zip, then the weights — so the checklist above the bar is derived from
 * which one is currently reporting.
 */
export function OnboardingDownloadStep(props: {
  pull: LocalModelsPullState | null;
  /**
   * The panel's `errorLine`. This — not `pull.error` — is how a failed
   * pull actually arrives: `local_models_pull_failed` nulls the pull
   * and leaves the message here, and the next `pull_started` clears it.
   */
  pullError: string | null;
  modelLabel: string;
  /** Hidden once a cloud provider is configured — nothing left to offer. */
  offerCloudMeanwhile?: boolean;
  /** Terminal size, so the atom field knows what space it is allowed. */
  columns: number;
  rows: number;
  /** True while the header draws the brand mark, which is three rows tall. */
  markHeader: boolean;
  /** Test seam: the field's step interval. Defaults to the ambient rate. */
  atomStepMs?: number;
}): ReactElement {
  const pull = props.pull;
  const { bytesPerSecond, etaSeconds } = useTransferRate(
    pull?.transferredBytes ?? 0,
    pull?.totalBytes ?? 0,
  );
  const phase = pull?.kind === "backend" ? "runtime" : "weights";
  const offerCloud = props.offerCloudMeanwhile !== false;
  const atomRows = atomRowBudget({
    rows: props.rows,
    markHeader: props.markHeader,
    hasError: props.pullError != null,
    offerCloud,
  });
  // Stopped when there is nothing left to wait for. Unmounting on a
  // finished pull would clear the interval anyway, but a failed one
  // leaves this screen up with a dead download on it, and a field still
  // drifting under a stalled bar would suggest work is happening. The
  // failure signal is `pullError`: a failed pull nulls `pull` itself,
  // and `pull.error` is never set by any event the app emits.
  const waiting =
    props.pullError == null && !(phase === "weights" && (pull?.percent ?? 0) >= 100);
  // One column short of the terminal: a run that fills the last cell
  // wraps on some terminals, which would cost a row the budget has
  // already spent.
  const fieldColumns = Math.max(0, props.columns - 1);
  const field = useAtomField({
    active: waiting && atomRows >= MIN_ATOM_ROWS,
    columns: fieldColumns,
    rows: atomRows,
    count: atomPopulation({ columns: fieldColumns, rows: atomRows }),
    seed: ATOM_SEED,
    ...(props.atomStepMs === undefined ? {} : { stepMs: props.atomStepMs }),
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted}>{headingLine(props.modelLabel)}</Text>
      <Box marginTop={1} flexDirection="column">
        <PhaseLine
          label={PHASE_LABELS[0]}
          state={phase === "runtime" ? "active" : "done"}
          pull={phase === "runtime" ? pull : null}
        />
        <PhaseLine
          label={PHASE_LABELS[1]}
          state={phase === "weights" ? "active" : "pending"}
          pull={phase === "weights" ? pull : null}
        />
      </Box>
      {pull ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            {bytesPerSecond ? `${formatBytes(bytesPerSecond)}/s · ` : ""}
            {formatEta(etaSeconds)}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>starting…</Text>
        </Box>
      )}
      {props.pullError ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>{props.pullError}</Text>
        </Box>
      ) : null}
      {offerCloud ? (
        <Box flexDirection="column" marginTop={2}>
          {/*
            Accent-marked because it is an offer, not a status line: the
            wait is measured in minutes and a cloud model takes about
            one. The download is owned by the orchestrator, so setting
            one up does not pause or restart it.
          */}
          <Text color={theme.colors.accent}>{CLOUD_OFFER[0]}</Text>
          <Text color={theme.colors.accent}>
            {CLOUD_OFFER[1]}
            <Text bold>{CLOUD_OFFER_KEY}</Text>
          </Text>
        </Box>
      ) : null}
      {waiting && atomRows >= MIN_ATOM_ROWS ? (
        <Box marginTop={1} flexShrink={0}>
          <OnboardingAtomField field={field} columns={fieldColumns} rows={atomRows} />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Rows left over below the offer, once everything above it has been paid
 * for. Ink 7 overlaps rather than clips, so this is what keeps the field
 * off the bars: the atoms get the remainder, or they get nothing.
 *
 * Counted rather than measured, because there is nothing to measure at
 * render time — the numbers are this screen's own fixed chrome, and the
 * frame test is what keeps them honest.
 */
export function atomRowBudget(input: {
  rows: number;
  markHeader: boolean;
  hasError: boolean;
  offerCloud: boolean;
}): number {
  // The host's top padding; the header (three rows with the mark, two
  // without); the step's own top margin; the "Downloading …" line; the
  // two bars and their margin; the rate line and its margin; the field's
  // top margin; the pinned footer.
  const chrome = 1 + (input.markHeader ? 3 : 2) + 1 + 1 + 3 + 2 + 1 + 1;
  const error = input.hasError ? 2 : 0;
  const offer = input.offerCloud ? 4 : 0;
  return Math.max(0, input.rows - chrome - error - offer);
}

function PhaseLine(props: {
  label: string;
  state: "active" | "done" | "pending";
  pull: LocalModelsPullState | null;
}): ReactElement {
  const percent = props.state === "done" ? 100 : (props.pull?.percent ?? 0);
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const trailing =
    props.state === "done"
      ? "done"
      : props.pull
        ? `${Math.round(percent)}%   ${formatBytes(props.pull.transferredBytes)} / ${formatBytes(props.pull.totalBytes)}`
        : "waiting";
  return (
    <Text wrap="truncate">
      <Text color={theme.colors.muted}>{props.label.padEnd(PHASE_LABEL_COLUMNS)}</Text>
      <Text color={props.state === "pending" ? theme.colors.border : theme.colors.accent}>
        {bar}
      </Text>
      <Text color={theme.colors.muted}>{`${PHASE_GAP}${trailing}`}</Text>
    </Text>
  );
}
