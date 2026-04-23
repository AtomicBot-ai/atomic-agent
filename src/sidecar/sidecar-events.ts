/**
 * Typed schema for the NDJSON protocol between the Tauri host and the sidecar.
 * This file is the single source of truth; it is exported through the package
 * root so a Tauri UI written in TypeScript can import the same types.
 */

export type HostRequestType =
  | "start_session"
  | "run_step"
  | "send_message"
  | "cancel"
  | "approval_response"
  | "get_session"
  | "skill_install"
  | "skill_uninstall"
  | "skill_list"
  | "shutdown"
  | "ping";

export type SidecarEventType =
  | "session_started"
  | "step_started"
  | "step_finished"
  | "tool_call_started"
  | "tool_call_result"
  | "user_message"
  | "assistant_reply"
  | "assistant_delta"
  | "reasoning_delta"
  | "turn_started"
  | "turn_finished"
  | "approval_request"
  | "llm_request"
  | "llm_response"
  | "llm_unavailable"
  | "session_completed"
  | "session_failed"
  | "skill_registry_updated"
  | "log"
  | "metric"
  | "trace"
  | "pong"
  | "error";

export interface HostRequest<
  TType extends HostRequestType = HostRequestType,
  TPayload = unknown,
> {
  kind: "request";
  id: string;
  type: TType;
  payload: TPayload;
}

export interface SidecarEvent<
  TType extends SidecarEventType = SidecarEventType,
  TPayload = unknown,
> {
  kind: "event";
  id: string;
  type: TType;
  correlationId?: string;
  payload: TPayload;
}

export interface SidecarResponse<TPayload = unknown> {
  kind: "response";
  id: string;
  correlationId: string;
  ok: boolean;
  payload: TPayload;
  error?: { message: string; code?: string };
}

export type SidecarMessage = HostRequest | SidecarEvent | SidecarResponse;

export interface StartSessionPayload {
  workingDir: string;
  metadata?: Record<string, unknown>;
}

export interface RunStepPayload {
  sessionId: string;
}

export interface SendMessagePayload {
  sessionId: string;
  text: string;
  maxSteps?: number;
}

export interface CancelPayload {
  sessionId: string;
}

export interface ApprovalResponsePayload {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

export interface GetSessionPayload {
  sessionId: string;
}

export interface SkillInstallPayload {
  sourcePath: string;
  force?: boolean;
}

export interface SkillUninstallPayload {
  name: string;
}

export interface ApprovalRequestPayload {
  approvalId: string;
  sessionId: string;
  tool: string;
  reason: string;
  /** Human-readable preview of the action (diff snippet, command, URL, etc.). */
  preview?: string;
  affectedResources?: string[];
}

export interface ToolCallStartedPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  args: unknown;
}

export interface ToolCallResultPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  status: "ok" | "error";
  summary: string;
  truncated?: boolean;
}

export interface StepStartedPayload {
  sessionId: string;
  stepIndex: number;
}

export interface StepFinishedPayload {
  sessionId: string;
  stepIndex: number;
  tokensUsed: number;
  durationMs: number;
}

export interface UserMessagePayload {
  sessionId: string;
  text: string;
}

export interface AssistantReplyPayload {
  sessionId: string;
  text: string;
}

/**
 * Incremental slice of the assistant's reply, emitted as `reply.args.text`
 * is streamed out of llama-server. Multiple `assistant_delta` events are
 * followed by a single terminal `assistant_reply` with the full text.
 * Consumers that render deltas live should ignore the final reply body or
 * diff against their accumulated buffer.
 */
export interface AssistantDeltaPayload {
  sessionId: string;
  text: string;
}

/**
 * Incremental `<think>` reasoning chunk. Only present when the model emits
 * a reasoning prelude. `stepIndex` ties the chunk back to the step event
 * stream; multiple deltas may share the same index.
 */
export interface ReasoningDeltaPayload {
  sessionId: string;
  stepIndex: number;
  text: string;
}

export interface TurnStartedPayload {
  sessionId: string;
  turnIndex: number;
}

export interface TurnFinishedPayload {
  sessionId: string;
  turnIndex: number;
  reason: "reply" | "finish" | "max_steps" | "cancelled" | "failed";
  stepCount: number;
  durationMs: number;
}

export interface LlmRequestPayload {
  sessionId: string;
  slotId: number;
  promptTokens: number;
  cacheReused: boolean;
}

export interface LlmResponsePayload {
  sessionId: string;
  completionTokens: number;
  durationMs: number;
}

export interface SkillRegistryUpdatedPayload {
  installed: Array<{ name: string; source: "global" | "project" }>;
}

export interface LogPayload {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export interface MetricPayload {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

export interface ErrorPayload {
  message: string;
  code?: string;
  stack?: string;
}

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
