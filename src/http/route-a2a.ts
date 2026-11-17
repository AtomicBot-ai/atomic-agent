/**
 * A2A (Agent2Agent protocol, v0.3) on `atag serve` (ATO-693): another
 * agent finds this one through its agent card and hands it tasks.
 *
 * Off unless serve is started with `--a2a` (or ATOMIC_AGENT_SERVE_A2A=1),
 * and serve refuses `--a2a` without an API key (serve-args.ts). With it on:
 *
 *  - `GET /.well-known/agent-card.json` answers the AgentCard. Public, as
 *    the spec expects of the well-known card; it names the endpoint and
 *    the auth to use and nothing about this machine beyond that.
 *  - `POST /api/a2a` is the JSON-RPC 2.0 endpoint, behind the same API key
 *    check as every `/api` route. It answers `message/send`, `tasks/get`
 *    and `tasks/cancel`; the rest of the spec's methods (streaming, push
 *    notifications, resubscribe, the extended card) answer
 *    UnsupportedOperationError for now.
 *
 * Mapping onto our own machinery: an A2A task is a row in the task store
 * (`/api/tasks`), an A2A `contextId` is the session that row runs in. A
 * remote agent only ever sees tasks and sessions A2A itself opened
 * (session `metadata.source === "a2a"`), never the person's own chats.
 * The run goes through the task runner, so budgets, retries and approval
 * prompts on `GET /api/events` behave as they do for any HTTP task.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { previousReplyText } from "../prompt/request-section.js";
import { TaskValidationError, type TaskRecord, type TaskStatus } from "../tasks/index.js";
import { getAppVersion } from "../version.js";

import type { RouteDefinition } from "./http-server.js";
import {
  getHeader,
  onClientGone,
  readRawBody,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export const A2A_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_RPC_PATH = "/api/a2a";

/** Session metadata `source` of every chat A2A opens. */
export const A2A_SESSION_SOURCE = "a2a";

/** How long a `blocking: true` message/send waits before answering the task as it stands. */
export const A2A_BLOCKING_WAIT_MS = 120_000;
const BLOCKING_POLL_MS = 250;

export interface A2aOptions {
  /**
   * The address other agents reach this server at, e.g.
   * `https://agent.example.com`, when it sits behind a proxy or tunnel.
   * Without it the card is built from the request's Host header.
   */
  publicUrl?: string | null;
}

// JSON-RPC 2.0 and A2A error codes (spec section 8).
export const A2A_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
} as const;

/** Methods in the A2A spec this slice does not implement yet. */
const KNOWN_UNSUPPORTED_METHODS = new Set([
  "message/stream",
  "tasks/resubscribe",
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
  "agent/getAuthenticatedExtendedCard",
]);

type JsonRpcId = string | number | null;

interface A2aTextPart {
  kind: "text";
  text: string;
}

interface A2aMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2aTextPart[];
  taskId?: string;
  contextId?: string;
}

export type A2aTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface A2aTask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: A2aTaskState; message?: A2aMessage; timestamp?: string };
  artifacts?: Array<{ artifactId: string; name?: string; parts: A2aTextPart[] }>;
  history?: A2aMessage[];
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The AgentCard (spec section 5.5). `baseUrl` has no trailing slash.
 * One generic skill: the agent takes any plain-text task; listing the
 * installed skills belongs on the authenticated extended card, later.
 */
export function buildAgentCard(baseUrl: string, version: string = getAppVersion()): Record<string, unknown> {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Atomic Agent",
    description:
      "A local AI agent that runs on its owner's machine. Send it a task in plain text; " +
      "it works on it with its own tools and answers with the result.",
    url: `${baseUrl}${A2A_RPC_PATH}`,
    preferredTransport: "JSONRPC",
    version,
    documentationUrl: "https://atomicagent.io/docs",
    provider: { organization: "AtomicBot", url: "https://atomicagent.io" },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    // Same key as the rest of `atag serve`: a bearer token, or `x-api-key`.
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "The serve API key (--api-key / ATOMIC_AGENT_API_KEY) as a bearer token.",
      },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "The same serve API key in the x-api-key header.",
      },
    },
    security: [{ bearer: [] }, { apiKey: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "general-task",
        name: "General task",
        description:
          "Carry out a task described in plain text: research, writing, coding and file work on the owner's machine.",
        tags: ["general", "agent", "local"],
        examples: ["Summarise the README in the project folder", "Draft a reply to this message"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    ],
    supportsAuthenticatedExtendedCard: false,
  };
}

/** Where callers reach this server: the configured public URL, else the request's own Host. */
export function requestBaseUrl(req: IncomingMessage, publicUrl?: string | null): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const host = getHeader(req, "host") ?? "127.0.0.1";
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  return `${encrypted ? "https" : "http"}://${host}`;
}

export function createAgentCardHandler(options: A2aOptions = {}): HttpHandler {
  return async (req, res) => {
    sendJson(res, 200, buildAgentCard(requestBaseUrl(req, options.publicUrl)));
  };
}

/** The two A2A routes, for `buildRouteTable` when A2A is on. */
export function a2aRoutes(options: A2aOptions = {}): RouteDefinition[] {
  return [
    { method: "GET", path: A2A_CARD_PATH, handler: createAgentCardHandler(options), requiresAuth: false },
    { method: "POST", path: A2A_RPC_PATH, handler: createA2aRpcHandler() },
  ];
}

/** `POST /api/a2a`: one JSON-RPC 2.0 request in, one response out (HTTP 200 either way). */
export function createA2aRpcHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const raw = await readRawBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      sendRpcError(res, null, A2A_ERRORS.parseError, "Invalid JSON");
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendRpcError(res, null, A2A_ERRORS.invalidRequest, "Expected one JSON-RPC 2.0 request object (batches are not supported)");
      return;
    }
    const request = body as Record<string, unknown>;
    const id = rpcId(request.id);
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      sendRpcError(res, id, A2A_ERRORS.invalidRequest, "jsonrpc must be \"2.0\" and method a string");
      return;
    }
    const params = request.params;
    try {
      const result = await dispatchMethod(request.method, params, res, ctx);
      if (res.writableEnded || res.destroyed) return;
      sendJson(res, 200, { jsonrpc: "2.0", id, result });
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof RpcError) {
        sendRpcError(res, id, err.code, err.message);
        return;
      }
      sendRpcError(res, id, A2A_ERRORS.internalError, err instanceof Error ? err.message : String(err));
    }
  };
}

async function dispatchMethod(
  method: string,
  params: unknown,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<A2aTask> {
  if (method === "message/send" || method === "tasks/get" || method === "tasks/cancel") {
    if (!ctx.runtime.config.tasks.enabled) {
      throw new RpcError(A2A_ERRORS.unsupportedOperation, "This agent's tasks subsystem is disabled (tasks.enabled)");
    }
  }
  switch (method) {
    case "message/send":
      return messageSend(params, res, ctx);
    case "tasks/get":
      return tasksGet(params, ctx);
    case "tasks/cancel":
      return tasksCancel(params, ctx);
    default:
      if (KNOWN_UNSUPPORTED_METHODS.has(method)) {
        throw new RpcError(
          method.startsWith("tasks/pushNotificationConfig/")
            ? A2A_ERRORS.pushNotificationNotSupported
            : A2A_ERRORS.unsupportedOperation,
          `${method} is not supported by this agent yet`,
        );
      }
      throw new RpcError(A2A_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

export interface ParsedSendParams {
  text: string;
  messageId: string;
  contextId: string | null;
  blocking: boolean;
  historyLength: number | null;
}

/** Validate `MessageSendParams`; throws an RpcError with the spec's code when refused. */
export function parseSendParams(params: unknown): ParsedSendParams {
  if (!isObject(params) || !isObject(params.message)) {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.message is required");
  }
  const message = params.message;
  if (message.role !== "user") {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.message.role must be \"user\"");
  }
  if (typeof message.messageId !== "string" || message.messageId.length === 0) {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.message.messageId is required");
  }
  if (message.taskId !== undefined) {
    // Continuing a task (input-required) needs the turn to stop and ask; not in this slice.
    throw new RpcError(
      A2A_ERRORS.unsupportedOperation,
      "Continuing an existing task is not supported yet; send a new message with the same contextId",
    );
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.message.parts must be a non-empty array");
  }
  const texts: string[] = [];
  for (const part of message.parts) {
    if (!isObject(part) || part.kind !== "text" || typeof part.text !== "string") {
      throw new RpcError(A2A_ERRORS.contentTypeNotSupported, "Only text parts are supported (text/plain)");
    }
    texts.push(part.text);
  }
  const text = texts.join("\n\n").trim();
  if (text.length === 0) {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.message has no text");
  }
  const configuration = isObject(params.configuration) ? params.configuration : {};
  const accepted = configuration.acceptedOutputModes;
  if (
    Array.isArray(accepted) &&
    accepted.length > 0 &&
    !accepted.some((m) => m === "text/plain" || m === "text" || m === "*/*")
  ) {
    throw new RpcError(A2A_ERRORS.contentTypeNotSupported, "This agent only answers text/plain");
  }
  const historyLength =
    typeof configuration.historyLength === "number" && Number.isInteger(configuration.historyLength) && configuration.historyLength >= 0
      ? configuration.historyLength
      : null;
  return {
    text,
    messageId: message.messageId,
    contextId: typeof message.contextId === "string" && message.contextId.length > 0 ? message.contextId : null,
    blocking: configuration.blocking === true,
    historyLength,
  };
}

async function messageSend(
  params: unknown,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<A2aTask> {
  const parsed = parseSendParams(params);
  const { runtime } = ctx;
  // A contextId A2A opened earlier resumes that chat; anything else (unknown, or
  // one of the person's own chats) gets a fresh one, never someone else's session.
  let sessionId: string | null = null;
  if (parsed.contextId && isA2aSession(ctx, parsed.contextId)) sessionId = parsed.contextId;
  if (sessionId === null) {
    const fresh = runtime.createSession({ metadata: { source: A2A_SESSION_SOURCE }, persist: false });
    runtime.sessionStore.save(fresh);
    sessionId = fresh.id;
  }
  let record: TaskRecord;
  try {
    record = runtime.taskRunner.create({
      sessionId,
      userMessage: parsed.text,
      origin: "http",
      maxAttempts: runtime.config.tasks.maxAttempts,
    });
  } catch (err) {
    if (err instanceof TaskValidationError) throw new RpcError(A2A_ERRORS.invalidParams, err.message);
    throw err;
  }
  // Runs as any `/api/tasks` task does: at once with `tasks.runOnCreate` (the
  // default), else when the scheduler or the operator drains it.
  let current: TaskRecord = record;
  if (parsed.blocking) current = await waitForSettled(ctx, record.id, res);
  return toA2aTask(ctx, current, parsed.historyLength, parsed.messageId);
}

function tasksGet(params: unknown, ctx: HandlerContext): A2aTask {
  const id = taskIdParam(params);
  const record = findA2aTask(ctx, id);
  const historyLength =
    isObject(params) && typeof params.historyLength === "number" && params.historyLength >= 0
      ? Math.floor(params.historyLength)
      : null;
  return toA2aTask(ctx, record, historyLength);
}

function tasksCancel(params: unknown, ctx: HandlerContext): A2aTask {
  const id = taskIdParam(params);
  const record = findA2aTask(ctx, id);
  if (isTerminal(record.status)) {
    throw new RpcError(A2A_ERRORS.taskNotCancelable, `Task ${id} is already ${record.status}`);
  }
  const cancelled = ctx.runtime.taskRunner.cancel(id);
  if (!cancelled) throw new RpcError(A2A_ERRORS.taskNotFound, `Task not found: ${id}`);
  return toA2aTask(ctx, cancelled, null);
}

function taskIdParam(params: unknown): string {
  if (!isObject(params) || typeof params.id !== "string" || params.id.length === 0) {
    throw new RpcError(A2A_ERRORS.invalidParams, "params.id is required");
  }
  return params.id;
}

/** A task A2A filed, or TaskNotFound: the person's own tasks are not visible here. */
function findA2aTask(ctx: HandlerContext, id: string): TaskRecord {
  const record = ctx.runtime.taskStore.get(id);
  if (!record || !record.sessionId || !isA2aSession(ctx, record.sessionId)) {
    throw new RpcError(A2A_ERRORS.taskNotFound, `Task not found: ${id}`);
  }
  return record;
}

function isA2aSession(ctx: HandlerContext, sessionId: string): boolean {
  const session = ctx.runtime.sessionStore.load(sessionId);
  return session?.metadata.source === A2A_SESSION_SOURCE;
}

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

/** Poll the row until it settles, the wait runs out, or the caller hangs up. */
async function waitForSettled(
  ctx: HandlerContext,
  taskId: string,
  res: ServerResponse,
): Promise<TaskRecord> {
  let gone = false;
  onClientGone(res, () => {
    gone = true;
  });
  const deadline = Date.now() + A2A_BLOCKING_WAIT_MS;
  let latest = ctx.runtime.taskStore.get(taskId);
  while (latest && !isTerminal(latest.status) && !gone && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, BLOCKING_POLL_MS));
    latest = ctx.runtime.taskStore.get(taskId);
  }
  if (!latest) throw new RpcError(A2A_ERRORS.taskNotFound, `Task not found: ${taskId}`);
  return latest;
}

/** Our task status in the spec's TaskState words. */
export function a2aStateFor(status: TaskStatus): A2aTaskState {
  switch (status) {
    case "pending":
    case "paused":
      return "submitted";
    case "running":
      return "working";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "unknown";
  }
}

function toA2aTask(
  ctx: HandlerContext,
  record: TaskRecord,
  historyLength: number | null,
  requestMessageId?: string,
): A2aTask {
  const contextId = record.sessionId ?? "";
  const state = a2aStateFor(record.status);
  const task: A2aTask = {
    kind: "task",
    id: record.id,
    contextId,
    status: { state, timestamp: new Date(record.updatedAt).toISOString() },
  };
  let reply: A2aMessage | null = null;
  if (state === "completed" && record.sessionId) {
    const session = ctx.runtime.sessionStore.load(record.sessionId);
    const text = session ? previousReplyText(session.turns) : undefined;
    if (text) {
      reply = agentMessage(record, `${record.id}-reply`, text);
      task.status.message = reply;
      task.artifacts = [{ artifactId: `${record.id}-reply`, name: "reply", parts: [{ kind: "text", text }] }];
    }
  } else if (state === "failed" && record.lastError) {
    task.status.message = agentMessage(record, `${record.id}-error`, record.lastError);
  }
  if (historyLength !== 0) {
    const history: A2aMessage[] = [
      {
        kind: "message",
        messageId: requestMessageId ?? `${record.id}-request`,
        role: "user",
        parts: [{ kind: "text", text: record.userMessage }],
        taskId: record.id,
        contextId,
      },
    ];
    if (reply) history.push(reply);
    task.history = historyLength === null ? history : history.slice(-historyLength);
  }
  return task;
}

function agentMessage(record: TaskRecord, messageId: string, text: string): A2aMessage {
  return {
    kind: "message",
    messageId,
    role: "agent",
    parts: [{ kind: "text", text }],
    taskId: record.id,
    contextId: record.sessionId ?? "",
  };
}

function sendRpcError(res: ServerResponse, id: JsonRpcId, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function rpcId(raw: unknown): JsonRpcId {
  return typeof raw === "string" || typeof raw === "number" ? raw : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
