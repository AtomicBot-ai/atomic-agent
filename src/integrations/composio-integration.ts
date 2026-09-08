/**
 * Composio as an Integrations-hub tenant.
 *
 * One required field — the API key — because that is genuinely the
 * whole setup: everything past it (which apps, which OAuth, which
 * tools) is negotiated inside the session at the moment the operator
 * asks for something. See AGENTS.md §"Composio".
 */

import { COMPOSIO_API_KEY_ENV, COMPOSIO_SERVER_NAME } from "../composio/index.js";
import { isAsciiOnly } from "../llm/provider/openai/ascii-header-guard.js";
import type {
  IntegrationDescriptor,
  IntegrationStatus,
  IntegrationStatusContext,
} from "./integration-descriptor.js";
import { isConfigured } from "./integration-descriptor.js";

const COMPOSIO_KEY_FIELD = "apiKey";

export const composioIntegration: IntegrationDescriptor = {
  id: "composio",
  label: "Composio",
  summary:
    "~1500 SaaS toolkits (Gmail, Slack, Notion, Linear, Jira…) with OAuth handled for you",
  docsUrl: "https://composio.dev",
  appliesLive: true,
  fields: [
    {
      key: COMPOSIO_KEY_FIELD,
      label: "API key",
      envVar: COMPOSIO_API_KEY_ENV,
      secret: true,
      required: true,
      help: "Free tier: 100K tool calls/month. Get one at composio.dev.",
      validate: (raw) => {
        // The key is sent as an x-api-key header, and header values must
        // be ASCII — catching it here names the problem, instead of
        // letting fetch throw something opaque at connect time.
        if (!isAsciiOnly(raw)) {
          return "API key must be ASCII — check for a smart quote or stray character in the paste.";
        }
        return undefined;
      },
    },
  ],
  status(ctx: IntegrationStatusContext): IntegrationStatus {
    const configured = isConfigured(composioIntegration, ctx.presentFields);
    if (!configured) {
      return {
        level: "not_configured",
        detail: "no key — Composio tools are not loaded",
      };
    }
    const state = ctx.mcpServerStates?.get(COMPOSIO_SERVER_NAME);
    if (state === "up") {
      return { level: "connected", detail: "connected" };
    }
    if (state === "down") {
      return {
        level: "error",
        detail: "key saved, but the connection failed — see the MCP tab",
      };
    }
    // Key present and no live signal yet: either the runtime has not
    // reached the server, or it mounts on the next boot.
    return { level: "configured", detail: "key saved" };
  },
};
