/**
 * AG-UI events from the agent loop (ATO-694).
 *
 * AG-UI (https://docs.ag-ui.com, MIT) is an open event protocol between an
 * agent backend and a user-facing app: the client POSTs a `RunAgentInput`
 * and reads one JSON event per SSE `data:` line, each with a `type`
 * (`RUN_STARTED`, `TEXT_MESSAGE_START` / `_CONTENT` / `_END`,
 * `TOOL_CALL_START` / `_ARGS` / `_END` / `_RESULT`, `STATE_SNAPSHOT`,
 * `RUN_FINISHED`, `RUN_ERROR`, ...). This module turns the runtime's
 * `AgentLoopEvent`s into those events, with no I/O: the route
 * (`route-ag-ui.ts`) owns the request, the turn and the socket.
 *
 * The event names and fields follow the AG-UI 1.0 schema
 * (`sdks/typescript/packages/core`). We write the objects ourselves instead
 * of depending on `@ag-ui/core`: they are plain JSON and the route needs no
 * validator, only the shapes.
 *
 * Mapping, per event of a turn:
 *  - `step_started` / `step_finished` → `STEP_STARTED` / `STEP_FINISHED`
 *    (`stepName: "step-<n>"`).
 *  - `assistant_delta` → `TEXT_MESSAGE_START` (once per message, role
 *    `assistant`) then `TEXT_MESSAGE_CONTENT`. A message closes with
 *    `TEXT_MESSAGE_END` at the end of its reply, before a tool call or
 *    reasoning, at the end of the step and at the end of the run.
 *  - `assistant_reply` → whatever of its text the step did not stream yet,
 *    as the chat stream does (`buildStreamEventHook`), then the message
 *    closes. A progress note (a reply batched with work) is a message of
 *    its own. A polished reply that was already streamed goes out as
 *    `CUSTOM atomic.reply_polished`; delivered files as
 *    `CUSTOM atomic.reply_attachments`.
 *  - `reasoning_delta` → `REASONING_START`, `REASONING_MESSAGE_START`,
 *    `REASONING_MESSAGE_CONTENT`, closed by `REASONING_MESSAGE_END` and
 *    `REASONING_END` when anything else starts.
 *  - `tool_call_parsed` → `TOOL_CALL_START`, one `TOOL_CALL_ARGS` with the
 *    whole JSON arguments (the loop parses a call whole), `TOOL_CALL_END`.
 *    `tool_call_executed` → `TOOL_CALL_RESULT` with the call's summary
 *    and `metadata.status` (`ok`, `error`, `denied`, `cancelled`).
 *    `reply` and `finish` are the text above, not tool calls.
 *  - `plan_updated` → `STATE_SNAPSHOT` with `{ plan: { items, updatedAt } }`:
 *    the run's state is the live checklist, whole each time.
 *  - provider waits / switches / recovery, a long call's progress, a
 *    fusion worker's leg, a steer folded in and a step's error the loop
 *    retries → `CUSTOM` with `name: "atomic.<event>"`.
 *  - `loop_failed` is remembered; the route ends the run with `RUN_ERROR`.
 */
import { randomUUID } from "node:crypto";

import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

/** The AG-UI schema version these events follow. */
export const AG_UI_PROTOCOL_VERSION = "1.0";

/** Tools whose call IS the reply text, so never shown as a tool call. */
const TEXT_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

/** Longest tool result summary an event carries; the store keeps the whole one. */
const RESULT_SUMMARY_MAX = 2000;

/** One AG-UI event, as written to the wire. */
export interface AgUiEvent {
  type: string;
  [field: string]: unknown;
}

export interface AgUiTranslatorOptions {
  threadId: string;
  runId: string;
  emit: (event: AgUiEvent) => void;
  /** Test seam: message ids. */
  newId?: () => string;
  /** Test seam: `timestamp` in ms. */
  now?: () => number;
}

export interface AgUiTranslator {
  /** `RUN_STARTED`. Call once, before the turn. */
  runStarted(): void;
  /** Feed every `AgentLoopEvent` of the turn. */
  onEvent(event: AgentLoopEvent): void;
  /** Close anything open and send `RUN_FINISHED`. */
  finished(result: Pick<RunTurnResult, "reason" | "usage">): void;
  /** Close anything open and send `RUN_ERROR`. Prefers the loop's own failure message. */
  failed(message: string, code?: string): void;
}

export function createAgUiTranslator(options: AgUiTranslatorOptions): AgUiTranslator {
  const { threadId, runId } = options;
  const newId = options.newId ?? (() => randomUUID());
  const now = options.now ?? (() => Date.now());
  const emit = (event: AgUiEvent): void => {
    options.emit({ ...event, timestamp: now() });
  };

  let ended = false;
  let stepIndex = -1;
  let stepOpen = false;
  let textId: string | null = null;
  /** Id of the last assistant message, the parent of the tool calls after it. */
  let lastTextId: string | null = null;
  let reasoningId: string | null = null;
  /* Reply text already streamed as deltas in this step: the same
     bookkeeping as the chat stream, so a terminal reply is not written
     twice. */
  let stepStreamed = "";
  let loopFailure: { message: string; code?: string } | null = null;

  const toolCallId = (batchIndex: number): string => `${runId}:${stepIndex}:${batchIndex}`;

  const closeText = (): void => {
    if (textId === null) return;
    emit({ type: "TEXT_MESSAGE_END", messageId: textId });
    textId = null;
  };
  const closeReasoning = (): void => {
    if (reasoningId === null) return;
    emit({ type: "REASONING_MESSAGE_END", messageId: reasoningId });
    emit({ type: "REASONING_END", messageId: reasoningId });
    reasoningId = null;
  };
  const closeAll = (): void => {
    closeReasoning();
    closeText();
  };
  const writeText = (delta: string): void => {
    if (delta.length === 0) return;
    closeReasoning();
    if (textId === null) {
      textId = newId();
      lastTextId = textId;
      emit({ type: "TEXT_MESSAGE_START", messageId: textId, role: "assistant" });
    }
    emit({ type: "TEXT_MESSAGE_CONTENT", messageId: textId, delta });
  };
  const custom = (name: string, value: Record<string, unknown>): void => {
    emit({ type: "CUSTOM", name: `atomic.${name}`, value: jsonSafe(value) });
  };
  const closeStep = (): void => {
    if (!stepOpen) return;
    closeAll();
    emit({ type: "STEP_FINISHED", stepName: `step-${stepIndex}` });
    stepOpen = false;
  };

  /** Write what of a reply the step has not streamed yet. */
  const writeReply = (text: string, rawText: string | undefined): void => {
    const streamed = stepStreamed;
    stepStreamed = "";
    const written = rawText ?? text;
    if (written.length === 0) return;
    const messageId = textId ?? lastTextId;
    if (streamed.length > 0 && (streamed.endsWith(written) || streamed.trimEnd() === written.trimEnd())) {
      if (rawText !== undefined && messageId !== null) custom("reply_polished", { messageId, text });
      return;
    }
    if (streamed.length > 0 && written.startsWith(streamed)) {
      writeText(written.slice(streamed.length));
      if (rawText !== undefined && textId !== null) custom("reply_polished", { messageId: textId, text });
      return;
    }
    // Never streamed: its own message, whole, as the polish left it.
    closeText();
    writeText(text);
  };

  return {
    runStarted() {
      emit({ type: "RUN_STARTED", threadId, runId, protocolVersion: AG_UI_PROTOCOL_VERSION });
    },

    onEvent(event) {
      if (ended) return;
      if (event.type === "step_started") {
        closeStep();
        stepIndex = event.stepIndex;
        stepStreamed = "";
        stepOpen = true;
        emit({ type: "STEP_STARTED", stepName: `step-${stepIndex}` });
        return;
      }
      if (event.type === "step_finished") {
        closeStep();
        return;
      }
      if (event.type === "llm_event") {
        const inner = event.event;
        switch (inner.type) {
          case "assistant_delta":
            if (inner.text.length === 0) return;
            stepStreamed += inner.text;
            writeText(inner.text);
            return;
          case "reasoning_delta":
            if (inner.text.length === 0) return;
            closeText();
            if (reasoningId === null) {
              reasoningId = newId();
              emit({ type: "REASONING_START", messageId: reasoningId });
              emit({ type: "REASONING_MESSAGE_START", messageId: reasoningId, role: "reasoning" });
            }
            emit({ type: "REASONING_MESSAGE_CONTENT", messageId: reasoningId, delta: inner.text });
            return;
          case "assistant_reply": {
            writeReply(inner.text, inner.rawText);
            const messageId = textId ?? lastTextId;
            if (inner.attachments !== undefined && inner.attachments.length > 0 && messageId !== null) {
              custom("reply_attachments", { messageId, attachments: [...inner.attachments] });
            }
            // A reply (or a progress note) is one whole message.
            closeText();
            return;
          }
          case "tool_call_parsed": {
            if (TEXT_TOOLS.has(inner.call.tool)) return;
            closeAll();
            const id = toolCallId(inner.batchIndex);
            emit({
              type: "TOOL_CALL_START",
              toolCallId: id,
              toolCallName: inner.call.tool,
              ...(lastTextId !== null ? { parentMessageId: lastTextId } : {}),
            });
            emit({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: safeStringify(inner.call.args ?? {}) });
            emit({ type: "TOOL_CALL_END", toolCallId: id });
            return;
          }
          case "tool_call_executed": {
            if (TEXT_TOOLS.has(inner.result.tool)) return;
            closeAll();
            emit({
              type: "TOOL_CALL_RESULT",
              messageId: newId(),
              toolCallId: toolCallId(inner.batchIndex),
              role: "tool",
              content: clip(inner.result.summary),
              metadata: {
                status: toolResultStatus(inner.result),
                ...(typeof inner.durationMs === "number" && Number.isFinite(inner.durationMs)
                  ? { durationMs: Math.max(0, Math.round(inner.durationMs)) }
                  : {}),
              },
            });
            return;
          }
          case "plan_updated":
            emit({
              type: "STATE_SNAPSHOT",
              snapshot: {
                plan: {
                  items: inner.plan.items.map((item) => ({ step: item.step, status: item.status })),
                  updatedAt: inner.plan.updatedAt,
                },
              },
            });
            return;
          case "step_error":
            // The loop may still recover (retry, fallback): not the end of the run.
            custom("step_error", {
              message: inner.error.message,
              ...(inner.category ? { category: inner.category } : {}),
            });
            return;
          default:
            return;
        }
      }
      switch (event.type) {
        case "steer_applied":
          custom("steer_applied", { text: event.text, stepIndex: event.stepIndex });
          return;
        case "provider_waiting":
          custom("provider_waiting", {
            attempt: event.attempt,
            waitedMs: event.waitedMs,
            maxWaitMs: event.maxWaitMs,
            nextRetryMs: event.nextRetryMs,
            reason: event.reason,
            ...(event.providerId !== undefined ? { providerId: event.providerId } : {}),
          });
          return;
        case "provider_recovered":
          custom("provider_recovered", { waitedMs: event.waitedMs });
          return;
        case "provider_switched":
          if (event.direction !== "away") return;
          custom("provider_switched", {
            from: event.from,
            to: event.to,
            ...(event.toModel !== undefined ? { toModel: event.toModel } : {}),
          });
          return;
        case "tool_progress":
          custom("tool_progress", {
            tool: event.tool,
            fraction: Number.isFinite(event.fraction) ? Math.min(Math.max(event.fraction, 0), 1) : 0,
            label: event.label,
          });
          return;
        case "fusion_worker":
          custom("fusion_worker", {
            taskId: event.taskId,
            title: event.title,
            phase: event.phase,
            role: event.role ?? "worker",
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
          });
          return;
        case "loop_failed":
          loopFailure = {
            message: event.error.message,
            ...(event.category ? { code: event.category } : {}),
          };
          return;
        default:
          return;
      }
    },

    finished(result) {
      if (ended) return;
      closeStep();
      closeAll();
      ended = true;
      const usage = result.usage;
      const input = usage?.promptTokens ?? 0;
      const output = usage?.completionTokens ?? 0;
      emit({
        type: "RUN_FINISHED",
        threadId,
        runId,
        outcome: result.reason === "cancelled" ? { type: "cancelled" } : { type: "success" },
        ...(usage !== undefined
          ? { usage: [{ inputTokens: input, outputTokens: output, totalTokens: input + output }] }
          : {}),
      });
    },

    failed(message, code) {
      if (ended) return;
      closeStep();
      closeAll();
      ended = true;
      const failure = loopFailure ?? { message, ...(code !== undefined ? { code } : {}) };
      emit({
        type: "RUN_ERROR",
        message: failure.message,
        ...(failure.code !== undefined ? { code: failure.code } : {}),
      });
    },
  };
}

/** Same verdicts as the chat stream's `tool_result.status`. */
function toolResultStatus(result: CompressedToolResult): "ok" | "error" | "denied" | "cancelled" {
  const details = result.details ?? {};
  if (details.cancelled === true) return "cancelled";
  if (result.status === "ok") return "ok";
  if (
    details.approvalDenied === true ||
    details.errorName === "ApprovalDeniedError" ||
    (result.approvals ?? []).some((a) => a.verdict === "denied")
  ) {
    return "denied";
  }
  return "error";
}

function clip(summary: string): string {
  const text = typeof summary === "string" ? summary : "";
  return text.length > RESULT_SUMMARY_MAX ? `${text.slice(0, RESULT_SUMMARY_MAX - 1)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Drop what JSON cannot carry (functions, cycles) from a CUSTOM value. */
function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
