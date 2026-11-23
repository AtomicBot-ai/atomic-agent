/**
 * Wire types of the atomic-agent NDJSON sidecar protocol.
 *
 * MIRRORED, not imported: the source of truth is
 * `src/sidecar/sidecar-events.ts` (and the payloads `src/sidecar/main.ts`
 * actually emits). This package is meant to be installable on its own, so
 * it cannot reach into the agent's `src/` tree. `protocol-compat.test.ts`
 * fails when the request/event name lists drift from the source file;
 * update this file in the same change as the sidecar.
 *
 * Fields are copied as the sidecar sends them. A few types the agent
 * keeps elsewhere (approval category, risk level) are widened to `string`
 * here so a newer agent with a new value does not break older SDK users.
 */

export const HOST_REQUEST_TYPES = [
  "start_session",
  "run_step",
  "send_message",
  "steer_message",
  "cancel",
  "approval_response",
  "get_session",
  "compact_session",
  "get_compaction",
  "skill_install",
  "skill_uninstall",
  "skill_list",
  "shutdown",
  "ping",
] as const;

export type HostRequestType = (typeof HOST_REQUEST_TYPES)[number];

export const SIDECAR_EVENT_TYPES = [
  "compaction_started",
  "compaction_progress",
  "compaction_completed",
  "compaction_failed",
  "session_started",
  "step_started",
  "step_finished",
  "tool_call_started",
  "tool_call_result",
  "user_message",
  "steer_applied",
  "steer_undelivered",
  "assistant_reply",
  "assistant_delta",
  "reasoning_delta",
  "plan_updated",
  "turn_started",
  "turn_finished",
  "approval_request",
  "llm_request",
  "llm_response",
  "llm_unavailable",
  "session_completed",
  "session_failed",
  "skill_registry_updated",
  "log",
  "metric",
  "trace",
  "pong",
  "error",
] as const;

export type SidecarEventType = (typeof SIDECAR_EVENT_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Request payloads                                                    */
/* ------------------------------------------------------------------ */

export interface StartSessionPayload {
  workingDir: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessagePayload {
  sessionId: string;
  text: string;
  maxSteps?: number;
}

export interface SteerMessagePayload {
  sessionId: string;
  text: string;
}

export interface CancelPayload {
  sessionId: string;
}

export interface ApprovalResponsePayload {
  approvalId: string;
  approved: boolean;
  reason?: string;
  grant?: "session" | "shape" | "always";
  grantHost?: string;
  answer?: { selected?: Array<string | number>; other?: string };
}

export interface GetSessionPayload {
  sessionId: string;
}

export interface CompactSessionPayload {
  sessionId: string;
  instructions?: string;
}

/* ------------------------------------------------------------------ */
/* Response payloads (what the router returns per request)             */
/* ------------------------------------------------------------------ */

export interface PingResult {
  ok: boolean;
  llamaUrl: string;
  stateDir: string;
  version: string;
}

export interface StartSessionResult {
  sessionId: string;
}

export interface SendMessageResult {
  /** Why the turn ended: `reply`, `finish`, `max_steps`, `cancelled`, `failed`. */
  reason: string;
  turnCount: number;
  stepCount: number;
}

/* ------------------------------------------------------------------ */
/* Event payloads                                                      */
/* ------------------------------------------------------------------ */

export interface SessionStartedPayload {
  sessionId: string;
  workingDir: string;
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

export interface ToolCallStartedPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  args: unknown;
  batchIndex?: number;
  batchSize?: number;
}

export interface ToolCallResultPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  status: "ok" | "error";
  summary: string;
  batchIndex?: number;
  batchSize?: number;
  truncated?: boolean;
  canvas?: {
    path: string;
    title: string;
    kind: "html" | "chart";
    chart?: "bar" | "line" | "area" | "pie" | "table";
    bytes: number;
  };
  approvals?: unknown[];
}

export interface UserMessagePayload {
  sessionId: string;
  text: string;
}

export interface SteerAppliedPayload {
  sessionId: string;
  text: string;
  stepIndex: number;
}

export interface SteerUndeliveredPayload {
  sessionId: string;
  text: string;
}

export interface AssistantReplyPayload {
  sessionId: string;
  text: string;
  attachments?: readonly string[];
  /** Interim message; another `assistant_reply` follows in the same turn. */
  progressNote?: true;
}

export interface AssistantDeltaPayload {
  sessionId: string;
  text: string;
}

export interface ReasoningDeltaPayload {
  sessionId: string;
  stepIndex: number;
  text: string;
}

export interface PlanUpdatedPayload {
  sessionId: string;
  stepIndex: number;
  plan: unknown;
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

export interface UserQuestion {
  prompt: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
}

export interface ApprovalRequestPayload {
  approvalId: string;
  sessionId: string;
  tool: string;
  category?: string;
  reason: string;
  preview?: string;
  affectedResources?: string[];
  commandShape?: string;
  riskNote?: string;
  riskLevel?: string;
  riskReason?: string;
  canSession?: boolean;
  grantHost?: string;
  canShape?: boolean;
  canAlways?: boolean;
  alwaysLabel?: string;
  question?: UserQuestion;
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

export interface LlmUnavailablePayload {
  url: string;
  error: string | null;
  mode: "external" | "managed";
  hint: string;
}

export interface SessionCompletedPayload {
  sessionId: string;
  reason: "finish" | "max_steps";
}

export interface SessionFailedPayload {
  sessionId: string;
  error: string;
  category?: string;
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

/** Compaction lifecycle events carry the agent's own event object as-is. */
export interface CompactionPayload {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** Payload type for each event name. */
export interface SidecarEventPayloads {
  compaction_started: CompactionPayload;
  compaction_progress: CompactionPayload;
  compaction_completed: CompactionPayload;
  compaction_failed: CompactionPayload;
  session_started: SessionStartedPayload;
  step_started: StepStartedPayload;
  step_finished: StepFinishedPayload;
  tool_call_started: ToolCallStartedPayload;
  tool_call_result: ToolCallResultPayload;
  user_message: UserMessagePayload;
  steer_applied: SteerAppliedPayload;
  steer_undelivered: SteerUndeliveredPayload;
  assistant_reply: AssistantReplyPayload;
  assistant_delta: AssistantDeltaPayload;
  reasoning_delta: ReasoningDeltaPayload;
  plan_updated: PlanUpdatedPayload;
  turn_started: TurnStartedPayload;
  turn_finished: TurnFinishedPayload;
  approval_request: ApprovalRequestPayload;
  llm_request: LlmRequestPayload;
  llm_response: LlmResponsePayload;
  llm_unavailable: LlmUnavailablePayload;
  session_completed: SessionCompletedPayload;
  session_failed: SessionFailedPayload;
  skill_registry_updated: SkillRegistryUpdatedPayload;
  log: LogPayload;
  metric: MetricPayload;
  trace: Record<string, unknown>;
  pong: Record<string, unknown>;
  error: ErrorPayload;
}

/**
 * Any event the sidecar can send, discriminated on `type`:
 * `if (event.type === "assistant_delta") event.payload.text`.
 */
export type AgentEvent = {
  [K in SidecarEventType]: SidecarEvent<K, SidecarEventPayloads[K]>;
}[SidecarEventType];
