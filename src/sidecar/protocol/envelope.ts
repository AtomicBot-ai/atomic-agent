/**
 * Transport envelope for the v2 NDJSON sidecar protocol. This file is the
 * single source of truth for the three message kinds and the full set of
 * namespaced request/event names. Payload shapes live in the sibling
 * `*-messages.ts` / `event-payloads.ts` files, split by domain to stay under
 * the 300-line cap.
 *
 * See [SIDECAR.md](../../../SIDECAR.md) for the full protocol contract.
 */

/** Bumped on every breaking protocol change. Returned by `ping`. */
export const PROTOCOL_VERSION = 2;

/**
 * Every namespaced command the host can send. Handlers are registered
 * incrementally per implementation phase; an unregistered (but typed) name
 * resolves with `error.code = "unknown_request"`.
 */
export type RequestType =
  // session + chat + approval + process (phase 2)
  | "session.create"
  | "session.list"
  | "session.get"
  | "session.open"
  | "session.delete"
  | "chat.send"
  | "chat.cancel"
  | "approval.resolve"
  | "ping"
  | "shutdown"
  // task.* (phase 4)
  | "task.create"
  | "task.list"
  | "task.get"
  | "task.cancel"
  | "task.run"
  | "task.drain"
  // memory.* read-only (phase 5)
  | "memory.profile.list"
  | "memory.profile.history"
  | "memory.notes.recall"
  | "memory.notes.list"
  | "memory.notes.get"
  | "memory.lessons.list"
  | "memory.lessons.get"
  | "memory.procedures.list"
  | "memory.procedures.get"
  | "memory.links.list"
  | "memory.links.expand"
  | "memory.votes.list"
  // mcp.* (phase 6)
  | "mcp.list"
  | "mcp.add"
  | "mcp.remove"
  | "mcp.refresh"
  // skill.* (phase 7)
  | "skill.list"
  | "skill.enable"
  | "skill.disable"
  | "skill.install"
  | "skill.uninstall"
  // provider.* + models (phase 8)
  | "provider.list"
  | "provider.setActive"
  | "provider.reload"
  | "provider.remove"
  | "models.status"
  // telegram.* (phase 9)
  | "telegram.get"
  | "telegram.setEnabled"
  | "telegram.restart"
  | "telegram.setToken"
  | "telegram.setOwner"
  | "telegram.pair"
  | "telegram.unpair"
  // config.* (phase 10)
  | "config.get"
  | "config.patch";

/** Every namespaced event the sidecar can emit. */
export type EventType =
  // session lifecycle
  | "session.created"
  | "session.opened"
  | "session.deleted"
  // turn / step (from AgentLoopEvent)
  | "turn.started"
  | "turn.finished"
  | "step.started"
  | "step.finished"
  | "loop.detected"
  | "session.completed"
  | "session.failed"
  // step-level (from nested StepEvent via llm_event)
  | "user.message"
  | "assistant.reply"
  | "assistant.delta"
  | "reasoning.delta"
  | "reasoning"
  | "tool.call_started"
  | "tool.call_result"
  | "tool.autoloaded"
  | "prompt.captured"
  | "parse.retry"
  | "batch.trimmed"
  // cross-cutting
  | "approval.request"
  | "channel.status"
  | "mcp.status"
  | "skill.registry_updated"
  | "task.updated"
  | "llm.unavailable"
  | "log"
  | "metric"
  | "trace"
  | "error"
  | "pong";

/** Machine-readable error attached to a failed response. */
export interface SidecarError {
  message: string;
  /** Canonical category, e.g. `not_found`, `invalid_request`. */
  code?: string;
  /** Field name for validation errors, surfaced to the host UI. */
  field?: string;
}

export interface HostRequest<
  TType extends RequestType = RequestType,
  TPayload = unknown,
> {
  kind: "request";
  /** Host-generated correlation id. */
  id: string;
  type: TType;
  payload: TPayload;
}

export interface SidecarResponse<TPayload = unknown> {
  kind: "response";
  /** Sidecar-generated message id. */
  id: string;
  /** Equals the originating `HostRequest.id`. */
  correlationId: string;
  ok: boolean;
  payload: TPayload;
  error?: SidecarError;
}

export interface SidecarEvent<
  TType extends EventType = EventType,
  TPayload = unknown,
> {
  kind: "event";
  /** Sidecar-generated message id. */
  id: string;
  type: TType;
  /** Set to the originating request id when the event was triggered by one. */
  correlationId?: string;
  /** Carries `sessionId` when the event is session-scoped. */
  payload: TPayload;
}

export type SidecarMessage = HostRequest | SidecarEvent | SidecarResponse;

export function isHostRequest(msg: SidecarMessage): msg is HostRequest {
  return msg.kind === "request";
}

export function isSidecarEvent(msg: SidecarMessage): msg is SidecarEvent {
  return msg.kind === "event";
}

export function isSidecarResponse(
  msg: SidecarMessage,
): msg is SidecarResponse {
  return msg.kind === "response";
}
