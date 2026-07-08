import type { AgentBridge } from "../shared/agent-bridge.js";
import type { WindowBridge } from "../shared/window-bridge.js";

export type { AgentBridge, WindowBridge };

export type {
  RequestType,
  EventType,
  SidecarEvent,
  SidecarResponse,
  SidecarError,
  ChatSendPayload,
  ChatSendResult,
  SessionCreateResult,
  SessionSummary,
  ApprovalRequestPayload,
  ApprovalResolvePayload,
  LlmUnavailablePayload,
  AssistantDeltaPayload,
  AssistantReplyPayload,
  TurnFinishedPayload,
  StepStartedPayload,
  StepFinishedPayload,
  PingResult,
} from "@agent/sidecar/index.js";

declare global {
  interface Window {
    agent: AgentBridge;
    windowControls: WindowBridge;
  }
}

export {};
