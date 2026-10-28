/**
 * Exa web search as an Integrations-hub tenant (ATO-345).
 *
 * `os.web.search` runs on Exa's free keyless tier until it runs out, and
 * then asks for a key (ATO-327). The desktop app has a key card for that;
 * in the terminal the only way was to edit `<stateDir>/.env` by hand and
 * restart. This row is the terminal's key card: one secret field stored
 * as `EXA_API_KEY`, the name `web.search.exa.apiKeyEnv` defaults to.
 *
 * Applies live: the hub writes the key into `process.env` as well as
 * `.env`, the Exa provider reads it on every call, and a free-tier park
 * is dropped once a key is present, so the next search uses it.
 *
 * Like the desktop card, this always writes `EXA_API_KEY`. When web search
 * reads another variable, or does not ask Exa at all, the status and the
 * save message say the key will not be used.
 */

import { isAsciiOnly } from "../llm/provider/openai/ascii-header-guard.js";
import {
  DEFAULT_EXA_KEY_ENV,
  EXA_GET_KEY_URL,
} from "../tools/os/web-search/web-search-errors.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";
import { readConfigPath } from "./integration-secrets.js";

export const EXA_INTEGRATION_ID = "exa";
export const EXA_KEY_FIELD = "apiKey";
/** The default of `web.search.exa.apiKeyEnv`, and what this row writes. */
export const EXA_API_KEY_ENV = DEFAULT_EXA_KEY_ENV;

/** What web search is set to, as far as an Exa key is concerned. */
export interface ExaSearchSetup {
  /** `web.search.exa.apiKeyEnv`: the variable the Exa provider reads. */
  apiKeyEnv: string;
  /** `web.search.provider`. */
  provider: string;
  /** Exa is the provider or one of `web.search.fallback`. */
  inChain: boolean;
}

/**
 * Read the settings that decide whether a saved key is used. Missing or
 * odd values read as the shipped default (Exa primary, `EXA_API_KEY`), so
 * a partial config never produces a false warning.
 */
export function readExaSearchSetup(
  config: Readonly<Record<string, unknown>> | undefined,
): ExaSearchSetup {
  const search = readConfigPath(config, "web.search") as
    | { provider?: unknown; fallback?: unknown; exa?: { apiKeyEnv?: unknown } }
    | undefined;
  const provider =
    typeof search?.provider === "string" ? search.provider : "exa";
  const fallback = Array.isArray(search?.fallback) ? search.fallback : [];
  const apiKeyEnv =
    typeof search?.exa?.apiKeyEnv === "string"
      ? search.exa.apiKeyEnv
      : EXA_API_KEY_ENV;
  return {
    apiKeyEnv,
    provider,
    inChain: provider === "exa" || fallback.includes("exa"),
  };
}

/** Why a saved key would not be used, or `undefined` when it will be. */
export function exaKeyUnusedReason(setup: ExaSearchSetup): string | undefined {
  if (setup.apiKeyEnv !== EXA_API_KEY_ENV) {
    return `web search reads ${setup.apiKeyEnv} (web.search.exa.apiKeyEnv), not ${EXA_API_KEY_ENV}`;
  }
  if (!setup.inChain) {
    return `web search is set to ${setup.provider}; Exa is used only when it is web.search.provider or in web.search.fallback`;
  }
  return undefined;
}

export const exaIntegration: IntegrationDescriptor = {
  id: EXA_INTEGRATION_ID,
  label: "Web search (Exa)",
  summary:
    "Your own Exa key, so web search keeps working after the free searches run out",
  docsUrl: EXA_GET_KEY_URL,
  appliesLive: true,
  setupSteps: [
    "Open dashboard.exa.ai/api-keys and sign in. The free plan is enough.",
    "Create an API key and copy it.",
    "Press e on API key below, paste it, press enter.",
    "The next web search uses it. No restart needed.",
  ],
  fields: [
    {
      key: EXA_KEY_FIELD,
      label: "API key",
      envVar: EXA_API_KEY_ENV,
      secret: true,
      required: true,
      help: "Stored as EXA_API_KEY in the agent's .env. Without it, search uses Exa's free tier, which runs out fast.",
      validate: (raw) => {
        // Sent as an x-api-key header: a space or a smart quote from the
        // paste would only fail later, as an opaque search error.
        if (/\s/.test(raw)) {
          return "An Exa key has no spaces. Copy the key itself.";
        }
        if (!isAsciiOnly(raw)) {
          return "API key must be ASCII. Check for a smart quote or stray character in the paste.";
        }
        return undefined;
      },
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    const setup = readExaSearchSetup(ctx.config);
    if (!isConfigured(exaIntegration, ctx.presentFields)) {
      return {
        level: "not_configured",
        detail: setup.inChain
          ? "no key, using Exa's free searches"
          : `no key; web search is set to ${setup.provider}, not Exa`,
      };
    }
    // Saved but not what web search will use: say so, rather than a
    // badge that reads as working.
    const unused = exaKeyUnusedReason(setup);
    if (unused !== undefined) {
      return { level: "configured", detail: `key saved, but ${unused}` };
    }
    // No live check: a key is only tried by the next search.
    return { level: "configured", detail: "key saved, used by web search" };
  },
};
