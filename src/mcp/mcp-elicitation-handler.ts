/**
 * MCP elicitation handler.
 *
 * An MCP server can ask the *person* for input mid-call through
 * `elicitation/create`: pick an account, confirm an action, fill a
 * small form. This file turns that request into a neutral question for
 * an injectable "ask the human" port and turns the reply back into the
 * protocol's `{ action, content }` result.
 *
 * Locked invariants (docs/client.md):
 *   1. Never auto-accept. `accept` only ever comes from the port, i.e.
 *      from a person. Every failure path answers `decline` or `cancel`.
 *   2. The turn does not break. Nothing here throws back into the SDK:
 *      a malformed form, a missing surface, a timeout or a port crash
 *      all become a normal result the server can handle.
 *   3. Answers never reach logs or traces. Only the server name, the
 *      action and the field count are logged; validation reasons name
 *      fields, never values.
 *   4. Form mode only. URL mode (`mode: "url"`) is declined: the client
 *      advertises `elicitation: {}`, which the spec reads as form-only.
 *   5. How long to wait depends on the port's surface: no deadline for
 *      a person at the screen, 5 minutes for a remote chat, none at all
 *      (decline at once) when nobody is there.
 *
 * This file does not import `@modelcontextprotocol/sdk`; mcp-client.ts
 * hands it the raw params and forwards the result unchanged.
 */

import type { StructuredLogger } from "../tracing/structured-logger.js";

import { validateElicitationAnswer } from "./mcp-elicitation-answer.js";
import {
  parseElicitationSchema,
  type McpElicitationField,
  type McpElicitationValue,
} from "./mcp-elicitation-schema.js";

/** What a surface shows the person. */
export interface McpElicitationQuestion {
  /** Configured name of the MCP server that is asking. Show it: the person must know who asks. */
  server: string;
  /** The server's own message, trimmed to `MAX_MESSAGE_CHARS`. */
  message: string;
  /** Empty for a plain "confirm?" question. */
  fields: McpElicitationField[];
}

/**
 * What the person did. `unavailable` means nobody can be asked right
 * now: no surface is attached, the session is unattended (a cron task,
 * a heartbeat, an overnight run), or the surface cannot render the
 * form. It is answered as `decline`.
 */
export type McpElicitationReply =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" }
  | { action: "unavailable"; reason?: string };

/**
 * Who, if anyone, can answer through a port right now. It sets how
 * long the handler waits:
 *
 * - `interactive`: a person is at the screen (desktop, TUI). No
 *   deadline: the question stays until it is answered; Esc / Decline
 *   is the answer. The wait still ends when the server cancels its
 *   request or the connection closes.
 * - `remote-chat`: a chat bridge (Telegram, Discord) where the person
 *   may not be looking. Waits `remoteChatTimeoutMs` (5 minutes), then
 *   declines.
 * - `none`: nobody is there (cron task, heartbeat, headless or
 *   overnight run). Declined at once, the port is not asked.
 */
export type McpElicitationSurface = "interactive" | "remote-chat" | "none";

/**
 * The "ask the human" port. A host (TUI, desktop, a chat bridge)
 * implements it. `surface` is fixed, or a function the handler calls
 * for every request so a host can say `none` while only background
 * work is running. `ask` must resolve, or settle on `signal` abort.
 */
export interface McpElicitationPort {
  surface: McpElicitationSurface | (() => McpElicitationSurface);
  ask(question: McpElicitationQuestion, signal: AbortSignal): Promise<McpElicitationReply>;
}

/** The protocol result, structurally the SDK's `ElicitResult`. */
// A type alias, not an interface: the SDK's result type carries an
// index signature that an interface would not satisfy.
export type McpElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, McpElicitationValue>;
};

/** Installed by McpClient as the `elicitation/create` request handler. */
export type McpElicitationHandler = (
  params: unknown,
  signal: AbortSignal,
) => Promise<McpElicitationResult>;

export interface CreateMcpElicitationHandlerDeps {
  port: McpElicitationPort;
  /** Configured server name, shown to the person and used in logs. */
  server: string;
  logger?: StructuredLogger;
  /**
   * How long a `remote-chat` surface waits before declining. Default
   * `DEFAULT_ELICITATION_TIMEOUT_MS`. An `interactive` surface has no
   * deadline; `none` never waits.
   */
  remoteChatTimeoutMs?: number;
}

/** How long a remote chat (Telegram, Discord) waits for the person. */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 5 * 60_000;
export const MAX_MESSAGE_CHARS = 2_000;

export function createMcpElicitationHandler(
  deps: CreateMcpElicitationHandlerDeps,
): McpElicitationHandler {
  const remoteChatTimeoutMs = deps.remoteChatTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS;
  const log = (action: McpElicitationResult["action"], why: string, fields = 0): void => {
    deps.logger?.info("mcp.elicitation", { server: deps.server, action, why, fields });
  };

  return async (params, signal) => {
    if (!isRecord(params) || typeof params.message !== "string") {
      log("decline", "malformed_request");
      return { action: "decline" };
    }
    if (params.mode !== undefined && params.mode !== "form") {
      log("decline", "unsupported_mode");
      return { action: "decline" };
    }
    const parsed = parseElicitationSchema(params.requestedSchema);
    if (!parsed.ok) {
      log("decline", `invalid_schema: ${parsed.reason}`);
      return { action: "decline" };
    }
    const fields = parsed.value;
    const surface = surfaceOf(deps.port);
    if (surface === "none") {
      log("decline", "no_human", fields.length);
      return { action: "decline" };
    }
    const question: McpElicitationQuestion = {
      server: deps.server,
      message: clip(params.message, MAX_MESSAGE_CHARS),
      fields,
    };

    const timeoutMs = surface === "remote-chat" ? remoteChatTimeoutMs : null;
    const reply = await askWithDeadline(deps.port, question, signal, timeoutMs);
    switch (reply.action) {
      case "timeout":
        log("decline", "timeout", fields.length);
        return { action: "decline" };
      case "aborted":
        log("cancel", "server_cancelled", fields.length);
        return { action: "cancel" };
      case "failed":
        log("decline", "surface_error", fields.length);
        return { action: "decline" };
      case "unavailable":
        log("decline", "no_human", fields.length);
        return { action: "decline" };
      case "decline":
      case "cancel":
        log(reply.action, "person", fields.length);
        return { action: reply.action };
      case "accept": {
        const answer = validateElicitationAnswer(fields, reply.content);
        if (!answer.ok) {
          // A surface bug, not the person's choice: do not send the
          // server something its schema says it cannot take.
          log("cancel", `invalid_answer: ${answer.reason}`, fields.length);
          return { action: "cancel" };
        }
        log("accept", "person", fields.length);
        return { action: "accept", content: answer.value };
      }
      default:
        log("decline", "unknown_reply", fields.length);
        return { action: "decline" };
    }
  };
}

type Outcome =
  | McpElicitationReply
  | { action: "timeout" }
  | { action: "aborted" }
  | { action: "failed" };

/**
 * The port's surface for this request. A throwing or unknown answer is
 * treated as `none`: never wait on a surface that cannot say it exists.
 */
function surfaceOf(port: McpElicitationPort): McpElicitationSurface {
  let surface: unknown;
  try {
    surface = typeof port.surface === "function" ? port.surface() : port.surface;
  } catch {
    return "none";
  }
  return surface === "interactive" || surface === "remote-chat" ? surface : "none";
}

/**
 * Ask the port, but stop waiting on the deadline (when there is one,
 * `timeoutMs` null means none) or when the server cancels its request
 * or the connection closes (both abort `outer`). Either way the port's
 * own signal is aborted so a surface can take the question down.
 */
async function askWithDeadline(
  port: McpElicitationPort,
  question: McpElicitationQuestion,
  outer: AbortSignal,
  timeoutMs: number | null,
): Promise<Outcome> {
  if (outer.aborted) return { action: "aborted" };
  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<Outcome>((resolve) => {
    if (timeoutMs !== null) {
      timer = setTimeout(() => resolve({ action: "timeout" }), timeoutMs);
    }
    onAbort = () => resolve({ action: "aborted" });
    outer.addEventListener("abort", onAbort, { once: true });
  });
  const asked: Promise<Outcome> = Promise.resolve()
    .then(() => port.ask(question, inner.signal))
    .then(
      (reply) => (isReply(reply) ? reply : { action: "failed" as const }),
      () => ({ action: "failed" as const }),
    );
  try {
    return await Promise.race([asked, stop]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) outer.removeEventListener("abort", onAbort);
    inner.abort();
  }
}

function isReply(v: unknown): v is McpElicitationReply {
  if (!isRecord(v)) return false;
  return (
    v.action === "accept" ||
    v.action === "decline" ||
    v.action === "cancel" ||
    v.action === "unavailable"
  );
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
