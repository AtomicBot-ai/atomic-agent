import type { HostRequest, HostRequestType } from "./sidecar-events.js";
import type { StdioProtocol } from "./stdio-protocol.js";

export type RouteHandler<TPayload = unknown, TResult = unknown> = (
  request: HostRequest<HostRequestType, TPayload>,
) => Promise<TResult> | TResult;

/**
 * Dispatches incoming host requests to registered async handlers and
 * automatically writes a response (or error response) back through the
 * protocol. Every handler is wrapped in a try/catch so a single failing
 * route cannot crash the sidecar.
 */
export class MessageRouter {
  private readonly handlers = new Map<HostRequestType, RouteHandler>();

  constructor(private readonly protocol: StdioProtocol) {
    protocol.onRequest((request) => {
      void this.dispatch(request);
    });
  }

  register<TPayload, TResult>(
    type: HostRequestType,
    handler: RouteHandler<TPayload, TResult>,
  ): void {
    this.handlers.set(type, handler as RouteHandler);
  }

  private async dispatch(request: HostRequest): Promise<void> {
    const handler = this.handlers.get(request.type);
    if (!handler) {
      this.protocol.respond(
        request.id,
        {},
        false,
        { message: `no handler for request type: ${request.type}`, code: "unknown_request" },
      );
      return;
    }
    try {
      const result = await handler(request);
      this.protocol.respond(request.id, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.protocol.respond(
        request.id,
        {},
        false,
        { message: error.message, code: "handler_failed" },
      );
      this.protocol.emitEvent("error", {
        message: error.message,
        code: "handler_failed",
        stack: error.stack,
      });
    }
  }
}
