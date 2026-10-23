/**
 * Exa web search as an Integrations-hub tenant (ATO-345).
 *
 * Web search runs on keyless Exa by default; when its free limit runs
 * out, the search error asks for a free Exa key. The desktop app has a
 * key card for that. This descriptor is the terminal's equivalent: one
 * secret field stored as `EXA_API_KEY` in `<stateDir>/.env` through the
 * hub's usual writer, which also sets it in the live process
 * environment. The Exa provider reads the variable on every search, so
 * the key applies to the next search without a restart.
 *
 * The variable name is the default of `web.search.exa.apiKeyEnv`. An
 * operator who renamed it in config keeps setting their own variable.
 */

import { EXA_GET_KEY_URL } from "../tools/os/web-search/web-search-errors.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

export const EXA_INTEGRATION_ID = "exa";
export const EXA_KEY_FIELD = "apiKey";
/** Default of `web.search.exa.apiKeyEnv`. */
export const EXA_API_KEY_ENV = "EXA_API_KEY";

export const exaIntegration: IntegrationDescriptor = {
  id: EXA_INTEGRATION_ID,
  label: "Web search (Exa)",
  summary:
    "Your own Exa key for web search, so searches keep working after the free keyless limit",
  docsUrl: EXA_GET_KEY_URL,
  appliesLive: true,
  setupSteps: [
    `Open ${EXA_GET_KEY_URL}, sign in and create a free API key.`,
    "Press e on API key below, paste it, press enter. The next search uses it.",
  ],
  fields: [
    {
      key: EXA_KEY_FIELD,
      label: "API key",
      envVar: EXA_API_KEY_ENV,
      secret: true,
      required: true,
      help: "Optional: without a key, web search uses Exa's keyless free tier.",
      validate: (raw) =>
        /^[\x21-\x7e]+$/.test(raw)
          ? undefined
          : "API key must be one word of plain ASCII characters. Check the paste for spaces or a stray character.",
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    if (!isConfigured(exaIntegration, ctx.presentFields)) {
      return { level: "not_configured", detail: "no key, using the keyless free tier" };
    }
    return { level: "configured", detail: "key saved, used by the next search" };
  },
};
