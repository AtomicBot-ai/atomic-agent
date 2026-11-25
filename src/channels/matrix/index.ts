/**
 * Matrix remote-control channel (ATO-632). See ../docs/adapters.md.
 * Unencrypted rooms only for now; encrypted rooms get a notice.
 */

import type { ChannelDefinition } from "../channel.js";
import { MatrixChannel } from "./matrix-channel.js";

export const MATRIX_CHANNEL: ChannelDefinition = {
  id: "matrix",
  label: "Matrix",
  create: (ctx) =>
    new MatrixChannel({
      runtime: ctx.runtime,
      logger: ctx.logger,
      approvals: ctx.approvals,
      approvalRouter: ctx.approvalRouter,
      channelConfig: ctx.channelConfig,
      stateDir: ctx.stateDir,
      emitStatus: ctx.emitStatus,
    }),
};

export { MatrixChannel } from "./matrix-channel.js";
export type { MatrixChannelDeps } from "./matrix-channel.js";
export { MatrixApi, MatrixApiError, MATRIX_SYNC_FILTER } from "./matrix-api.js";
export type { MatrixEvent, MatrixSyncResponse } from "./matrix-api.js";
export { MatrixApprovalBridge, formatMatrixPrompt } from "./matrix-approval-bridge.js";
export { handleMatrixEvent } from "./matrix-inbound-handler.js";
export type { MatrixInboundContext } from "./matrix-inbound-handler.js";
export { MatrixSyncLoop } from "./matrix-sync-loop.js";
export { MatrixSyncStore } from "./matrix-sync-store.js";
export { formatMatrixMessage, markdownToMatrixHtml } from "./matrix-format.js";
export {
  ENCRYPTED_ROOM_NOTICE,
  MATRIX_ACCESS_TOKEN_KEY,
  MATRIX_MESSAGE_LIMIT,
  readMatrixOptions,
  resolveMatrixToken,
  scrubMatrixError,
} from "./matrix-types.js";
