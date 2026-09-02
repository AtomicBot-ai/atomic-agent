/**
 * The setup-time contract check, run once per provider save.
 *
 * Deliberately separate from `verifyWizardBeforeSave`, and deliberately
 * unable to stop a save:
 *
 *  - The key gate answers "is this credential usable", and a dead key is
 *    worth refusing because nothing downstream can work without one.
 *  - This answers "can this route run a turn", and the honest response
 *    to "no" is a warning, not a refusal. Some providers block synthetic
 *    probes outright; a custom endpoint the operator knows works must
 *    still be savable, and the operator is the one who decides whether
 *    to live with a route that fires tools only under `auto`.
 *
 * What it must not do is let a failed probe pass for a proven one — the
 * caller keys "this install has a working cloud backend" off a clean
 * result, so an unproven route reports as unproven.
 */

import {
  contractProbeProvesToolSupport,
  runProviderContractProbe,
  type ProviderContractProbeResult,
} from "../../llm/provider/verify/index.js";
import {
  contractProbeTargetForWizard,
  describeContractProbeSkip,
  type ContractProbeSkipReason,
} from "./contract-probe-target.js";
import { describeContractProbeOutcome } from "./describe-contract-probe.js";
import { providerLabelForWizard } from "./providers-wizard-target.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export interface WizardContractProbeOutcome {
  /**
   * `true` only when a complete native tool call came back. Anything
   * else — including a probe that never ran — leaves the route
   * unproven, and callers must treat unproven as unproven.
   */
  readonly proven: boolean;
  /**
   * What to show the operator, or `null` when there is nothing worth
   * saying: the route passed, or there was nothing here to probe.
   */
  readonly warning: string | null;
  /**
   * One sentence for the operator, whatever happened — a clean pass, a
   * defect, or the reason no probe ran. An explicitly requested check
   * has to be able to report all three; a save only wants `warning`.
   */
  readonly summary: string;
  /** Set when no request was made, saying which case this was. */
  readonly skipped: ContractProbeSkipReason | null;
  /** The raw verdict, for callers that log or branch on it. */
  readonly result: ProviderContractProbeResult | null;
}

/**
 * Tighter than the probe module's own budget. This one runs with an
 * operator watching a wizard screen: a route slow enough to blow
 * through it has told us something already, and the save can proceed
 * with the warning rather than holding the screen.
 */
export const WIZARD_CONTRACT_PROBE_TIMEOUT_MS = 12_000;

export async function probeWizardContract(
  wizard: ProvidersWizardState,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WizardContractProbeOutcome> {
  const resolved = contractProbeTargetForWizard(wizard);
  if (resolved.kind === "skipped") {
    return {
      proven: false,
      // Not a warning: none of the skip cases is a defect to act on,
      // and a wizard that reported one would cry wolf on every local
      // server it ever saved.
      warning: null,
      summary: describeContractProbeSkip(
        resolved.reason,
        providerLabelForWizard(wizard),
      ),
      skipped: resolved.reason,
      result: null,
    };
  }
  const target = resolved.target;

  const result = await runProviderContractProbe(target, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs ?? WIZARD_CONTRACT_PROBE_TIMEOUT_MS,
  });
  const proven = contractProbeProvesToolSupport(result.status);
  const summary = describeContractProbeOutcome(result, target.label);
  return {
    proven,
    warning: proven ? null : summary,
    summary,
    skipped: null,
    result,
  };
}
