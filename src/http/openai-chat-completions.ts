import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-loop.js";
import type { LlmFailureCategory } from "../llm/reliability/index.js";
import {
  createEmptySessionState,
  type SessionState,
} from "../session/index.js";

import { openaiError } from "./openai-errors.js";
import {
  beginSse,
  readJsonBody,
  sendError,
  sendJson,
  getHeader,
  type HandlerContext,
  type HttpHandler,
  type SseWriter,
} from "./request-context.js";
import { deriveChatSessionId } from "./openai-session-id.js";
import {
  buildFinalAssistantPayload,
  buildStreamChunk,
  buildUsagePayload,
} from "./openai-chunks.js";

export const SESSION_ID_HEADER = "X-Atomic-Session-Id";
export const COMPLETION_ID_HEADER = "X-Atomic-Completion-Id";
/**
 * Opt-in toggle for atomic-agent-specific SSE extensions on the streaming
 * chat-completions endpoint. When absent, the stream is a strict subset of
 * OpenAI's `chat.completion.chunk` protocol so off-the-shelf clients (e.g.
 * Vercel AI SDK) can validate every `data:` frame against their zod schemas
 * without tripping on our named events (`session_id`, `tool_progress`,
 * `usage`). Atomic-native consumers opt in to keep the richer stream.
 */
export const EXTENSIONS_HEADER = "X-Atomic-Extensions";
const MODEL_DEFAULT = "atomic-agent";

/**
 * Body of a `POST /v1/chat/completions` request. Only the OpenAI
 * subset we actually consume is typed — unrecognised fields pass
 * through and are echoed back only where the spec demands it (e.g.
 * `model`).
 */
interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  stream?: boolean;
  session_id?: string;
}

interface ParsedRequest {
  model: string;
  stream: boolean;
  systemPrompt: string | null;
  userMessage: string;
  firstUserMessage: string;
  sessionIdOverride: string | null;
  extensionsEnabled: boolean;
}

/**
 * Handler factory for `POST /v1/chat/completions`. Captures no state —
 * all request-scoped state lives on the returned closure's arguments.
 */
export function createChatCompletionsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const parsed = await parseRequestBody(req, res);
    if (!parsed) return;
    const session = resolveSession(parsed, ctx);
    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);
    if (parsed.stream) {
      await handleStream(req, res, ctx, {
        request: parsed,
        completionId,
        created,
        session,
      });
      return;
    }
    await handleNonStream(req, res, ctx, {
      request: parsed,
      completionId,
      created,
      session,
    });
  };
}

interface TurnEnv {
  request: ParsedRequest;
  completionId: string;
  created: number;
  session: SessionState;
}

/**
 * Non-streaming path: run a full turn, then serialise the final
 * assistant reply into an OpenAI `chat.completion` envelope.
 */
async function handleNonStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
  env: TurnEnv,
): Promise<void> {
  const controller = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  let result: RunTurnResult;
  try {
    // Non-stream mode ignores intermediate events — only the final
    // RunTurnResult matters. The TurnController per-session lock is
    // applied internally by `runtime.runTurn`.
    result = await ctx.runtime.runTurn(env.session, env.request.userMessage, {
      signal: controller.signal,
      origin: "http",
    });
  } catch (err) {
    // Reaches this branch only for unclassified / programming
    // exceptions. Classified terminal failures (`category` ∈
    // `transport`/`grammar`/`model`/`tool`/`cancelled`) come back as
    // `result.session.status === "failed"` instead of throwing — see
    // the next block.
    const message = err instanceof Error ? err.message : String(err);
    sendError(
      res,
      500,
      openaiError(`Internal server error: ${message}`, "server_error"),
    );
    return;
  }
  if (result.session.status === "failed") {
    // Surface classified LLM failures as HTTP 500 (matches the legacy
    // `runTurn`-throws contract that OpenAI clients depend on; an empty
    // body with finish_reason="stop" would silently strand the caller).
    sendError(
      res,
      500,
      openaiError(
        `Agent loop failed: ${result.session.lastError ?? "unknown error"}`,
        "server_error",
      ),
    );
    return;
  }
  const final = buildFinalAssistantPayload(result);
  const usage = buildUsagePayload(result);
  const payload = {
    id: env.completionId,
    object: "chat.completion",
    created: env.created,
    model: env.request.model,
    session_id: result.session.id,
    choices: [
      {
        index: 0,
        message: final.message,
        finish_reason: final.finish_reason,
      },
    ],
    usage,
  };
  sendJson(res, 200, payload, {
    [SESSION_ID_HEADER]: result.session.id,
    [COMPLETION_ID_HEADER]: env.completionId,
  });
}

/**
 * Streaming path: open an SSE response, forward mapped agent-loop
 * events as either OpenAI `chat.completion.chunk` frames (for
 * `content`) or named extension events (for tool progress / errors),
 * then emit the canonical `data: [DONE]` terminator.
 */
async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
  env: TurnEnv,
): Promise<void> {
  const sse = beginSse(res, {
    [SESSION_ID_HEADER]: env.session.id,
    [COMPLETION_ID_HEADER]: env.completionId,
  });
  const controller = new AbortController();
  ctx.completionRegistry.register({
    completionId: env.completionId,
    sessionId: env.session.id,
    controller,
    startedAt: Date.now(),
  });
  req.on("close", () => {
    if (!controller.signal.aborted) controller.abort();
  });
  sse.writeEvent(
    null,
    buildStreamChunk({
      completionId: env.completionId,
      created: env.created,
      model: env.request.model,
      delta: { role: "assistant" },
    }),
  );
  if (env.request.extensionsEnabled) {
    sse.writeEvent("session_id", {
      id: env.completionId,
      object: "chat.completion.session",
      created: env.created,
      model: env.request.model,
      session_id: env.session.id,
    });
  }

  const hook = buildStreamEventHook(sse, env);

  let result: RunTurnResult | null = null;
  let error: Error | null = null;
  try {
    result = await ctx.runtime.runTurn(env.session, env.request.userMessage, {
      signal: controller.signal,
      origin: "http",
      eventHook: hook,
    });
  } catch (err) {
    // Same contract as the non-stream branch above: classified
    // failures land in `result.session.status === "failed"`. This
    // catch only fires for unclassified exceptions.
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    ctx.completionRegistry.unregister(env.completionId);
  }

  if (!error && result?.session.status === "failed") {
    error = new Error(
      `Agent loop failed: ${result.session.lastError ?? "unknown error"}`,
    );
  }

  if (error) {
    emitStreamError(sse, env, error.message);
    sse.writeEvent(
      null,
      buildStreamChunk({
        completionId: env.completionId,
        created: env.created,
        model: env.request.model,
        finishReason: "stop",
      }),
    );
    sse.writeRaw("data: [DONE]\n\n");
    sse.close();
    return;
  }

  const usage = buildUsagePayload(result!);
  const final = buildFinalAssistantPayload(result!);
  if (env.request.extensionsEnabled) {
    sse.writeEvent("usage", {
      id: env.completionId,
      object: "chat.completion.usage",
      created: env.created,
      model: env.request.model,
      session_id: result!.session.id,
      usage,
    });
  }
  sse.writeEvent(
    null,
    buildStreamChunk({
      completionId: env.completionId,
      created: env.created,
      model: env.request.model,
      finishReason: final.finish_reason === "length" ? "length" : "stop",
    }),
  );
  sse.writeRaw("data: [DONE]\n\n");
  sse.close();
}

/**
 * Translate `AgentLoopEvent`s into SSE frames. Only the events that a
 * chat client can reasonably render are forwarded:
 *  - `tool_call_parsed` → `event: tool_progress` (extensions opt-in only)
 *  - `assistant_delta` / `assistant_reply` → OpenAI content delta chunk.
 *    When the stream parser already emitted incremental deltas we skip the
 *    terminal `assistant_reply` to avoid duplicating the body in the
 *    client transcript.
 *  - `reasoning_delta` → `event: reasoning_progress` (extensions opt-in
 *    only)
 *  - `step_error` / `loop_failed` → `emitStreamError` (shape depends on
 *    whether extensions are opted in)
 *
 * Internal step/turn lifecycle events are intentionally suppressed to
 * keep the public stream OpenAI-clean.
 */
function buildStreamEventHook(
  sse: SseWriter,
  env: TurnEnv,
): (event: AgentLoopEvent) => void {
  let streamedAssistantDelta = false;
  return (event) => {
    if (sse.closed) return;
    if (event.type === "llm_event") {
      const inner = event.event;
      if (inner.type === "tool_call_parsed") {
        if (!env.request.extensionsEnabled) return;
        const args = inner.call.args ?? {};
        const label = safeStringify(args).slice(0, 120);
        sse.writeEvent("tool_progress", {
          id: env.completionId,
          object: "chat.completion.tool_progress",
          created: env.created,
          model: env.request.model,
          session_id: env.session.id,
          tool: inner.call.tool,
          label,
        });
      } else if (inner.type === "assistant_delta") {
        if (inner.text.length === 0) return;
        streamedAssistantDelta = true;
        sse.writeEvent(
          null,
          buildStreamChunk({
            completionId: env.completionId,
            created: env.created,
            model: env.request.model,
            delta: { content: inner.text },
          }),
        );
      } else if (inner.type === "reasoning_delta") {
        if (!env.request.extensionsEnabled) return;
        if (inner.text.length === 0) return;
        sse.writeEvent("reasoning_progress", {
          id: env.completionId,
          object: "chat.completion.reasoning_progress",
          created: env.created,
          model: env.request.model,
          session_id: env.session.id,
          step_index: inner.stepIndex,
          text: inner.text,
        });
      } else if (inner.type === "assistant_reply") {
        if (streamedAssistantDelta) return;
        sse.writeEvent(
          null,
          buildStreamChunk({
            completionId: env.completionId,
            created: env.created,
            model: env.request.model,
            delta: { content: inner.text },
          }),
        );
      } else if (inner.type === "step_error") {
        emitStreamError(sse, env, inner.error.message, inner.category);
      }
      return;
    }
    if (event.type === "loop_failed") {
      emitStreamError(sse, env, event.error.message, event.category);
    }
  };
}

/**
 * Shape-switching error emitter. Atomic-native clients (extensions opt-in)
 * receive a named `event: error` frame carrying the bare message — same as
 * before, preserved for backwards compatibility. OpenAI-compatible clients
 * receive an unnamed `data:` frame with the canonical OpenAI error envelope
 * (`{ error: { message, type, param, code } }`) so strict schema validators
 * (Vercel AI SDK, OpenAI Node SDK) don't blow up on mid-stream failures.
 */
function emitStreamError(
  sse: SseWriter,
  env: TurnEnv,
  message: string,
  category?: LlmFailureCategory,
): void {
  if (env.request.extensionsEnabled) {
    sse.writeEvent("error", {
      error: message,
      ...(category ? { category } : {}),
    });
    return;
  }
  // OpenAI-compatible clients don't know about our taxonomy, but the
  // `type` field in their error envelope is already a loose string —
  // surface the category there so structured clients can still branch on
  // it without breaking schema-strict ones.
  sse.writeEvent(
    null,
    openaiError(message, category ? `agent.${category}` : "server_error"),
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pull the body, run the OpenAI-shape validators, and distil it down
 * to the shape the turn executor consumes. Rejections are written to
 * `res` with OpenAI-style envelopes; the caller aborts on `null`.
 */
async function parseRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ParsedRequest | null> {
  let body: ChatCompletionRequest;
  try {
    body = await readJsonBody<ChatCompletionRequest>(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 400, openaiError(`Invalid JSON in request body: ${message}`));
    return null;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendError(res, 400, openaiError("Missing or invalid 'messages' field"));
    return null;
  }

  let systemPrompt: string | null = null;
  const conversation: Array<{ role: string; content: string }> = [];
  for (const raw of body.messages) {
    const role = typeof raw?.role === "string" ? raw.role : "";
    const content = typeof raw?.content === "string" ? raw.content : "";
    if (role === "system") {
      systemPrompt =
        systemPrompt === null ? content : `${systemPrompt}\n${content}`;
    } else if (role === "user" || role === "assistant") {
      conversation.push({ role, content });
    }
  }
  const lastUser = [...conversation].reverse().find((m) => m.role === "user");
  if (!lastUser || lastUser.content.length === 0) {
    sendError(res, 400, openaiError("No user message found in messages"));
    return null;
  }
  const firstUser = conversation.find((m) => m.role === "user");
  const sessionIdOverride =
    (typeof body.session_id === "string" && body.session_id.length > 0
      ? body.session_id
      : null) ?? getHeader(req, SESSION_ID_HEADER);
  if (sessionIdOverride && /[\r\n\x00]/.test(sessionIdOverride)) {
    sendError(res, 400, openaiError("Invalid session ID"));
    return null;
  }
  return {
    model: typeof body.model === "string" && body.model.length > 0
      ? body.model
      : MODEL_DEFAULT,
    stream: Boolean(body.stream),
    systemPrompt,
    userMessage: lastUser.content,
    firstUserMessage: firstUser?.content ?? lastUser.content,
    sessionIdOverride,
    extensionsEnabled: isExtensionsHeaderTruthy(getHeader(req, EXTENSIONS_HEADER)),
  };
}

/**
 * Accept the usual set of "on" spellings for the opt-in header so callers
 * don't have to memorise an exact literal. Anything else — including the
 * header being absent — disables extensions and keeps the stream vanilla
 * OpenAI.
 */
function isExtensionsHeaderTruthy(value: string | null): boolean {
  if (value === null) return false;
  const normalised = value.trim().toLowerCase();
  return normalised === "1" || normalised === "true" || normalised === "on" || normalised === "yes";
}

/**
 * Load an existing session by explicit id, or derive a stable id from
 * the (system, firstUser) pair and hydrate-or-create the matching
 * session. The derived-id mode mirrors hermes-agent so the same
 * opening prompt always resumes the same chat.
 */
function resolveSession(
  parsed: ParsedRequest,
  ctx: HandlerContext,
): SessionState {
  const desiredId =
    parsed.sessionIdOverride ??
    deriveChatSessionId(parsed.systemPrompt, parsed.firstUserMessage);
  const existing = ctx.runtime.sessionStore.load(desiredId);
  if (existing) return existing;
  const state = createEmptySessionState({
    id: desiredId,
    workingDir: ctx.runtime.capabilities.workingDir,
    metadata: { source: "openai-chat", model: parsed.model },
  });
  ctx.runtime.sessionStore.save(state);
  return state;
}

function makeCompletionId(): string {
  const hex = randomUUID().replace(/-/g, "");
  return `chatcmpl-${hex.slice(0, 29)}`;
}
