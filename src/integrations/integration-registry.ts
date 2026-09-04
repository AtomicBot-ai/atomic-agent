/**
 * The list of integrations the hub renders.
 *
 * A plain function rather than a module-level singleton, per
 * AGENTS.md §"Layout rules" ("no global singletons — `getConfig()` is
 * the only exception"). Adding an integration is one line here plus a
 * descriptor file.
 */

import { composioIntegration } from "./composio-integration.js";
import { telegramIntegration } from "./telegram-integration.js";
import type { IntegrationDescriptor } from "./integration-descriptor.js";

/** Every known integration, in display order. */
export function listIntegrations(): readonly IntegrationDescriptor[] {
  return [composioIntegration, telegramIntegration];
}

/** Look one up by id. `undefined` when nothing matches. */
export function findIntegration(
  id: string,
): IntegrationDescriptor | undefined {
  return listIntegrations().find((i) => i.id === id);
}
