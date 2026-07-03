import {
  RuntimeApiError,
  deleteSession,
  getSession,
  listSessions,
  resolveApproval,
  toSessionSummary,
  type SessionServiceDeps,
} from "../../runtime-api/index.js";
import type {
  ApprovalResolvePayload,
  ApprovalResolveResult,
  ChatCancelPayload,
  ChatCancelResult,
  ChatSendPayload,
  ChatSendResult,
  SessionCreatePayload,
  SessionCreateResult,
  SessionDeletePayload,
  SessionDeleteResult,
  SessionGetPayload,
  SessionGetResult,
  SessionListPayload,
  SessionListResult,
  SessionOpenPayload,
  SessionOpenResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `session.*`, `chat.*`, and `approval.resolve` — the multi-session core.
 * Every turn funnels through `runtime.turnController.enqueue` so per-session
 * FIFO + cross-session parallelism are inherited from the runtime.
 */
export function registerSessionHandlers(ctx: SidecarHandlerContext): void {
  const { router, protocol, runtime, pool, forwardEvent } = ctx;

  const sessionDeps: SessionServiceDeps = {
    createSession: (input) => runtime.createSession(input ?? {}),
    sessionStore: runtime.sessionStore,
    turnController: runtime.turnController,
  };

  router.register<SessionCreatePayload, SessionCreateResult>(
    "session.create",
    (request) => {
      const state = runtime.createSession(
        request.payload.metadata
          ? { metadata: request.payload.metadata }
          : {},
      );
      pool.register(state);
      const session = toSessionSummary(state, runtime.turnController);
      protocol.emitEvent("session.created", { session });
      return { session };
    },
  );

  router.register<SessionListPayload, SessionListResult>(
    "session.list",
    (request) => ({ sessions: listSessions(sessionDeps, request.payload) }),
  );

  router.register<SessionGetPayload, SessionGetResult>(
    "session.get",
    (request) => {
      const { sessionId } = request.payload;
      const entry = pool.get(sessionId);
      const session = entry?.session ?? runtime.sessionStore.load(sessionId);
      return { session: session ?? null };
    },
  );

  router.register<SessionOpenPayload, SessionOpenResult>(
    "session.open",
    (request) => {
      const state = getSession(sessionDeps, request.payload.sessionId);
      pool.register(state);
      const session = toSessionSummary(state, runtime.turnController);
      protocol.emitEvent("session.opened", { session });
      return { session };
    },
  );

  router.register<SessionDeletePayload, SessionDeleteResult>(
    "session.delete",
    (request) => {
      const { sessionId } = request.payload;
      const result = deleteSession(sessionDeps, sessionId);
      pool.delete(sessionId);
      protocol.emitEvent("session.deleted", { sessionId });
      return result;
    },
  );

  router.register<ChatSendPayload, ChatSendResult>(
    "chat.send",
    async (request) => {
      const { sessionId, text, maxSteps } = request.payload;
      if (!pool.has(sessionId)) {
        throw new RuntimeApiError(
          `session not found: ${sessionId}`,
          "not_found",
        );
      }
      // Fresh controller per send so a completed/cancelled turn never leaks
      // its aborted signal into the next turn on this session.
      const controller = pool.resetController(sessionId);
      const eventHook = forwardEvent(sessionId, request.id);
      const result = await runtime.turnController.enqueue({
        sessionId,
        origin: "sidecar",
        signal: controller.signal,
        eventHook,
        // Re-read the mirrored session inside the queued callback: when a
        // second `chat.send` starts, the first turn already mutated the
        // pooled state, and the queued body must pick up that latest
        // snapshot instead of the value captured at enqueue time.
        run: async () => {
          const current = pool.get(sessionId);
          if (!current) {
            throw new RuntimeApiError(
              `session evicted during chat.send: ${sessionId}`,
              "not_found",
            );
          }
          return runtime.executeTurn(current.session, text, {
            maxSteps: maxSteps ?? runtime.config.agent.maxSteps,
            signal: controller.signal,
          });
        },
      });
      pool.setSession(result.session);
      return {
        reason: result.reason,
        turnCount: result.session.turnCount,
        stepCount: result.session.stepCount,
      };
    },
  );

  router.register<ChatCancelPayload, ChatCancelResult>(
    "chat.cancel",
    (request) => {
      const entry = pool.get(request.payload.sessionId);
      if (!entry) return { cancelled: false };
      entry.controller.abort();
      return { cancelled: true };
    },
  );

  router.register<ApprovalResolvePayload, ApprovalResolveResult>(
    "approval.resolve",
    (request) => {
      const { resolved } = resolveApproval(runtime, request.payload);
      return { resolved };
    },
  );
}
