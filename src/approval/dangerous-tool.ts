import type { ApprovalGate } from "./approval-gate.js";
import type { ApprovalCategory } from "./approval-level.js";

export interface DangerousToolOptions {
  approvals: ApprovalGate;
  /**
   * Test-only seam: production wiring always passes `true` (see the
   * bootstrap's `dangerous` options), and the ApprovalGate owns the live
   * switch via its approval level. `false` here skips the gate
   * entirely and exists so unit tests can exercise tools without one.
   */
  approvalRequired: boolean;
}

export interface ApprovalPrompt {
  sessionId: string;
  tool: string;
  /** Request category — decides at which approval level the prompt goes silent. */
  category: ApprovalCategory;
  reason: string;
  preview?: string;
  affectedResources?: string[];
  /** Command binary (argv[0]) for shell requests; unit of a shape grant. */
  commandShape?: string;
  /**
   * Absolute path the host may offer to retarget before approving. See
   * `ApprovalRequest.redirectablePath` — set only by `os.fs.write`.
   */
  redirectablePath?: string;
  /**
   * Files the call would change, for the gate's same-turn denial rule.
   * See `ApprovalRequest.targetPaths`.
   */
  targetPaths?: readonly string[];
}

/**
 * What a survived approval tells the caller. Today that is only the
 * operator's retarget, if they used it; a denial throws rather than
 * returning, so reaching this value means "approved".
 */
export interface ApprovalOutcome {
  /**
   * Raw replacement path as typed by the operator, or `undefined` when
   * they approved the call as proposed. Unresolved and unvalidated on
   * purpose: only the tool knows the working directory to resolve it
   * against and what re-categorising it means.
   */
  pathOverride?: string;
}

/**
 * A gated call that did not get its approval. The message is what the
 * model reads as the tool result (every path folds it in verbatim), so
 * it says plainly who decided — see `describeApprovalDenial`.
 *
 * `byUser` is false when no person made the call: a session refuse
 * policy, a prompt that timed out or could not be delivered, one dropped
 * because its surface went away. Those carry the system's `reason`; a
 * person's denial carries their own words, if they typed any. A repeat
 * the gate refused because the user already declined it this turn is
 * `declinedEarlier`: nobody was asked this time, but it reads, and is
 * reported, as the user's decision.
 */
export class ApprovalDeniedError extends Error {
  public readonly byUser: boolean;
  /** See `ApprovalDecision.declinedEarlier`. */
  public readonly declinedEarlier: boolean;

  constructor(
    public readonly tool: string,
    public readonly reason?: string,
    options: { byUser?: boolean; declinedEarlier?: boolean } = {},
  ) {
    const byUser = options.byUser ?? false;
    const declinedEarlier = options.declinedEarlier ?? false;
    super(describeApprovalDenial(tool, reason, byUser, declinedEarlier));
    this.name = "ApprovalDeniedError";
    this.byUser = byUser;
    this.declinedEarlier = declinedEarlier;
  }
}

/**
 * The tool-result text for a denied approval.
 *
 * A bare "approval denied for os.fs.write" reads to a model like a
 * policy block or a broken tool: it has told a user who pressed Deny
 * that "the security system rejected the file name", and it retries or
 * works around the denial (ATO-245, ATO-225). So a person's denial says
 * it was their decision and what to do with it; their words, when they
 * typed some instead of pressing Deny, come last so a long reply only
 * loses its own tail to the summary cap. A denial nobody decided says
 * so too, and never claims the user declined. A repeat of something the
 * user declined earlier in the turn (`declinedEarlier`, with `reason`
 * naming what they declined) says that, not "refused without a
 * decision": the system-refusal framing is what ATO-245 removed.
 */
export function describeApprovalDenial(
  tool: string,
  reason: string | undefined,
  byUser: boolean,
  declinedEarlier = false,
): string {
  const words = reason?.trim() ?? "";
  if (declinedEarlier) {
    return (
      `${tool} was not run: the user already declined ${words || "it"} ` +
      "earlier in this turn, so it was not asked again. " +
      "Do not try it again or another way; " +
      "tell the user it was not done and ask what they would like instead."
    );
  }
  if (!byUser) {
    return (
      `${tool} was not run: refused without a decision from the user` +
      (words ? `. Reason: ${words}` : ".")
    );
  }
  const decision = "This was their decision, not an error or a policy block.";
  if (words) {
    return (
      `The user declined this ${tool} call. ${decision} ` +
      `Do not run the same call again; go by what they said. The user said: ${words}`
    );
  }
  return (
    `The user declined this ${tool} call (they pressed Deny). ${decision} ` +
    "Do not retry it or try another way to do the same thing; " +
    "tell the user it was not done and ask what they would like instead."
  );
}

/**
 * Shared helper used by dangerous tools (shell.run, fs.write,
 * skill.run_script, …). Centralising it ensures every tool sends the same
 * approval payload shape and honours the `approvalRequired` override in a
 * single place.
 */
export async function requireApproval(
  options: DangerousToolOptions,
  prompt: ApprovalPrompt,
  signal: AbortSignal,
): Promise<ApprovalOutcome> {
  if (!options.approvalRequired) return {};
  const decision = await options.approvals.request(
    {
      sessionId: prompt.sessionId,
      tool: prompt.tool,
      category: prompt.category,
      reason: prompt.reason,
      ...(prompt.preview !== undefined ? { preview: prompt.preview } : {}),
      ...(prompt.affectedResources !== undefined
        ? { affectedResources: prompt.affectedResources }
        : {}),
      ...(prompt.commandShape !== undefined
        ? { commandShape: prompt.commandShape }
        : {}),
      ...(prompt.redirectablePath !== undefined
        ? { redirectablePath: prompt.redirectablePath }
        : {}),
      ...(prompt.targetPaths !== undefined && prompt.targetPaths.length > 0
        ? { targetPaths: [...prompt.targetPaths] }
        : {}),
    },
    { signal },
  );
  if (!decision.approved) {
    throw new ApprovalDeniedError(prompt.tool, decision.reason, {
      byUser: decision.automatic !== true,
      declinedEarlier: decision.declinedEarlier === true,
    });
  }
  // A retarget is only meaningful for a request that offered one. A host
  // that returns `pathOverride` for a call with no `redirectablePath` is
  // answering a question nobody asked, so it is dropped here rather than
  // handed to a tool that would not know what to do with it.
  if (
    prompt.redirectablePath === undefined ||
    decision.pathOverride === undefined
  ) {
    return {};
  }
  return { pathOverride: decision.pathOverride };
}
