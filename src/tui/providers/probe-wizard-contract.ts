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
 *    probes outright, and a custom endpoint the operator knows works
 *    must still be savable.
 *
 * What it must not do is let a failed probe pass for a proven one — the
 * caller keys "this install has a working cloud backend" off a clean
 * result, so an unproven route reports as unproven. Nor may it warn
 * about something a turn cannot hit: `contractProbeProvesToolSupport`
 * counts a route that refuses a *forced* tool choice and streams a call
 * under `auto` as proven, because `auto` is the only mode Atomic ever
 * sends, and a warning there would be about a bug the operator is not
 * having.
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
   * saying: the route ran a turn's worth of work, or there was nothing
   * here to probe. `null` is also what the caller's
   * "report a working backend" gate keys off, so a probe that ran and
   * did not prove the route always fills this in.
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

  // No budget of its own: `PROVIDER_CONTRACT_PROBE_TIMEOUT_MS` is
  // already sized for an operator watching a wizard screen, and this is
  // the only entry point the probe has.
  const result = await runProviderContractProbe(target, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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
