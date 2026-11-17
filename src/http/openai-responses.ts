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
import { openaiError } from "./openai-errors.js";
import {
  SSE_HEARTBEAT_MS,
  beginSse,
  readJsonBody,
  sendJson,
  type HttpHandler,
  type SseWriter,
} from "./request-context.js";

/**
 * ATO-1080: `POST /v1/responses`, the OpenAI Responses API, so Codex and
 * OpenAI Agents SDK clients can talk to the agent. Like `/v1/messages` it
 * runs on the chat-completions handler (compat-bridge.ts) and only changes
 * the envelope.
 *
 * - `instructions` is the system prompt; `input` is a string or a list of
 *   items (`message` items with `input_text` / `output_text` parts,
 *   `function_call`, `function_call_output`), flattened to text.
 * - `previous_response_id` continues the chat that response belongs to.
 *   Response ids carry their session (`resp_<random>_<session, base64url>`),
 *   so this works across a `serve` restart with nothing stored on the side.
 * - Client `tools` are accepted and not offered to the model (the agent
 *   runs its own); the output is one `message` item with `output_text`.
 * - `max_steps` ending the turn reads as `status: "incomplete"` with
 *   `incomplete_details.reason: "max_output_tokens"`.
 */

export const DEFAULT_RESPONSES_MODEL = "atomic-agent";

export interface ResponsesItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  call_id?: unknown;
  output?: unknown;
  text?: unknown;
}

interface ResponsesRequest {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  stream?: unknown;
  previous_response_id?: unknown;
  working_dir?: unknown;
}

export type MappedResponsesRequest =
  | { ok: true; body: ChatBridgeBody; model: string; previousResponseId: string | null; instructions: string | null }
  | { ok: false; message: string; param: string | null };

/** `resp_<24 hex>_<session id, base64url>`. */
export function makeResponseId(sessionId: string): string {
  return `resp_${randomHex(24)}_${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

/** The session a response id was minted for, or null when it is not one of ours. */
export function sessionIdFromResponseId(id: string): string | null {
  const match = /^resp_[0-9a-f]{24}_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64url").toString("utf8");
  if (decoded.length === 0 || /[\r\n\x00]/.test(decoded)) return null;
  return decoded;
}

/** Text of one item's `content`: a string or a list of parts. */
export function responsesContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content as ResponsesItem[]) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw.type === "input_text" || raw.type === "output_text" || raw.type === "text") && typeof raw.text === "string") {
      parts.push(raw.text);
    } else if (raw.type === "input_image") {
      parts.push("[image omitted]");
    } else if (raw.type === "input_file") {
      parts.push("[file omitted]");
    }
  }
  return parts.join("\n\n");
}

/** One input item as a chat message, or null for items the agent has no use for. */
export function responsesItemToMessage(
  item: ResponsesItem,
): { role: "system" | "user" | "assistant"; content: string } | null {
  if (!item || typeof item !== "object") return null;
  const type = item.type ?? "message";
  if (type === "message") {
    const role = item.role === "developer" ? "system" : item.role;
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    return { role: role as "system" | "user" | "assistant", content: responsesContentToText(item.content) };
  }
  if (type === "function_call") {
    const name = typeof item.name === "string" ? item.name : "tool";
    const args = typeof item.arguments === "string" ? item.arguments : "{}";
    return { role: "assistant", content: `[tool call ${name}: ${args}]` };
  }
  if (type === "function_call_output") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const output = typeof item.output === "string" ? item.output : responsesContentToText(item.output);
    return { role: "user", content: `[tool result${id ? ` ${id}` : ""}]: ${output}` };
  }
  // `reasoning` and other item types carry nothing the agent resends.
  return null;
}

/** Map a Responses request onto a chat-completions body. */
export function responsesToChatRequest(raw: unknown): MappedResponsesRequest {
  const body = (raw ?? {}) as ResponsesRequest;
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : DEFAULT_RESPONSES_MODEL;
  const messages: ChatBridgeBody["messages"] = [];
  const instructions = typeof body.instructions === "string" && body.instructions.length > 0 ? body.instructions : null;
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input as ResponsesItem[]) {
      const message = responsesItemToMessage(item);
      if (message) messages.push(message);
    }
  } else {
    return { ok: false, message: "Missing or invalid 'input' field", param: "input" };
  }
  if (!messages.some((m) => m.role === "user" && m.content.length > 0)) {
    return { ok: false, message: "No user input found in 'input'", param: "input" };
  }
  let previousResponseId: string | null = null;
  let sessionId: string | null = null;
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    previousResponseId = typeof body.previous_response_id === "string" ? body.previous_response_id : "";
    sessionId = sessionIdFromResponseId(previousResponseId);
    if (!sessionId) {
      return { ok: false, message: "Previous response not found", param: "previous_response_id" };
    }
  }
  const stream = body.stream === true;
  return {
    ok: true,
    model,
    previousResponseId,
    instructions,
    body: {
      model,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(typeof body.working_dir === "string" ? { working_dir: body.working_dir } : {}),
    },
  };
}

export interface ResponseOpts {
  /** Set once the inner handler named its session; the id depends on it. */
  id: string;
  itemId: string;
  model: string;
  createdAt: number;
  previousResponseId: string | null;
  instructions: string | null;
}

function outputMessage(opts: ResponseOpts, text: string, status: "in_progress" | "completed" | "incomplete") {
  return {
    id: opts.itemId,
    type: "message",
    status,
    role: "assistant",
    content: status === "in_progress" ? [] : [outputTextPart(text)],
  };
}

function outputTextPart(text: string) {
  return { type: "output_text", text, annotations: [] };
}

/** The `response` object, in whatever state it is in. */
export function buildResponseObject(
  opts: ResponseOpts,
  state:
    | { status: "in_progress" }
    | { status: "completed" | "incomplete"; text: string; finish: ChatFinish; usage: { input: number; output: number } }
    | { status: "failed"; message: string },
): Record<string, unknown> {
  const base = {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    model: opts.model,
    previous_response_id: opts.previousResponseId,
    instructions: opts.instructions,
    parallel_tool_calls: false,
    tool_choice: "none",
    tools: [],
  };
  if (state.status === "in_progress") {
    return { ...base, status: "in_progress", output: [], error: null, incomplete_details: null, usage: null };
  }
  if (state.status === "failed") {
    return {
      ...base,
      status: "failed",
      output: [],
      error: { code: "server_error", message: state.message },
      incomplete_details: null,
      usage: null,
    };
  }
  return {
    ...base,
    status: state.status,
    output: [outputMessage(opts, state.text, state.status)],
    error: null,
    incomplete_details: state.status === "incomplete" ? { reason: "max_output_tokens" } : null,
    usage: {
      input_tokens: state.usage.input,
      output_tokens: state.usage.output,
      total_tokens: state.usage.input + state.usage.output,
    },
  };
}

function statusFor(finish: ChatFinish): "completed" | "incomplete" {
  return finish === "length" ? "incomplete" : "completed";
}

/** A chat.completion JSON body as a `response` object. */
export function chatCompletionToResponse(chat: unknown, opts: ResponseOpts): Record<string, unknown> {
  const choice = (chat as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })
    ?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const finish = normaliseFinish(choice?.finish_reason);
  return buildResponseObject(opts, {
    status: statusFor(finish),
    text,
    finish,
    usage: readUsage((chat as { usage?: unknown })?.usage),
  });
}

export interface ResponsesSseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Turns the inner chat-completions stream into the Responses event
 * sequence: `response.created`, `response.in_progress`, then for the
 * message `response.output_item.added`, `response.content_part.added`,
 * `response.output_text.delta`*, `response.output_text.done`,
 * `response.content_part.done`, `response.output_item.done`, and last
 * `response.completed` (or `response.incomplete`). Every event carries
 * `sequence_number`.
 *
 * An OpenAI error envelope in the inner stream is held: dropped when more
 * text follows (a failed step the loop retried), and otherwise the turn
 * failed, so the sequence ends with `response.failed`.
 */
export class ResponsesStreamTranslator {
  private seq = 0;
  private text = "";
  private itemOpen = false;
  private finish: ChatFinish = "stop";
  private usage = { input: 0, output: 0 };
  private done = false;
  private pendingError: string | null = null;

  constructor(private readonly opts: ResponseOpts) {}

  private ev(type: string, fields: Record<string, unknown>): ResponsesSseEvent {
    return { event: type, data: { type, sequence_number: this.seq++, ...fields } };
  }

  start(): ResponsesSseEvent[] {
    const response = buildResponseObject(this.opts, { status: "in_progress" });
    return [this.ev("response.created", { response }), this.ev("response.in_progress", { response })];
  }

  private openItem(): ResponsesSseEvent[] {
    this.itemOpen = true;
    return [
      this.ev("response.output_item.added", {
        output_index: 0,
        item: outputMessage(this.opts, "", "in_progress"),
      }),
      this.ev("response.content_part.added", {
        item_id: this.opts.itemId,
        output_index: 0,
        content_index: 0,
        part: outputTextPart(""),
      }),
    ];
  }

  push(data: string): ResponsesSseEvent[] {
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
    if (chunk["usage"]) {
      const usage = readUsage(chunk["usage"]);
      if (usage.input > 0 || usage.output > 0) this.usage = usage;
    }
    const out: ResponsesSseEvent[] = [];
    const choice = (chunk["choices"] as Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> | undefined)?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      this.pendingError = null;
      if (!this.itemOpen) out.push(...this.openItem());
      this.text += delta;
      out.push(
        this.ev("response.output_text.delta", {
          item_id: this.opts.itemId,
          output_index: 0,
          content_index: 0,
          delta,
        }),
      );
    }
    if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
      this.finish = normaliseFinish(choice.finish_reason);
    }
    return out;
  }

  /** Close the sequence; also what an inner stream that ended without `[DONE]` gets. */
  finishEvents(): ResponsesSseEvent[] {
    if (this.done) return [];
    this.done = true;
    if (this.pendingError !== null) {
      const response = buildResponseObject(this.opts, { status: "failed", message: this.pendingError });
      return [this.ev("response.failed", { response })];
    }
    const out: ResponsesSseEvent[] = [];
    if (!this.itemOpen) out.push(...this.openItem());
    const status = statusFor(this.finish);
    out.push(
      this.ev("response.output_text.done", {
        item_id: this.opts.itemId,
        output_index: 0,
        content_index: 0,
        text: this.text,
      }),
      this.ev("response.content_part.done", {
        item_id: this.opts.itemId,
        output_index: 0,
        content_index: 0,
        part: outputTextPart(this.text),
      }),
      this.ev("response.output_item.done", {
        output_index: 0,
        item: outputMessage(this.opts, this.text, status),
      }),
    );
    const response = buildResponseObject(this.opts, {
      status,
      text: this.text,
      finish: this.finish,
      usage: this.usage,
    });
    out.push(this.ev(status === "incomplete" ? "response.incomplete" : "response.completed", { response }));
    return out;
  }
}

/** Handler for `POST /v1/responses`. */
export function createResponsesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, openaiError(`Invalid JSON in request body: ${message}`));
      return;
    }
    const mapped = responsesToChatRequest(raw);
    if (!mapped.ok) {
      sendJson(res, 400, openaiError(mapped.message, "invalid_request_error", mapped.param));
      return;
    }
    const opts: ResponseOpts = {
      id: "",
      itemId: `msg_${randomHex(24)}`,
      model: mapped.model,
      createdAt: Math.floor(Date.now() / 1000),
      previousResponseId: mapped.previousResponseId,
      instructions: mapped.instructions,
    };
    const withSession = (headers: Record<string, string>): void => {
      opts.id = makeResponseId(headers["x-atomic-session-id"] ?? "");
    };
    let sse: SseWriter | null = null;
    const translator = new ResponsesStreamTranslator(opts);
    const write = (events: ResponsesSseEvent[]): void => {
      for (const e of events) sse?.writeEvent(e.event, e.data);
    };
    try {
      await runChatCompletionsBridge(req, res, ctx, mapped.body, {
        onJson(status, headers, body) {
          if (status === 200 && !mapped.body.stream) {
            withSession(headers);
            sendJson(res, 200, chatCompletionToResponse(body, opts), passThroughHeaders(headers));
          } else {
            sendJson(res, status === 200 ? 500 : status, body ?? openaiError("Unknown error", "server_error"));
          }
        },
        onStreamStart(headers) {
          withSession(headers);
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
    sse.writeEvent("error", { type: "error", code: "server_error", message });
    sse.close();
    return;
  }
  if (!res.headersSent) sendJson(res, 500, openaiError(message, "server_error"));
  else if (!res.writableEnded) res.end();
}
