export type TurnPhase = "idle" | "running";

/**
 * Terminal verbs the runtime models as "tools" but which are not real tool
 * activity — `reply` closes a turn, `finish` closes the session. They are
 * never rendered as tool steps in the transcript.
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply", "finish"]);

export function isHiddenTool(tool: string): boolean {
  return HIDDEN_TOOL_NAMES.has(tool);
}

export interface ToolStep {
  tool: string;
  args?: unknown;
  status: "running" | "ok" | "error";
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Content of `<think>` reasoning blocks, if any. */
  reasoning?: string;
  /** Tool activity that preceded an assistant reply. */
  steps?: ToolStep[];
  streaming?: boolean;
}

export type {
  ApprovalRequestPayload,
  LlmUnavailablePayload,
} from "@agent/sidecar/index.js";
