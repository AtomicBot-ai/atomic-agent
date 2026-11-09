import { GOAL_CHECK_OUTPUT_MAX_CHARS, type GoalCheckResult, type GoalState } from "./goal-types.js";

/**
 * The words goal mode puts in the conversation: the message that starts
 * work on a goal and the one that starts each next round. They are the
 * user turn of their round, so the model reads them like any request.
 */

/** First message of a goal when the person typed none of their own. */
export function buildGoalKickoffMessage(state: GoalState): string {
  return [
    "Work on this goal until every item on the acceptance list is done.",
    "",
    acceptanceList(state),
    ...checksBlock(state),
    "",
    "When you finish a round, reply with what you did and the evidence for each item.",
    "If you cannot go on without me (a decision, access, a credential), say exactly what you need.",
  ].join("\n");
}

/**
 * The next round's message. Failing checks come first with their trimmed
 * output (Hermes: a failing gate's output is the next prompt); without
 * them, the items the judge did not accept, with its reasons.
 */
export function buildGoalContinuationMessage(
  state: GoalState,
  failingChecks: readonly GoalCheckResult[],
): string {
  const header =
    `Goal round ${state.roundsUsed + 1} of ${state.maxRounds}. The goal is not done yet.`;
  if (failingChecks.length > 0) {
    return [
      header,
      "",
      `${failingChecks.length} check${failingChecks.length === 1 ? "" : "s"} failed:`,
      ...failingChecks.flatMap(formatFailingCheck),
      "",
      "Fix what makes them fail, then reply with what you changed.",
      "",
      acceptanceList(state),
    ].join("\n");
  }
  const open = state.criteria
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.mark !== "met");
  return [
    header,
    "",
    "Not accepted yet:",
    ...open.map(({ c, i }) => `${i + 1}. ${c.text}${c.reason ? `: ${c.reason}` : ""}`),
    "",
    "Continue the work on these items and reply with concrete evidence for each.",
  ].join("\n");
}

/** Trim a check's output to the end that usually holds the failure. */
export function trimCheckOutput(output: string): string {
  const text = output.trim();
  if (text.length <= GOAL_CHECK_OUTPUT_MAX_CHARS) return text;
  return `…${text.slice(text.length - GOAL_CHECK_OUTPUT_MAX_CHARS + 1)}`;
}

function formatFailingCheck(check: GoalCheckResult): string[] {
  const why = check.timedOut
    ? "timed out"
    : check.exitCode === null ? "did not run" : `exit ${check.exitCode}`;
  const output = check.output.trim();
  return [
    `- \`${check.command}\` (${why})`,
    ...(output.length > 0 ? ["```", output, "```"] : []),
  ];
}

function acceptanceList(state: GoalState): string {
  return [
    "Acceptance list:",
    ...state.criteria.map((c, i) => `${i + 1}. ${c.text}`),
  ].join("\n");
}

function checksBlock(state: GoalState): string[] {
  if (state.checks.length === 0) return [];
  return [
    "",
    "These commands must pass (exit 0) after each round:",
    ...state.checks.map((c) => `- \`${c}\``),
  ];
}
