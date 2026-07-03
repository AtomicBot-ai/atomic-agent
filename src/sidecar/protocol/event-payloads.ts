/**
 * Payload shapes for every `SidecarEvent`. See SIDECAR.md §5. Session-scoped
 * events carry `sessionId`; turn/step/tool/assistant/reasoning events also
 * carry the `correlationId` of the originating `chat.send` (on the envelope).
 */
import type { AgentLoopReason } from "../../agent/agent-loop.js";
import type { ChannelState } from "../../runtime/channel-status.js";
import type { SessionSummary } from "../../runtime-api/index.js";
import type { PromptCapturedTokens } from "../../agent/step-events.js";
import type { TaskRecord } from "../../tasks/index.js";
import type { McpServerStatus } from "../../mcp/index.js";

// session lifecycle

export interface SessionCreatedPayload {
  session: SessionSummary;
}

export interface SessionOpenedPayload {
  session: SessionSummary;
}

export interface SessionDeletedPayload {
  sessionId: string;
}

// turn / step

export interface TurnStartedPayload {
  sessionId: string;
  turnIndex: number;
}

export interface TurnFinishedPayload {
  sessionId: string;
  turnIndex: number;
  reason: AgentLoopReason;
  stepCount: number;
  durationMs: number;
}

export interface StepStartedPayload {
  sessionId: string;
  stepIndex: number;
}

export interface StepFinishedPayload {
  sessionId: string;
  stepIndex: number;
  summary: string;
  durationMs: number;
}

export interface LoopDetectedPayload {
  sessionId: string;
  tool: string;
  count: number;
  stepIndex: number;
  level?: "warn" | "critical" | "breaker";
  detector?: "generic_repeat" | "no_progress" | "wandering";
}

export interface SessionCompletedPayload {
  sessionId: string;
  reason: AgentLoopReason;
}

export interface SessionFailedPayload {
  sessionId: string;
  error: string;
  category: string;
}

// step-level (nested StepEvent)

export interface UserMessagePayload {
  sessionId: string;
  text: string;
}

export interface AssistantReplyPayload {
  sessionId: string;
  text: string;
}

/**
 * Incremental slice of the assistant's reply, streamed as `reply.args.text`
 * is generated. Multiple `assistant.delta` events are followed by a single
 * terminal `assistant.reply` with the full text.
 */
export interface AssistantDeltaPayload {
  sessionId: string;
  text: string;
}

/** Incremental `<think>` reasoning chunk, streamed live. */
export interface ReasoningDeltaPayload {
  sessionId: string;
  stepIndex: number;
  text: string;
}

/** Full reasoning block, emitted once after the JSON body is parsed. */
export interface ReasoningPayload {
  sessionId: string;
  stepIndex: number;
  text: string;
}

export interface ToolCallStartedPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  args: unknown;
  /** Position inside the parent step's batch (multi-call steps only). */
  batchIndex?: number;
  batchSize?: number;
}

export interface ToolCallResultPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  status: "ok" | "error";
  summary: string;
  truncated?: boolean;
  /** Mirrors the matching `ToolCallStartedPayload.batchIndex`. */
  batchIndex?: number;
  batchSize?: number;
}

/** Rare tool auto-loaded into the session after an invalid-args failure. */
export interface ToolAutoloadedPayload {
  sessionId: string;
  tool: string;
  source: "auto";
  stepIndex: number;
}

export interface PromptCapturedPayload {
  sessionId: string;
  stepIndex: number;
  stablePrefixHash: string;
  tokens: PromptCapturedTokens;
  slotId: number;
  cacheReused: boolean;
}

export interface ParseRetryPayload {
  sessionId: string;
  stepIndex: number;
  attempt: number;
  reason: string;
}

export interface BatchTrimmedPayload {
  sessionId: string;
  stepIndex: number;
  originalSize: number;
  kept: string;
  dropped: string[];
  reason: "approval-gated-batched";
}

// cross-cutting

export interface ApprovalRequestPayload {
  approvalId: string;
  sessionId: string;
  tool: string;
  reason: string;
  /** Human-readable preview of the action (diff, command, URL, ...). */
  preview?: string;
  affectedResources?: string[];
}

export interface ChannelStatusPayload {
  channel: string;
  state: ChannelState;
  lastError?: string;
}

export interface SkillRegistryUpdatedPayload {
  installed: Array<{ name: string; source: "global" | "project" }>;
}

/** Best-effort notification that a task lifecycle transition occurred. */
export interface TaskUpdatedPayload {
  task: TaskRecord;
}

/** Snapshot of every configured MCP server's live status. */
export interface McpStatusPayload {
  servers: McpServerStatus[];
}

/** Emitted when llama-server is unreachable. */
export interface LlmUnavailablePayload {
  url: string;
  error: string | null;
  mode: "external" | "managed";
  hint: string;
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
