/**
 * Request/response payload shapes for the `session.*`, `chat.*`,
 * `approval.*`, and process (`ping` / `shutdown`) commands. See SIDECAR.md
 * §4.1–4.3 and §4.11.
 */
import type { AgentLoopReason } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/index.js";
import type { SessionSummary } from "../../runtime-api/index.js";

export type { SessionSummary } from "../../runtime-api/index.js";

// session.*

export interface SessionCreatePayload {
  workingDir?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionCreateResult {
  session: SessionSummary;
}

export interface SessionListPayload {
  limit?: number;
  workingDir?: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface SessionGetPayload {
  sessionId: string;
}

export interface SessionGetResult {
  session: SessionState | null;
}

export interface SessionOpenPayload {
  sessionId: string;
}

export interface SessionOpenResult {
  session: SessionSummary;
}

export interface SessionDeletePayload {
  sessionId: string;
}

export interface SessionDeleteResult {
  deleted: boolean;
}

// chat.*

export interface ChatSendPayload {
  sessionId: string;
  text: string;
  maxSteps?: number;
}

export interface ChatSendResult {
  reason: AgentLoopReason;
  turnCount: number;
  stepCount: number;
}

export interface ChatCancelPayload {
  sessionId: string;
}

export interface ChatCancelResult {
  cancelled: boolean;
}

// approval.*

export interface ApprovalResolvePayload {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

export interface ApprovalResolveResult {
  resolved: boolean;
}

// process

export interface PingResult {
  ok: true;
  llamaUrl: string;
  stateDir: string;
  version: string;
  protocolVersion: number;
}

export interface ShutdownResult {
  ok: true;
}
