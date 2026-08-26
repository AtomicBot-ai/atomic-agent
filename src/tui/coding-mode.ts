import {
  clampApprovalLevel,
  MAX_APPROVAL_LEVEL,
  type ApprovalLevel,
} from "../approval/approval-level.js";

/**
 * The stance the operator is working in, as one control.
 *
 * The machinery for three of these already existed and was spread across
 * two places that do not look like each other: the five-step approval
 * ladder on the Privacy tab, and (as of this change) plan mode in the
 * agent loop. Neither is somewhere you go mid-thought. "Let it edit
 * without asking for the next ten minutes" and "read only, tell me what
 * you would do" are decisions made *while typing*, and a decision made
 * while typing needs to be one keystroke from the composer.
 *
 * So this is a projection, not a new subsystem. Each mode resolves to an
 * approval level and a plan-mode flag; nothing else in the app learns a
 * new concept, and the Privacy tab keeps working exactly as it did.
 */
export type CodingMode = "default" | "accept-edits" | "plan" | "bypass";

/**
 * Cycle order, and it is not the order of severity.
 *
 * Severity order — `plan, default, accept-edits, bypass` — reads well
 * and is wrong, because the ring *wraps*: on four modes it leaves
 * `bypass` one backward press from `plan`, which is exactly where a
 * careful operator parks. Two keys apart is the most a four-ring
 * allows, and putting `plan` at index 1 and `bypass` at index 3 gets
 * it while keeping `default` and `plan` adjacent — the pair people
 * actually move between — and keeping the first forward press from
 * `default` the *safe* one.
 */
export const CODING_MODES: readonly CodingMode[] = [
  "default",
  "plan",
  "accept-edits",
  "bypass",
];

export interface CodingModeLook {
  /** What the chip prints. */
  readonly label: string;
  /**
   * The second column of the menu: what picking this row would mean, in
   * few enough words to sit beside the label without wrapping.
   *
   * Separate from `summary` on purpose. The summary is a sentence the
   * chat log prints once, after the fact; this is a label read *while
   * deciding*, next to three alternatives, and the two jobs want very
   * different lengths.
   */
  readonly detail: string;
  /** Which palette role paints the chip's ground. */
  readonly tone: "accent" | "success" | "warn" | "error";
  /** One line for the system message on switching. */
  readonly summary: string;
}

const LOOKS: Readonly<Record<CodingMode, CodingModeLook>> = {
  plan: {
    label: "plan",
    detail: "reads only — proposes, changes nothing",
    tone: "accent",
    summary:
      "plan mode — the agent reads and proposes, and every tool that would change something is refused",
  },
  default: {
    label: "default",
    detail: "asks before anything risky",
    tone: "success",
    summary: "default — approvals follow the level set on the Privacy tab",
  },
  "accept-edits": {
    label: "accept edits",
    detail: "writes in this folder without asking",
    tone: "warn",
    summary:
      "accept edits — file writes inside this workspace stop asking; everything else still does",
  },
  bypass: {
    label: "bypass permissions",
    detail: "never asks — nothing is gated",
    tone: "error",
    summary:
      "bypass permissions — nothing asks, for the rest of this session. Hardline shell-guard rules still block.",
  },
};

export function codingModeLook(mode: CodingMode): CodingModeLook {
  return LOOKS[mode];
}

export interface ResolvedCodingMode {
  readonly approvalLevel: ApprovalLevel;
  readonly planMode: boolean;
}

/**
 * What a mode means to the runtime.
 *
 * `baseLevel` is the level the operator actually configured — the one
 * the Privacy tab shows and `config.json` holds. It is a parameter
 * rather than a constant because `default` has to *restore* it: a
 * session that went to `bypass` and back must land on the level it
 * started from, not on a hardcoded 1, or the control would quietly
 * tighten every operator who had chosen otherwise.
 *
 * `accept-edits` raises to level 2 (workspace file writes stop asking)
 * but never *lowers*: an operator already at 4 who asks for accept-edits
 * is asking for at least that, and clamping them down to 2 would be a
 * surprise in the direction that costs them prompts.
 */
export function resolveCodingMode(
  mode: CodingMode,
  baseLevel: ApprovalLevel,
): ResolvedCodingMode {
  switch (mode) {
    case "plan":
      // The ladder is left exactly where it was. Plan mode refuses
      // mutations outright, so the level it would have asked at is
      // moot — and leaving it alone is what lets `default` restore it
      // without remembering anything extra.
      return { approvalLevel: baseLevel, planMode: true };
    case "accept-edits":
      return {
        approvalLevel: clampApprovalLevel(Math.max(baseLevel, 2)),
        planMode: false,
      };
    case "bypass":
      return { approvalLevel: MAX_APPROVAL_LEVEL, planMode: false };
    case "default":
      return { approvalLevel: baseLevel, planMode: false };
  }
}

/** The next mode in the ring; `back` walks it the other way. */
export function cycleCodingMode(
  mode: CodingMode,
  back = false,
): CodingMode {
  const index = CODING_MODES.indexOf(mode);
  const from = index === -1 ? 0 : index;
  const step = back ? -1 : 1;
  const next = (from + step + CODING_MODES.length) % CODING_MODES.length;
  return CODING_MODES[next]!;
}
