export { ApprovalBus } from "./approval-bus.js";
export type { ApprovalListener } from "./approval-bus.js";

export { CompletionRegistry } from "./completion-registry.js";
export type { CompletionEntry } from "./completion-registry.js";

export {
  MAX_PARKED_STEERS,
  UndeliveredSteerStore,
} from "./undelivered-steers.js";
export type { UndeliveredSteer } from "./undelivered-steers.js";

export { createHttpServer } from "./http-server.js";
export type {
  HttpServerHandle,
  HttpServerOptions,
  RouteDefinition,
} from "./http-server.js";

export { buildRouteTable } from "./route-table.js";
export {
  HTTP_ROLES,
  HTTP_SCOPES,
  ROLE_SCOPES,
  ROUTE_SCOPES,
  isHttpRole,
  roleHasScope,
  scopeForRoute,
} from "./http-scopes.js";
export type { HttpRole, HttpScope } from "./http-scopes.js";
export {
  addHttpToken,
  createHttpTokenSource,
  httpTokensPath,
  readHttpTokens,
  removeHttpToken,
} from "./http-token-store.js";
export type { StoredHttpToken } from "./http-token-store.js";
export { buildTunnelRouteTable } from "./tunnel-route-table.js";
export {
  getWebhookTunnelStatus,
  resetWebhookTunnelStatus,
  setWebhookTunnelStatus,
} from "./webhook-tunnel-status.js";
export type { WebhookTunnelStatus } from "./webhook-tunnel-status.js";
export type { RouteTableOptions } from "./route-table.js";
// ATO-2336: the shared local model (`/raw/v1`) and its key.
export { isModelShareEnabled, RAW_MODEL_PREFIX } from "./route-raw-model.js";
export { ensureModelShareKey, modelShareKeyPath, readModelShareKey, rotateModelShareKey } from "./model-share-key.js";

export { createTelegramPairingHandlers } from "./route-telegram-pairing.js";
export type {
  PairingStatus,
  TelegramPairingHandlers,
} from "./route-telegram-pairing.js";

export { openaiError } from "./openai-errors.js";
export type { OpenAiErrorPayload } from "./openai-errors.js";

export { deriveChatSessionId } from "./openai-session-id.js";

export {
  SESSION_ID_HEADER,
  COMPLETION_ID_HEADER,
  EXTENSIONS_HEADER,
  SCREEN_OVERLAY_HEADER,
  QUESTIONS_HEADER,
  createChatCompletionsHandler,
} from "./openai-chat-completions.js";

export { createCancelCompletionHandler } from "./openai-completions-cancel.js";

export type {
  HandlerContext,
  HttpHandler,
  SseWriter,
} from "./request-context.js";
