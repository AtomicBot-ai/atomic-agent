/**
 * Composio integration — hosted access to 1500+ SaaS toolkits, mounted
 * through the existing MCP client. See `README.md` §"Composio".
 */

export {
  COMPOSIO_API_BASE,
  COMPOSIO_API_KEY_HEADER,
  ComposioApiError,
  composioRequest,
  createComposioSession,
  parseSessionResponse,
} from "./composio-api.js";
export type {
  ComposioRequestOptions,
  ComposioSession,
  CreateSessionOptions,
} from "./composio-api.js";
export {
  listComposioConnectedAccounts,
  parseConnectedAccountsPage,
} from "./composio-accounts-api.js";
export type {
  ComposioConnectedAccount,
  ListConnectedAccountsOptions,
} from "./composio-accounts-api.js";
export {
  ComposioAccountError,
  addComposioAccount,
  composioSessionPins,
  composioSessionStamp,
  findComposioAccount,
  removeComposioAccount,
  setDefaultComposioAccount,
} from "./composio-accounts.js";
export type { AddComposioAccountInput } from "./composio-accounts.js";
export {
  COMPOSIO_SERVER_NAME,
  buildComposioServerConfig,
} from "./build-composio-server-config.js";
export type { BuildComposioServerConfigOptions } from "./build-composio-server-config.js";
export {
  COMPOSIO_API_KEY_ENV,
  resolveComposioApiKey,
} from "./resolve-composio-key.js";
export type { ResolveComposioKeyOptions } from "./resolve-composio-key.js";
export { ensureComposioSession } from "./ensure-composio-session.js";
export type {
  ComposioSessionCache,
  EnsuredComposioSession,
  EnsureComposioSessionOptions,
} from "./ensure-composio-session.js";
export {
  persistComposioSession,
  persistComposioAccounts,
  clearComposioSession,
} from "./persist-composio-session.js";
export type { ComposioSessionRecord } from "./persist-composio-session.js";
export { resolveComposioServerConfig } from "./resolve-composio-server.js";
export type {
  ComposioResolveLogger,
  ResolveComposioServerOptions,
} from "./resolve-composio-server.js";
