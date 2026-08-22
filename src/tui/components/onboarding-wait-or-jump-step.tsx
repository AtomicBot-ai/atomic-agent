import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import { theme } from "../theme/theme.js";
import {
  OnboardingDownloadProgress,
  PROGRESS_TEMPLATE_LINE,
} from "./onboarding-download-progress.js";

/**
 * What the pull is actually doing, which is the one thing this screen
 * is allowed to claim. The pull can end — cleanly or not — while the
 * second cloud wizard hides this screen, and the flow still returns
 * here; a screen that assumed "running" would then draw a 0% bar for a
 * download that is over. Failure is read from the panel's `errorLine`
 * because the reducer nulls the pull itself when it fails.
 */
export type WaitOrJumpPullStatus = "running" | "ready" | "failed";

export function waitOrJumpPullStatus(
  pull: LocalModelsPullState | null,
  errorLine: string | null,
): WaitOrJumpPullStatus {
  if (pull !== null) return "running";
  return errorLine !== null ? "failed" : "ready";
}

/** A failed pull adds the retry row; the keyboard has to agree. */
export function waitOrJumpRowCount(status: WaitOrJumpPullStatus): number {
  return status === "failed" ? 3 : 2;
}

const ROW_COPY = {
  jump: {
    label: "Start using the agent now",
    details: {
      running: "the download keeps running; progress shows in the top bar",
      ready: "local and cloud are both set up",
      failed: "the cloud model is ready to use",
    },
  },
  add: {
    label: "Add another cloud provider",
    detail: "one more key or endpoint, then straight back to this screen",
  },
  retry: {
    label: "Retry the download",
    detail: "starts the same download again",
  },
} as const;

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingWaitOrJumpStep(props: {
  pull: LocalModelsPullState | null;
  pullError: string | null;
  cloudLabel: string;
  modelLabel: string;
  fit: OnboardingFit;
}): number {
  const status = waitOrJumpPullStatus(props.pull, props.pullError);
  const lines: string[] = [`${theme.glyphs.check}  ${props.cloudLabel}`];
  if (status === "running" && props.fit.explainer) {
    lines.push(
      `Still downloading ${props.modelLabel} — it keeps running whichever row you pick.`,
    );
  }
  if (status === "ready") {
    lines.push(
      `${theme.glyphs.check}  ${props.modelLabel} downloaded — the local model is ready too`,
    );
  }
  if (status === "failed") {
    lines.push(
      `The ${props.modelLabel} download failed — the cloud model still works.`,
    );
    // The progress slot draws the error instead of the bars. Left out of
    // the measure like every other error line: the block must not resize
    // itself around an arbitrary message.
  }
  if (status === "running") lines.push(PROGRESS_TEMPLATE_LINE);
  lines.push(`${ROW_INDENT}${ROW_COPY.jump.label}`, `${ROW_INDENT}${ROW_COPY.add.label}`);
  if (status === "failed") lines.push(`${ROW_INDENT}${ROW_COPY.retry.label}`);
  if (props.fit.rowDetails) {
    lines.push(
      `${ROW_INDENT}${ROW_COPY.jump.details[status]}`,
      `${ROW_INDENT}${ROW_COPY.add.detail}`,
    );
    if (status === "failed") lines.push(`${ROW_INDENT}${ROW_COPY.retry.detail}`);
  }
  return widestLine(lines);
}

/**
 * Reached only from the "set up cloud while this downloads" path: the
 * cloud model is ready and the local one was still coming down when the
 * screen was last on top.
 *
 * Everything above the rows is derived from the pull's real state —
 * running draws the same bars the download step draws, finished says
 * the model landed, failed says so and offers to run the pull again.
 *
 * Waiting is not a row. The pull is owned by the orchestrator and the
 * top bar reports it, so sitting on this screen buys nothing the agent
 * does not already give; the things worth doing here are leaving,
 * adding one more cloud provider, and — after a failure — retrying.
 *
 * The bars cost five rows the old summary line did not, so the prose
 * around them is what gets shed on a short terminal — Ink overlaps the
 * rows above rather than clipping, and the rows themselves have to
 * survive that. The ready and failed layouts are strictly shorter than
 * the running one, so the budget is set by the bars.
 */
export function OnboardingWaitOrJumpStep(props: {
  pull: LocalModelsPullState | null;
  /** The pull's failure, from the panel's `errorLine`. */
  pullError: string | null;
  cloudLabel: string;
  modelLabel: string;
  cursor: number;
  fit: OnboardingFit;
}): ReactElement {
  const status = waitOrJumpPullStatus(props.pull, props.pullError);
  const cursor = props.cursor % waitOrJumpRowCount(status);
  const jumpDetail = ROW_COPY.jump.details[status];
  const addDetail = ROW_COPY.add.detail;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
        <Text>{props.cloudLabel}</Text>
      </Text>
      {status === "running" && props.fit.explainer ? (
        <Text color={theme.colors.muted}>
          {`Still downloading ${props.modelLabel} — it keeps running whichever row you pick.`}
        </Text>
      ) : null}
      {status === "ready" ? (
        <Text wrap="truncate">
          <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
          <Text>{`${props.modelLabel} downloaded — the local model is ready too`}</Text>
        </Text>
      ) : null}
      {status === "failed" ? (
        <Text wrap="truncate" color={theme.colors.muted}>
          {`The ${props.modelLabel} download failed — the cloud model still works.`}
        </Text>
      ) : null}
      {status === "ready" ? null : (
        <Box marginTop={1} flexDirection="column">
          <OnboardingDownloadProgress pull={props.pull} error={props.pullError} />
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Row
          selected={cursor === 0}
          label={ROW_COPY.jump.label}
          detail={props.fit.rowDetails ? jumpDetail : null}
        />
        <Row
          selected={cursor === 1}
          label={ROW_COPY.add.label}
          detail={props.fit.rowDetails ? addDetail : null}
        />
        {status === "failed" ? (
          <Row
            selected={cursor === 2}
            label={ROW_COPY.retry.label}
            detail={props.fit.rowDetails ? ROW_COPY.retry.detail : null}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function Row(props: {
  selected: boolean;
  label: string;
  detail: string | null;
}): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.selected ? theme.colors.accent : undefined} bold={props.selected}>
        {`${rowPrefix(props.selected)}${props.label}`}
      </Text>
      {props.detail ? (
        <Text color={theme.colors.muted}>{`${ROW_INDENT}${props.detail}`}</Text>
      ) : null}
    </Box>
  );
}
