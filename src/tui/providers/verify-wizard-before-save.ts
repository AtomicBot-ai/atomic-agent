/**
 * The gate every provider save passes through.
 *
 * Both save paths — the Providers/LLM panel wizard and the first-run
 * onboarding screen — call this before `saveProviderWizardToConfig`, so
 * neither can quietly persist a key the other would have refused.
 *
 * Only a dead key and an empty account stop a save. A timeout, an
 * unreachable host or a throttled key say nothing about whether the key
 * is good, and refusing them would leave an operator behind a proxy, or
 * on a plane, with no way to configure the agent at all — so those save
 * and say so.
 */

import {
  isBlockingVerifyStatus,
  verifyProviderKey,
} from "../../llm/provider/verify/index.js";
import { describeProviderVerifyOutcome } from "./describe-verify-outcome.js";
import { verifyTargetForWizard } from "./providers-wizard-target.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export type WizardVerifyGate =
  | { readonly proceed: true; readonly warning: string | null }
  | { readonly proceed: false; readonly error: string };

export async function verifyWizardBeforeSave(
  wizard: ProvidersWizardState,
  opts: { signal?: AbortSignal } = {},
): Promise<WizardVerifyGate> {
  const target = verifyTargetForWizard(wizard);
  // Nothing to check: a keyless local server, or a service that saves
  // without a key on purpose. Both keep the behaviour they had before.
  if (!target) return { proceed: true, warning: null };

  const result = await verifyProviderKey(target, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const sentence = describeProviderVerifyOutcome(result, target.label);

  if (result.status === "cancelled") {
    return { proceed: false, error: sentence };
  }
  if (isBlockingVerifyStatus(result.status)) {
    return { proceed: false, error: sentence };
  }
  return {
    proceed: true,
    warning: result.status === "ok" ? null : sentence,
  };
}
