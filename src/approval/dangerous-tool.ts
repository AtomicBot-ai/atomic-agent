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

export class ApprovalDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason?: string,
  ) {
    super(`approval denied for ${tool}${reason ? `: ${reason}` : ""}`);
    this.name = "ApprovalDeniedError";
  }
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
    },
    { signal },
  );
  if (!decision.approved) {
    throw new ApprovalDeniedError(prompt.tool, decision.reason);
  }
  // A retarget is only meaningful for a request that offered one. A host
  // that returns `pathOverride` for a call with no `redirectablePath` is
  // answering a question nobody asked, so it is dropped here rather than
  // handed to a tool that would not know what to do with it.
  if (prompt.redirectablePath === undefined || decision.pathOverride === undefined) {
    return {};
  }
  return { pathOverride: decision.pathOverride };
}
