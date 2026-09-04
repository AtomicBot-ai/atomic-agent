/**
 * Integrations hub — one place for every third-party credential.
 * See AGENTS.md §"Integrations hub".
 */

export { basicStatus, isConfigured } from "./integration-descriptor.js";
export type {
  IntegrationDescriptor,
  IntegrationField,
  IntegrationStatus,
  IntegrationStatusContext,
  IntegrationStatusLevel,
} from "./integration-descriptor.js";
export {
  IntegrationSecretError,
  displayFieldValue,
  presentFieldKeys,
  readFieldValue,
  writeFieldValue,
} from "./integration-secrets.js";
export { findIntegration, listIntegrations } from "./integration-registry.js";
export { composioIntegration } from "./composio-integration.js";
export { telegramIntegration } from "./telegram-integration.js";
