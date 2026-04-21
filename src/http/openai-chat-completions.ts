import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-loop.js";
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
    result = await ctx.turnHub.runExclusive(
      // Non-stream mode ignores intermediate events — only the final
      // RunTurnResult matters. We still install an empty hook so the
      // hub's "no-hook active" state does not drop events silently
      // (harmless, but makes the contract uniform).
      () => undefined,
      () => ctx.runtime.runTurn(env.session, env.request.userMessage, {
        signal: controller.signal,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(
      res,
      500,
      openaiError(`Internal server error: ${message}`, "server_error"),
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
  sse.writeEvent("session_id", {
    id: env.completionId,
    object: "chat.completion.session",
    created: env.created,
    model: env.request.model,
    session_id: env.session.id,
  });

  const hook = buildStreamEventHook(sse, env);

  let result: RunTurnResult | null = null;
  let error: Error | null = null;
  try {
    result = await ctx.turnHub.runExclusive(hook, () =>
      ctx.runtime.runTurn(env.session, env.request.userMessage, {
        signal: controller.signal,
      }),
    );
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    ctx.completionRegistry.unregister(env.completionId);
  }

  if (error) {
    sse.writeEvent("error", { error: error.message });
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
  sse.writeEvent("usage", {
    id: env.completionId,
    object: "chat.completion.usage",
    created: env.created,
    model: env.request.model,
    session_id: result!.session.id,
    usage,
  });
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
 *  - `tool_call_parsed` → `event: tool_progress`
 *  - `assistant_reply`  → OpenAI content delta chunk
 *  - `step_error` / `loop_failed` → `event: error`
 *
 * Internal step/turn lifecycle events are intentionally suppressed to
 * keep the public stream OpenAI-clean.
 */
function buildStreamEventHook(
  sse: SseWriter,
  env: TurnEnv,
): (event: AgentLoopEvent) => void {
  return (event) => {
    if (sse.closed) return;
    if (event.type === "llm_event") {
      const inner = event.event;
      if (inner.type === "tool_call_parsed") {
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
      } else if (inner.type === "assistant_reply") {
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
        sse.writeEvent("error", { error: inner.error.message });
      }
      return;
    }
    if (event.type === "loop_failed") {
      sse.writeEvent("error", { error: event.error.message });
    }
  };
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
  };
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
