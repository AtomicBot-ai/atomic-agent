import { RuntimeApiError } from "../runtime-api/index.js";
import type { HostRequest, RequestType, SidecarError } from "./protocol/index.js";
import type { StdioProtocol } from "./stdio-protocol.js";

export type RouteHandler<TPayload = unknown, TResult = unknown> = (
  request: HostRequest<RequestType, TPayload>,
) => Promise<TResult> | TResult;

/**
 * Dispatches incoming host requests to registered async handlers and
 * automatically writes a response (or error response) back through the
 * protocol. Every handler is wrapped in a try/catch so a single failing
 * route cannot crash the sidecar. Thrown `RuntimeApiError`s (from the
 * shared runtime-facade) are mapped to their canonical `code` + `field`;
 * anything else surfaces as `handler_failed`.
 */
export class MessageRouter {
  private readonly handlers = new Map<RequestType, RouteHandler>();

  constructor(private readonly protocol: StdioProtocol) {
    protocol.onRequest((request) => {
      void this.dispatch(request);
    });
  }

  register<TPayload, TResult>(
    type: RequestType,
    handler: RouteHandler<TPayload, TResult>,
  ): void {
    this.handlers.set(type, handler as RouteHandler);
  }

  private async dispatch(request: HostRequest): Promise<void> {
    const handler = this.handlers.get(request.type);
    if (!handler) {
      this.protocol.respond(request.id, {}, false, {
        message: `no handler for request type: ${request.type}`,
        code: "unknown_request",
      });
      return;
    }
    try {
      const result = await handler(request);
      this.protocol.respond(request.id, result);
    } catch (err) {
      const sidecarError = toSidecarError(err);
      this.protocol.respond(request.id, {}, false, sidecarError);
      this.protocol.emitEvent("error", {
        message: sidecarError.message,
        code: sidecarError.code,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}

function toSidecarError(err: unknown): SidecarError {
  if (err instanceof RuntimeApiError) {
    return {
      message: err.message,
      code: err.code,
      ...(err.field !== undefined ? { field: err.field } : {}),
    };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  return { message: error.message, code: "handler_failed" };
}
