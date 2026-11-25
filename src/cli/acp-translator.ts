/**
 * Pure mapping between the agent and the Agent Client Protocol
 * (ATO-543): prompt content blocks to the user message, agent loop
 * events to `session/update` notifications, loop reasons to ACP stop
 * reasons, and approval requests to `session/request_permission`
 * options and back. No I/O; `acp-server.ts` drives it.
 *
 * Behaviour follows the ACP adapters of OpenClaw (`src/acp/translator.ts`)
 * and Hermes (`acp_adapter`): text streams as `agent_message_chunk`,
 * thinking as `agent_thought_chunk`, every tool call opens as
 * `tool_call` (pending) and closes as `tool_call_update`, the checklist
 * is sent whole as `plan`.
 */

import {
  canGrantCategory,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { describeAlwaysRule } from "../approval/approval-rules.js";
import type { AgentLoopEvent, AgentLoopReason } from "../agent/agent-contract.js";
import type { PlanSnapshot } from "../agent/plan/plan-snapshot.js";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

// ---------------------------------------------------------------- types

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpTextContent {
  type: "text";
  text: string;
}

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: AcpTextContent }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpTextContent }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: AcpToolKind;
      status: AcpToolStatus;
      rawInput?: Record<string, unknown>;
      locations?: Array<{ path: string }>;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: AcpToolStatus;
      content?: Array<{ type: "content"; content: AcpTextContent }>;
    }
  | {
      sessionUpdate: "plan";
      entries: Array<{
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }>;
    };

export type AcpPermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionKind;
}

export type AcpPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

// --------------------------------------------------------------- prompt

/**
 * The user message for an ACP `prompt` array. Text goes in as is; an
 * embedded resource with text becomes a fenced block under its URI; a
 * link or a binary resource is named by URI so the agent can open it
 * with its own tools. Other block types (image, audio) are not
 * advertised in `promptCapabilities` and are skipped.
 */
export function promptToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      const name = typeof block.name === "string" && block.name.length > 0 ? block.name : block.uri;
      parts.push(`[@${name}](${block.uri})`);
    } else if (block.type === "resource" && isObject(block.resource)) {
      const uri = typeof block.resource.uri === "string" ? block.resource.uri : "resource";
      if (typeof block.resource.text === "string") {
        parts.push(`<context uri="${uri}">\n${block.resource.text}\n</context>`);
      } else {
        parts.push(`[@${uri}](${uri})`);
      }
    }
  }
  return parts.join("\n\n").trim();
}

// ---------------------------------------------------------------- tools

/** Tools that are the turn's own plumbing, not work to show as a tool call. */
const HIDDEN_TOOLS = new Set(["reply", "finish", "plan.update", "ask_user"]);

export function isHiddenTool(tool: string): boolean {
  return HIDDEN_TOOLS.has(tool);
}

export function toolKind(tool: string): AcpToolKind {
  if (tool === "os.fs.trash") return "delete";
  if (tool === "os.fs.move") return "move";
  if (/^os\.fs\.(write|edit|patch|restore)/.test(tool)) return "edit";
  if (/^os\.fs\.|^os\.git\.(diff|log|show|status|blame)|^memory\..*\.(recall|list|history)$/.test(tool)) {
    return /\.(search|grep|find|glob)$/.test(tool) ? "search" : "read";
  }
  if (/^os\.shell\.|^os\.proc\.|^os\.git\./.test(tool)) return "execute";
  if (/search/.test(tool)) return "search";
  if (/^os\.web\.|^os\.http\.|^browser\./.test(tool)) return "fetch";
  return "other";
}

function argString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** A one-line title for a tool call, e.g. `os.shell.run: npm test`. */
export function toolTitle(call: ToolCallPayload): string {
  const detail = argString(call.args, "command", "path", "url", "query", "pattern", "target", "name");
  const line = detail === undefined ? call.tool : `${call.tool}: ${detail}`;
  const firstLine = line.split("\n", 1)[0]!;
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

function toolLocations(call: ToolCallPayload): Array<{ path: string }> | undefined {
  const path = argString(call.args, "path", "file", "target_path");
  return path !== undefined && path.startsWith("/") ? [{ path }] : undefined;
}

export function toolCallStarted(toolCallId: string, call: ToolCallPayload): AcpSessionUpdate {
  const locations = toolLocations(call);
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: toolTitle(call),
    kind: toolKind(call.tool),
    status: "pending",
    rawInput: call.args,
    ...(locations !== undefined ? { locations } : {}),
  };
}

export function toolCallFinished(toolCallId: string, result: CompressedToolResult): AcpSessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: result.status === "ok" ? "completed" : "failed",
    ...(result.summary.length > 0
      ? { content: [{ type: "content" as const, content: { type: "text" as const, text: result.summary } }] }
      : {}),
  };
}

export function planUpdate(plan: PlanSnapshot): AcpSessionUpdate {
  return {
    sessionUpdate: "plan",
    entries: plan.items.map((item) => ({
      content: item.step,
      priority: "medium" as const,
      status: item.status === "done" ? ("completed" as const) : item.status,
    })),
  };
}

// --------------------------------------------------------- stop reasons

export function stopReason(reason: AgentLoopReason): AcpStopReason {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "max_steps":
      return "max_turn_requests";
    default:
      // `reply` and `finish` end the turn; `failed` too: the error has
      // already been streamed to the client as a message.
      return "end_turn";
  }
}

// -------------------------------------------------------- turn streamer

/**
 * Turns the loop events of one session into `session/update` payloads.
 * Keeps the per-step tool call ids (the loop's events carry a batch
 * index, ACP wants a stable id per call) and whether the reply text was
 * already streamed, so the closing `assistant_reply` is not sent twice.
 */
export class AcpTurnTranslator {
  private nextCallId = 0;
  private readonly openCalls = new Map<number, { id: string; tool: string }>();
  private streamedReply = false;

  constructor(private readonly idPrefix = "call") {}

  /** The id of the newest open call of `tool`, for an approval asked while it runs. */
  openCallFor(tool: string): string | undefined {
    let found: string | undefined;
    for (const call of this.openCalls.values()) if (call.tool === tool) found = call.id;
    return found;
  }

  translate(event: AgentLoopEvent): AcpSessionUpdate[] {
    if (event.type === "step_started") {
      this.openCalls.clear();
      return [];
    }
    if (event.type === "loop_failed") {
      return [message(`\n\nError: ${event.error.message}`)];
    }
    if (event.type !== "llm_event") return [];
    const inner = event.event;
    switch (inner.type) {
      case "assistant_delta":
        if (inner.text.length === 0) return [];
        this.streamedReply = true;
        return [message(inner.text)];
      case "assistant_reply": {
        const streamed = this.streamedReply;
        this.streamedReply = false;
        if (streamed || inner.text.length === 0) return [];
        return [message(inner.text)];
      }
      case "reasoning_delta":
        return inner.text.length === 0
          ? []
          : [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.text } }];
      case "plan_updated":
        return [planUpdate(inner.plan)];
      case "tool_call_parsed": {
        if (isHiddenTool(inner.call.tool)) return [];
        const id = `${this.idPrefix}-${++this.nextCallId}`;
        this.openCalls.set(inner.batchIndex, { id, tool: inner.call.tool });
        return [toolCallStarted(id, inner.call)];
      }
      case "tool_call_executed": {
        const open = this.openCalls.get(inner.batchIndex);
        if (open === undefined || open.tool !== inner.result.tool) return [];
        this.openCalls.delete(inner.batchIndex);
        return [toolCallFinished(open.id, inner.result)];
      }
      default:
        return [];
    }
  }
}

function message(text: string): AcpSessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

// ---------------------------------------------------------- permissions

export const OPTION_ALLOW = "allow";
export const OPTION_ALLOW_SESSION = "allow-session";
export const OPTION_ALLOW_ALWAYS = "allow-always";
export const OPTION_REJECT = "reject";
const OPTION_ANSWER_PREFIX = "answer-";

/**
 * The buttons for one approval request. The same choices as the TUI and
 * the desktop: once, for this chat (when the category can be granted),
 * always (when a rule can be saved), deny. A question (`ask_user`) shows
 * its options as the buttons instead; picking one answers it.
 */
export function permissionOptions(
  request: ApprovalRequest,
  canAlways: boolean,
): AcpPermissionOption[] {
  if (request.question !== undefined) {
    return [
      ...request.question.options.map((option, i) => ({
        optionId: `${OPTION_ANSWER_PREFIX}${i}`,
        name: option.label,
        kind: "allow_once" as const,
      })),
      { optionId: OPTION_REJECT, name: "Skip the question", kind: "reject_once" },
    ];
  }
  const options: AcpPermissionOption[] = [{ optionId: OPTION_ALLOW, name: "Allow once", kind: "allow_once" }];
  if (canGrantCategory(request)) {
    options.push({ optionId: OPTION_ALLOW_SESSION, name: "Allow for this chat", kind: "allow_always" });
  }
  if (canAlways) {
    options.push({
      optionId: OPTION_ALLOW_ALWAYS,
      // Already reads "Always allow ...", as on the TUI and desktop buttons.
      name: describeAlwaysRule(request),
      kind: "allow_always",
    });
  }
  options.push({ optionId: OPTION_REJECT, name: "Deny", kind: "reject_once" });
  return options;
}

/** The `toolCall` field of `session/request_permission`. */
export function permissionToolCall(
  request: ApprovalRequest,
  toolCallId: string,
): Record<string, unknown> {
  const text = [request.reason, request.preview, request.riskNote].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return {
    toolCallId,
    title: request.question !== undefined ? request.question.prompt : `${request.tool}: ${request.reason}`,
    kind: request.question !== undefined ? "think" : toolKind(request.tool),
    status: "pending",
    ...(text.length > 0
      ? { content: [{ type: "content", content: { type: "text", text: text.join("\n\n") } }] }
      : {}),
    ...(request.affectedResources !== undefined && request.affectedResources.length > 0
      ? { locations: request.affectedResources.filter((p) => p.startsWith("/")).map((path) => ({ path })) }
      : {}),
  };
}

/**
 * The gate decision for the client's answer. Anything but a known
 * option (a cancelled prompt, an unknown id, a malformed answer) is a
 * denial, never a yes. A grant is only named where the options offered
 * it, so the gate never sees a wider yes than the button said.
 */
export function permissionDecision(
  request: ApprovalRequest,
  canAlways: boolean,
  outcome: unknown,
): ApprovalDecision {
  const deny = (reason?: string): ApprovalDecision => ({
    approvalId: request.approvalId,
    approved: false,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (!isObject(outcome) || outcome.outcome !== "selected" || typeof outcome.optionId !== "string") {
    return { ...deny("the editor closed the prompt"), automatic: true };
  }
  const offered = permissionOptions(request, canAlways).some((o) => o.optionId === outcome.optionId);
  if (!offered) return { ...deny("unknown answer from the editor"), automatic: true };
  const id = outcome.optionId;
  if (request.question !== undefined) {
    if (!id.startsWith(OPTION_ANSWER_PREFIX)) return deny();
    const option = request.question.options[Number(id.slice(OPTION_ANSWER_PREFIX.length))];
    if (option === undefined) return { ...deny("unknown answer from the editor"), automatic: true };
    return { approvalId: request.approvalId, approved: true, answer: { selected: [option.label] } };
  }
  switch (id) {
    case OPTION_ALLOW:
      return { approvalId: request.approvalId, approved: true };
    case OPTION_ALLOW_SESSION:
      return { approvalId: request.approvalId, approved: true, grant: "category" };
    case OPTION_ALLOW_ALWAYS:
      return { approvalId: request.approvalId, approved: true, grant: "always" };
    default:
      return deny();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
