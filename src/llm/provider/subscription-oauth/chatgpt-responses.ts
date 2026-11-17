import type {
  CompletionRequest,
  CompletionUsage,
  OpenAiToolCall,
} from "../completion-types.js";
import { assertContextCapacity } from "../context-capacity.js";
import { buildNativeMessages, type OpenAiChatMessage } from "../openai/openai-native-messages.js";
import { nameEscape as defaultNameEscape } from "../openai/openai-tool-call-adapter.js";
import { filterCloudCompletionRequest } from "../openai/sampling-filter.js";
import { parseCodexRateLimitsPayload, type RateLimitWindow } from "../rate-limits.js";

/**
 * EXPERIMENTAL (ATO-1448): the Responses API body the ChatGPT Codex
 * backend takes, and a reader for the SSE it answers with.
 *
 * Body shape follows codex-rs/codex-api/src/common.rs
 * `ResponsesApiRequest` (model, stream, input, tools, tool_choice,
 * parallel_tool_calls, reasoning, store, include, prompt_cache_key,
 * text) plus `instructions`, which pi
 * (packages/ai/src/api/openai-codex-responses.ts) sends and the backend
 * has required in the past. Three things the backend insists on, per
 * pi and opencode: `store: false`, `stream: true`, and no output-token
 * cap (`max_output_tokens` is refused), so none is ever sent.
 */

/** Used when the request carries no system text of its own (pi's fallback). */
export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export interface ChatgptBodyOptions {
  model: string;
  nameEscape?: (qualifiedName: string) => string;
}

type ResponsesItem = Record<string, unknown>;

/** The history escape: the request's own wire name where the adapter renamed a tool. */
function historyEscape(
  escape: (name: string) => string,
  wireNames: ReadonlyMap<string, string> | undefined,
): (name: string) => string {
  if (!wireNames || wireNames.size === 0) return escape;
  return (name) => wireNames.get(name) ?? escape(name);
}

export function buildChatgptResponsesBody(
  request: CompletionRequest,
  options: ChatgptBodyOptions,
): Record<string, unknown> {
  const filtered = filterCloudCompletionRequest(request);
  const tools = (filtered.tools ?? []).map(toResponsesTool).filter((t): t is ResponsesItem => t !== null);
  let instructions = DEFAULT_INSTRUCTIONS;
  let input: ResponsesItem[];
  if (filtered.messages && tools.length > 0) {
    const chat = buildNativeMessages(filtered.messages, {
      nameEscape: historyEscape(options.nameEscape ?? defaultNameEscape, filtered.toolWireNames),
    });
    const [first, ...rest] = chat;
    if (first?.role === "system" && typeof first.content === "string" && first.content.length > 0) {
      instructions = first.content;
      input = rest.flatMap(chatMessageToItems);
    } else {
      input = chat.flatMap(chatMessageToItems);
    }
  } else {
    input = [userText(filtered.prompt)];
  }

  const effort = filtered.reasoningOverride ?? filtered.reasoningEffort;
  const body: Record<string, unknown> = {
    model: options.model,
    instructions,
    input,
    tool_choice: "auto",
    parallel_tool_calls: filtered.parallelToolCalls ?? true,
    reasoning: { summary: "auto", ...(effort ? { effort } : {}) },
    store: false,
    stream: true,
    include: [],
  };
  if (tools.length > 0) body.tools = tools;
  if (typeof filtered.sessionId === "string" && filtered.sessionId.length > 0) {
    body.prompt_cache_key = filtered.sessionId;
  }
  // Structured outputs: the Responses spelling of `response_format`.
  // Only without tools, as the chat-completions builder does.
  if (tools.length === 0 && filtered.responseFormat) {
    const format = filtered.responseFormat;
    body.text = {
      format: {
        type: "json_schema",
        name: format.name,
        schema: format.schema,
        strict: format.strict ?? true,
        ...(format.description ? { description: format.description } : {}),
      },
    };
  }
  if (request.modelMode?.mode === "cloud" && request.contextBudget) {
    assertContextCapacity(
      { instructions: body.instructions, input: body.input, tools: body.tools, text: body.text },
      request.contextBudget,
    );
  }
  return body;
}

function userText(text: string): ResponsesItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** One chat-completions message as Responses input items. */
export function chatMessageToItems(message: OpenAiChatMessage): ResponsesItem[] {
  const role = message.role;
  const text = typeof message.content === "string" ? message.content : "";
  switch (role) {
    case "system":
    case "developer":
      return text ? [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }] : [];
    case "user":
      return [userText(text)];
    case "assistant": {
      const out: ResponsesItem[] = [];
      if (text) {
        out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
        const id = (call as { id?: unknown }).id;
        if (typeof fn?.name !== "string" || typeof id !== "string") continue;
        out.push({
          type: "function_call",
          call_id: id,
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        });
      }
      return out;
    }
    case "tool": {
      const callId = message.tool_call_id;
      if (typeof callId !== "string") return text ? [userText(text)] : [];
      return [{ type: "function_call_output", call_id: callId, output: text }];
    }
    default:
      return text ? [userText(text)] : [];
  }
}

/**
 * `{ type: "function", function: { name, description, parameters, strict } }`
 * (what `openAiToolCallAdapter` builds) as a Responses function tool.
 * `strict` is spelled out: the Responses API defaults it to true, and
 * Codex sends `false` unless a tool asked for it.
 */
export function toResponsesTool(tool: Record<string, unknown>): ResponsesItem | null {
  if (tool.type !== "function") return null;
  const fn = tool.function as Record<string, unknown> | undefined;
  if (!fn || typeof fn.name !== "string") return null;
  return {
    type: "function",
    name: fn.name,
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    parameters: fn.parameters ?? { type: "object", properties: {} },
    strict: fn.strict === true,
  };
}

/** One SSE event: its `event:` name (if any) and the joined `data:` lines. */
export interface SseEvent {
  event?: string;
  data: string;
}

/** Splits an SSE byte stream into events. Comments and `id:`/`retry:` are ignored. */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;
  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const event: SseEvent = { data: dataLines.join("\n"), ...(eventName ? { event: eventName } : {}) };
    dataLines = [];
    eventName = undefined;
    return event;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line === "") {
          const event = flush();
          if (event) yield event;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        }
        newline = buffer.search(/\r?\n/);
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** A failure the backend reported inside a 200 stream. */
export interface ChatgptStreamFailure {
  kind: "failed" | "error" | "content_filter";
  message: string;
  code?: string;
}

/** What one parsed event changes; the provider folds these into a result. */
export type ChatgptStreamStep =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool_call"; call: OpenAiToolCall }
  | { kind: "message_text"; text: string }
  | { kind: "created"; id: string }
  | { kind: "rate_limits"; windows: RateLimitWindow[] }
  | {
      kind: "done";
      incompleteReason?: string;
      usage?: CompletionUsage;
      model?: string;
    }
  | { kind: "failure"; failure: ChatgptStreamFailure }
  | { kind: "ignore" };

const MAX_ERROR_TEXT = 300;

/** Reads one SSE data payload. Event names follow codex-rs/codex-api/src/sse/responses.rs. */
export function parseChatgptEvent(data: string, now: number = Date.now()): ChatgptStreamStep {
  if (data === "[DONE]") return { kind: "ignore" };
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return { kind: "ignore" };
    event = parsed as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }
  switch (event.type) {
    case "response.output_text.delta":
      return typeof event.delta === "string" ? { kind: "text", delta: event.delta } : { kind: "ignore" };
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return typeof event.delta === "string" ? { kind: "reasoning", delta: event.delta } : { kind: "ignore" };
    case "response.output_item.done":
      return outputItemDone(event.item);
    case "response.created": {
      const id = (event.response as { id?: unknown } | undefined)?.id;
      return typeof id === "string" ? { kind: "created", id } : { kind: "ignore" };
    }
    case "codex.rate_limits":
      return { kind: "rate_limits", windows: parseCodexRateLimitsPayload(event.rate_limits, now) };
    case "response.completed":
    case "response.incomplete": {
      const response = (event.response ?? {}) as Record<string, unknown>;
      const reason =
        event.type === "response.incomplete"
          ? stringOr((response.incomplete_details as { reason?: unknown } | undefined)?.reason, "unknown")
          : undefined;
      if (reason === "content_filter") {
        return { kind: "failure", failure: { kind: "content_filter", message: "The reply was stopped by the content filter." } };
      }
      const usage = parseUsage(response.usage);
      return {
        kind: "done",
        ...(reason !== undefined ? { incompleteReason: reason } : {}),
        ...(usage ? { usage } : {}),
        ...(typeof response.model === "string" ? { model: response.model } : {}),
      };
    }
    case "response.failed": {
      const error = (event.response as { error?: unknown } | undefined)?.error;
      return { kind: "failure", failure: { kind: "failed", ...errorFields(error) } };
    }
    case "error":
      return { kind: "failure", failure: { kind: "error", ...errorFields(event.error ?? event) } };
    default:
      return { kind: "ignore" };
  }
}

function outputItemDone(item: unknown): ChatgptStreamStep {
  if (typeof item !== "object" || item === null) return { kind: "ignore" };
  const it = item as Record<string, unknown>;
  if (it.type === "function_call" && typeof it.name === "string") {
    const id = typeof it.call_id === "string" ? it.call_id : typeof it.id === "string" ? it.id : undefined;
    return {
      kind: "tool_call",
      call: {
        ...(id ? { id } : {}),
        type: "function",
        function: { name: it.name, arguments: typeof it.arguments === "string" ? it.arguments : "{}" },
      },
    };
  }
  if (it.type === "message" && Array.isArray(it.content)) {
    const text = it.content
      .map((part) => (part as { type?: unknown; text?: unknown }))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text ? { kind: "message_text", text } : { kind: "ignore" };
  }
  return { kind: "ignore" };
}

/** Codex's `ResponseCompletedUsage`: input/output/total, cached under input details. */
function parseUsage(raw: unknown): CompletionUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const input = numberOr(u.input_tokens, 0);
  const output = numberOr(u.output_tokens, 0);
  const cached = (u.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: numberOr(u.total_tokens, input + output),
    ...(typeof cached === "number" ? { cachedTokens: cached } : {}),
  };
}

/** The backend's own short words; capped, and never the request body. */
function errorFields(error: unknown): { message: string; code?: string } {
  if (typeof error !== "object" || error === null) return { message: "unknown error" };
  const e = error as Record<string, unknown>;
  const message = typeof e.message === "string" && e.message.length > 0 ? e.message.slice(0, MAX_ERROR_TEXT) : "unknown error";
  const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : undefined;
  return { message, ...(code ? { code } : {}) };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
