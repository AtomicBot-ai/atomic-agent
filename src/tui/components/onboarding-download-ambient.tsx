import type { ReactElement } from "react";
import { useAtomField } from "../hooks/use-atom-field.js";
import { atomPopulation } from "../onboarding/atom-field.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import type { OnboardingMark } from "../onboarding/onboarding-fit.js";
import { countOnboardingDownloadBlockRows } from "./onboarding-download-step.js";
import { OnboardingAtomField } from "./onboarding-atom-field.js";

/**
 * Fixed rather than drawn from the clock: the field is ambience, so
 * there is nothing to gain from a different arrangement each launch, and
 * a reproducible one can be asserted in a test and described in a bug
 * report.
 */
const ATOM_SEED = 20260821;

/** Below this the free space is a gap, not a field, and stays empty. */
export const MIN_ATOM_ROWS = 3;

/**
 * Rows the ambient field may fill, from the placement's own arithmetic
 * rather than a hand-counted sum of the host's chrome: the viewport the
 * placement budgets (terminal minus the surface's padding and footer)
 * splits its free rows evenly around the centred block, the field lives
 * in the bottom half, and one row is held back so the atoms never touch
 * the offer above them.
 */
export function downloadAmbientRows(input: {
  /** `placement.rows` — the viewport between the padding and the footer. */
  viewportRows: number;
  mark: OnboardingMark;
  offerCloud: boolean;
}): number {
  const free =
    input.viewportRows -
    countOnboardingDownloadBlockRows({ mark: input.mark, offerCloud: input.offerCloud });
  return Math.max(0, Math.floor(free / 2) - 1);
}

/**
 * The download screen's ambience: the atom field, drifting below the
 * centred text block at the full width of the terminal.
 *
 * Mounted by `OnboardingScreen` in the surface's bottom spacer rather
 * than inside the download step — the step's block is centred to its
 * own text now, and a full-width field cannot live inside a box that
 * narrow. Renders nothing unless a pull is genuinely in flight and the
 * budget clears `MIN_ATOM_ROWS`.
 */
export function OnboardingDownloadAmbient(props: {
  pull: LocalModelsPullState | null;
  /** The panel's `errorLine` — how a failed pull actually arrives. */
  pullError: string | null;
  /** Columns the surface can spare: the terminal minus its root inset. */
  columns: number;
  /** `placement.rows`, so the budget shares the placement's arithmetic. */
  viewportRows: number;
  mark: OnboardingMark;
  /** Whether the meanwhile offer is on screen, which costs the block rows. */
  offerCloud: boolean;
  /** Test seam: the field's step interval. Defaults to the ambient rate. */
  atomStepMs?: number;
}): ReactElement | null {
  const rows = downloadAmbientRows({
    viewportRows: props.viewportRows,
    mark: props.mark,
    offerCloud: props.offerCloud,
  });
  const phase = props.pull?.kind === "backend" ? "runtime" : "weights";
  // Stopped when there is nothing left to wait for: a field still
  // drifting under a stalled bar would suggest work is happening. The
  // failure signal is `pullError` — a failed pull nulls `pull` itself,
  // and `pull.error` is never set by any event the app emits.
  const waiting =
    props.pullError == null &&
    !(phase === "weights" && (props.pull?.percent ?? 0) >= 100);
  // One column short of the terminal: a run that fills the last cell
  // wraps on some terminals, which would cost a row the budget has
  // already spent.
  const fieldColumns = Math.max(0, props.columns - 1);
  const active = waiting && rows >= MIN_ATOM_ROWS;
  const field = useAtomField({
    active,
    columns: fieldColumns,
    rows,
    count: atomPopulation({ columns: fieldColumns, rows }),
    seed: ATOM_SEED,
    ...(props.atomStepMs === undefined ? {} : { stepMs: props.atomStepMs }),
  });
  if (!active) return null;
  return <OnboardingAtomField field={field} columns={fieldColumns} rows={rows} />;
}
