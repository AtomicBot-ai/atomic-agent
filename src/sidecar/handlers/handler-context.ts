import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { createAgentEventForwarder } from "../event-forwarder.js";
import type { MessageRouter } from "../message-router.js";
import type { SessionPool } from "../session-pool.js";
import type { StdioProtocol } from "../stdio-protocol.js";

/**
 * Shared dependencies every per-domain handler registrar receives. Keeps
 * `main.ts` a thin assembler: build the runtime + transport once, then hand
 * this context to each `register*Handlers(ctx)` function.
 */
export interface SidecarHandlerContext {
  router: MessageRouter;
  protocol: StdioProtocol;
  runtime: AgentRuntime;
  pool: SessionPool;
  /** Per-session/-turn `AgentLoopEvent` → NDJSON event forwarder factory. */
  forwardEvent: ReturnType<typeof createAgentEventForwarder>;
}
