/**
 * Integrations hub — one place for every third-party credential.
 * See AGENTS.md §"Integrations hub".
 */

export { basicStatus, isConfigured } from "./integration-descriptor.js";
export type {
  IntegrationDescriptor,
  IntegrationField,
  IntegrationProbeResult,
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
export { discordIntegration } from "./discord-integration.js";
export {
  GITHUB_INTEGRATION_ID,
  GITHUB_TEST_ACTION,
  GITHUB_TOKEN_ENV,
  githubIntegration,
} from "./github-integration.js";
export {
  testGithubToken,
  type FetchLike,
  type GithubProbeOutcome,
} from "./github-connection-test.js";
