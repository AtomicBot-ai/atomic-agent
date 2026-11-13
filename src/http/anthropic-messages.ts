import type { ServerResponse } from "node:http";

import {
  normaliseFinish,
  passThroughHeaders,
  randomHex,
  readErrorMessage,
  readUsage,
  runChatCompletionsBridge,
  type ChatBridgeBody,
  type ChatFinish,
} from "./compat-bridge.js";
import {
  SSE_HEARTBEAT_MS,
  beginSse,
  readJsonBody,
  sendJson,
  type HttpHandler,
  type SseWriter,
} from "./request-context.js";

/**
 * ATO-1080: `POST /v1/messages`, the Anthropic Messages API, so Claude
 * Code and Anthropic SDK clients can talk to the agent. The request is
 * turned into a chat-completions body and run through the same handler
 * (compat-bridge.ts); the answer is turned back into an Anthropic `message`
 * or its SSE event sequence.
 *
 * The agent runs its own tools on its own side. Client `tools` /
 * `tool_choice` are accepted and not offered to the model, so the reply is
 * always text and `stop_reason` is never `tool_use`. Tool blocks already in
 * the history (`tool_use`, `tool_result`) are kept as plain text so their
 * content is not lost. `model` is echoed; the agent's active model answers.
 */

export const DEFAULT_ANTHROPIC_MODEL = "atomic-agent";

interface AnthropicBlock {
  type?: string;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface AnthropicRequest {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  stream?: unknown;
  session_id?: unknown;
  working_dir?: unknown;
}

export type MappedRequest =
  | { ok: true; body: ChatBridgeBody; model: string }
  | { ok: false; message: string };

/** Flatten Anthropic content (a string or a block list) to the text the agent reads. */
export function anthropicContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content as AnthropicBlock[]) {
    const text = blockToText(raw);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

function blockToText(block: AnthropicBlock | null | undefined): string {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "tool";
      return `[tool call ${name}: ${safeJson(block.input ?? {})}]`;
    }
    case "tool_result": {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const body = anthropicContentToText(block.content);
      const label = block.is_error === true ? "tool error" : "tool result";
      return `[${label}${id ? ` ${id}` : ""}]: ${body}`;
    }
    case "image":
      return "[image omitted]";
    case "document":
      return "[document omitted]";
    // `thinking` / `redacted_thinking` are the model's own notes: not context to resend.
    default:
      return "";
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Map an Anthropic Messages request onto a chat-completions body. */
export function anthropicToChatRequest(raw: unknown): MappedRequest {
  const body = (raw ?? {}) as AnthropicRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: "messages: field required and must be a non-empty array" };
  }
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : DEFAULT_ANTHROPIC_MODEL;
  const messages: ChatBridgeBody["messages"] = [];
  const system = anthropicContentToText(body.system);
  if (system.length > 0) messages.push({ role: "system", content: system });
  for (const entry of body.messages as Array<{ role?: unknown; content?: unknown }>) {
    const role = entry?.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role: role as "user" | "assistant", content: anthropicContentToText(entry.content) });
  }
  const stream = body.stream === true;
  const chat: ChatBridgeBody = {
    model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(typeof body.session_id === "string" && body.session_id.length > 0 ? { session_id: body.session_id } : {}),
    ...(typeof body.working_dir === "string" ? { working_dir: body.working_dir } : {}),
  };
  return { ok: true, body: chat, model };
}

export function anthropicStopReason(finish: ChatFinish): "end_turn" | "max_tokens" {
  return finish === "length" ? "max_tokens" : "end_turn";
}

/** The Anthropic error `type` for an HTTP status. */
export function anthropicErrorType(status: number): string {
  if (status === 400 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503) return "overloaded_error";
  return "api_error";
}

export function anthropicError(status: number, message: string): {
  type: "error";
  error: { type: string; message: string };
} {
  return { type: "error", error: { type: anthropicErrorType(status), message } };
}

/** A chat.completion JSON body as an Anthropic `message`. */
export function chatCompletionToAnthropic(
  chat: unknown,
  opts: { id: string; model: string },
): Record<string, unknown> {
  const choice = (chat as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })
    ?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const usage = readUsage((chat as { usage?: unknown })?.usage);
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: opts.model,
    content: text.length > 0 ? [{ type: "text", text }] : [],
    stop_reason: anthropicStopReason(normaliseFinish(choice?.finish_reason)),
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Turns the inner chat-completions stream (one `data:` payload at a time)
 * into Anthropic's event sequence: `message_start`, then for the text
 * `content_block_start` / `content_block_delta`* / `content_block_stop`,
 * then `message_delta` (stop reason and usage) and `message_stop`.
 *
 * An OpenAI error envelope in the inner stream is held, not sent: a failed
 * step the loop then retried is followed by more text, and is dropped. One
 * that nothing follows is how the inner handler ends a failed turn, so the
 * sequence then ends with one `error` event instead of `message_delta`.
 */
export class AnthropicStreamTranslator {
  private blockOpen = false;
  private finish: ChatFinish = "stop";
  private usage = { input: 0, output: 0 };
  private done = false;
  private pendingError: string | null = null;

  constructor(private readonly opts: { id: string; model: string }) {}

  start(): SseEvent[] {
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.opts.id,
            type: "message",
            role: "assistant",
            model: this.opts.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  push(data: string): SseEvent[] {
    if (this.done) return [];
    if (data === "[DONE]") return this.finishEvents();
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (chunk["error"] !== undefined) {
      this.pendingError = readErrorMessage(chunk);
      return [];
    }
    const out: SseEvent[] = [];
    if (chunk["usage"]) {
      const usage = readUsage(chunk["usage"]);
      if (usage.input > 0 || usage.output > 0) this.usage = usage;
    }
    const choice = (chunk["choices"] as Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> | undefined)?.[0];
    const text = choice?.delta?.content;
    if (typeof text === "string" && text.length > 0) {
      this.pendingError = null;
      if (!this.blockOpen) {
        this.blockOpen = true;
        out.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        });
      }
      out.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      });
    }
    if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
      this.finish = normaliseFinish(choice.finish_reason);
    }
    return out;
  }

  /** Close the sequence; also what an inner stream that ended without `[DONE]` gets. */
  finishEvents(): SseEvent[] {
    if (this.done) return [];
    this.done = true;
    if (this.pendingError !== null) {
      return [{ event: "error", data: anthropicError(500, this.pendingError) }];
    }
    const out: SseEvent[] = [];
    if (this.blockOpen) {
      this.blockOpen = false;
      out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    }
    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: anthropicStopReason(this.finish), stop_sequence: null },
        usage: { input_tokens: this.usage.input, output_tokens: this.usage.output },
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }
}

function makeMessageId(): string {
  return `msg_${randomHex(24)}`;
}

/** Handler for `POST /v1/messages`. */
export function createAnthropicMessagesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, anthropicError(400, `Invalid JSON in request body: ${message}`));
      return;
    }
    const mapped = anthropicToChatRequest(raw);
    if (!mapped.ok) {
      sendJson(res, 400, anthropicError(400, mapped.message));
      return;
    }
    const id = makeMessageId();
    const opts = { id, model: mapped.model };
    let sse: SseWriter | null = null;
    const translator = new AnthropicStreamTranslator(opts);
    const write = (events: SseEvent[]): void => {
      for (const e of events) sse?.writeEvent(e.event, e.data);
    };
    try {
      await runChatCompletionsBridge(req, res, ctx, mapped.body, {
        onJson(status, headers, body) {
          if (status === 200 && !mapped.body.stream) {
            sendJson(res, 200, chatCompletionToAnthropic(body, opts), passThroughHeaders(headers));
          } else {
            sendJson(res, status === 200 ? 500 : status, anthropicError(status, readErrorMessage(body)));
          }
        },
        onStreamStart(headers) {
          sse = beginSse(res, passThroughHeaders(headers), { heartbeatMs: SSE_HEARTBEAT_MS });
          write(translator.start());
        },
        onStreamData(data) {
          write(translator.push(data));
        },
        onStreamEnd() {
          write(translator.finishEvents());
          (sse as SseWriter | null)?.close();
        },
      });
    } catch (err) {
      failAfterThrow(res, sse, err);
    }
  };
}

function failAfterThrow(res: ServerResponse, sse: SseWriter | null, err: unknown): void {
  const message = `Internal server error: ${err instanceof Error ? err.message : String(err)}`;
  if (sse) {
    sse.writeEvent("error", anthropicError(500, message));
    sse.close();
    return;
  }
  if (!res.headersSent) sendJson(res, 500, anthropicError(500, message));
  else if (!res.writableEnded) res.end();
}

/**
 * `POST /v1/messages/count_tokens`: Claude Code asks it before long
 * prompts. The agent builds its own prompt around the request, so an exact
 * count is not knowable here; this answers a rough estimate (about four
 * characters a token) of what the request carries.
 */
export function createAnthropicCountTokensHandler(): HttpHandler {
  return async (req, res) => {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, anthropicError(400, `Invalid JSON in request body: ${message}`));
      return;
    }
    sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(raw) });
  };
}

export function estimateAnthropicInputTokens(raw: unknown): number {
  const body = (raw ?? {}) as AnthropicRequest & { tools?: unknown };
  let chars = anthropicContentToText(body.system).length;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Array<{ content?: unknown }>) chars += anthropicContentToText(m?.content).length;
  }
  if (body.tools !== undefined) chars += safeJson(body.tools).length;
  return Math.ceil(chars / 4);
}
