/**
 * What to send the contract probe, derived from a wizard run — or why
 * there is nothing here to probe.
 *
 * Same endpoint resolution the key check uses (`endpointForKind`,
 * `apiKeyForWizard`), with one deliberate difference: the model.
 *
 * `pickProbeModels` picks the *cheapest paid* model it can find, because
 * the key check's question is "can this account pay for a token". The
 * contract probe's question is "can the route I am about to use run a
 * turn", and route limitations are per-model — a gateway can stream
 * native tool calls for one model and refuse `tools` outright for
 * another. Probing anything but the configured model would answer a
 * question nobody asked.
 *
 * The skip cases are named rather than collapsed into `null` because an
 * explicitly requested check has to report them: "this is a server on
 * your own machine" and "this provider has no key yet" are different
 * answers, and telling an operator the second when the first is true is
 * how a diagnostic tool loses their trust.
 */

import { getConfig } from "../../config/index.js";
import type { ProviderContractProbeTarget } from "../../llm/provider/verify/index.js";
import { isLocalProviderUrl } from "./is-local-provider-url.js";
import {
  apiKeyForWizard,
  chosenModelForWizard,
  endpointForKind,
  providerLabelForWizard,
} from "./providers-wizard-target.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export type ContractProbeSkipReason =
  /** The wizard has not settled on a provider kind yet. */
  | "no_kind"
  /** A subscription CLI: a subprocess, not an HTTP contract. */
  | "cli_backed"
  /** A server on the operator's own machine. */
  | "local_endpoint"
  /** No key resolved, and this service is not one that works without one. */
  | "no_api_key"
  /** No model chosen, so there is nothing to probe *with*. */
  | "no_model";

export type ContractProbeTargetResolution =
  | { readonly kind: "target"; readonly target: ProviderContractProbeTarget }
  | { readonly kind: "skipped"; readonly reason: ContractProbeSkipReason };

export function contractProbeTargetForWizard(
  wizard: ProvidersWizardState,
): ContractProbeTargetResolution {
  const kind = wizard.kind;
  if (!kind) return skip("no_kind");
  // A CLI-backed provider speaks its vendor's own protocol through a
  // subprocess; there is no OpenAI-compatible endpoint here to hold to
  // this contract, and inventing one would probe a URL it never uses.
  if (kind === "claude-cli" || kind === "codex-cli") return skip("cli_backed");

  const endpoint = endpointForKind(kind, wizard);
  // A server on this machine is the operator's own: reachable, free to
  // call, and a probe against it says more about their llama-server
  // flags than about a provider. The key check skips it for the same
  // reason. Checked before the key, because a local server having none
  // is the *reason* it has none.
  if (isLocalProviderUrl(endpoint.baseUrl)) return skip("local_endpoint");

  const apiKey = apiKeyForWizard(wizard)?.trim() ?? "";
  // No key, no probe — including for the presets `wizardKeyIsOptional`
  // lets through. That flag means "this service lists its models
  // without a key", which is true of Nous, Novita, Ollama Cloud,
  // SambaNova and Sarvam and says nothing about completions: they all
  // answer a keyless one with a 401. Probing anyway would spend a
  // request to tell the operator their key "was rejected" when no key
  // was ever sent.
  if (!apiKey) return skip("no_api_key");

  const model = chosenModelForWizard(wizard).trim();
  if (!model) return skip("no_model");

  return {
    kind: "target",
    target: {
      label: providerLabelForWizard(wizard),
      baseUrl: endpoint.baseUrl,
      apiPathPrefix: endpoint.apiPathPrefix,
      apiKey,
      model,
      // What `buildOpenAiChatBody` would put in `parallel_tool_calls`
      // for a provider saved from this wizard. The wizard has no screen
      // for the per-provider `supportsTools` flag, so the executor's cap
      // is the only half of the turn's expression that can differ here
      // (`step-executor`: `maxParallelToolCalls > 1 &&
      // supportsParallelTools`).
      parallelToolCalls: getConfig().agent.maxParallelToolCalls > 1,
      ...(endpoint.extraHeaders ? { extraHeaders: endpoint.extraHeaders } : {}),
    },
  };
}

/** Why nothing was probed, in the operator's words. */
export function describeContractProbeSkip(
  reason: ContractProbeSkipReason,
  label: string,
): string {
  switch (reason) {
    case "cli_backed":
      return `${label} runs through a CLI, not an HTTP endpoint — there is no streaming tool contract to check.`;
    case "local_endpoint":
      return `${label} is a server on this machine — nothing to check against a provider.`;
    case "no_api_key":
      return `${label} has no API key yet, so the contract check has nothing to authenticate with.`;
    case "no_model":
      return `${label} has no chat model set, so there is nothing to run the contract check with.`;
    default:
      return `${label} is not configured far enough to run a contract check.`;
  }
}

function skip(reason: ContractProbeSkipReason): ContractProbeTargetResolution {
  return { kind: "skipped", reason };
}
