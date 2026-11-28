import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";
import type { ServerResponse } from "node:http";
import { secretInputMasked, type ShellJobHostControls } from "../tools/os/shell/shell-job-host.js";

/**
 * The agent's kept shell jobs, for hosts that show them (ATO-2485, the
 * desktop's terminal tab): the same jobs `os.shell.run` started, the
 * output as it comes, and the person's own input to an interactive one.
 *
 *   GET  /api/sessions/{id}/shell-jobs                     the jobs, oldest first
 *   GET  /api/sessions/{id}/shell-jobs/{jobId}/output?since=N  output from N
 *   POST /api/sessions/{id}/shell-jobs/{jobId}/input  {text, eof?, secret?}
 *   POST /api/sessions/{id}/shell-jobs/{jobId}/resize {cols, rows}
 *   POST /api/sessions/{id}/shell-jobs/{jobId}/stop
 *
 * The input is the person's: it goes to the job's stdin and nowhere else
 * (not the session, not the transcript, not a log; this file never logs a
 * body). `secret: true` (the host's Hide typing) also masks it in every
 * later tool result and trace, and the answer's `masked` says whether
 * the value could be masked (a short or plain-word one cannot). A paired
 * phone cannot type into a job. An agent without these routes answers
 * 404; a runtime without `shellJobs` answers 404 too, so a host
 * feature-detects with the list.
 */

const RESIZE_MIN = 2;
const RESIZE_MAX = 1_000;

function controlsOf(ctx: HandlerContext, res: ServerResponse): ShellJobHostControls | null {
  const controls = ctx.runtime.shellJobs;
  if (!controls) sendError(res, 404, openaiError("this agent does not expose shell jobs"));
  return controls ?? null;
}

/** `{id, jobId}` from the path, or null after a 400. */
function addressOf(ctx: HandlerContext, res: ServerResponse): { sessionId: string; jobId: number } | null {
  const sessionId = ctx.params.id;
  const jobId = Number(ctx.params.jobId);
  if (!sessionId || !Number.isInteger(jobId) || jobId < 1) {
    sendError(res, 400, openaiError("session id and a job id (a whole number from 1) are required"));
    return null;
  }
  return { sessionId, jobId };
}

async function bodyOf(req: Parameters<HttpHandler>[0], res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody<unknown>(req);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Said below without echoing the body: it may hold what the person typed.
  }
  sendError(res, 400, openaiError("the body must be a JSON object"));
  return null;
}

function notFound(res: ServerResponse, a: { sessionId: string; jobId: number }): void {
  sendError(res, 404, openaiError(`no job ${a.jobId} in session ${a.sessionId}`));
}

export function createListShellJobsHandler(): HttpHandler {
  return (_req, res, ctx) => {
    const sessionId = ctx.params.id;
    if (!sessionId) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const controls = controlsOf(ctx, res);
    if (!controls) return;
    sendJson(res, 200, {
      sessionId,
      jobs: controls.list(sessionId),
      actions: ["output", "input", "resize", "stop"],
    });
  };
}

export function createShellJobOutputHandler(): HttpHandler {
  return (req, res, ctx) => {
    const a = addressOf(ctx, res);
    if (!a) return;
    const controls = controlsOf(ctx, res);
    if (!controls) return;
    const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("since");
    const since = raw === null || raw === "" ? 0 : Number(raw);
    const slice = controls.read(a.sessionId, a.jobId, since);
    if (!slice) {
      notFound(res, a);
      return;
    }
    sendJson(res, 200, { sessionId: a.sessionId, ...slice });
  };
}

export function createShellJobInputHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const a = addressOf(ctx, res);
    if (!a) return;
    if (ctx.pairedDevice) {
      sendError(res, 403, openaiError("a paired phone cannot type into the agent's jobs"));
      return;
    }
    const controls = controlsOf(ctx, res);
    if (!controls) return;
    const body = await bodyOf(req, res);
    if (!body) return;
    const { text, eof, secret } = body;
    if (
      typeof text !== "string" ||
      (eof !== undefined && typeof eof !== "boolean") ||
      (secret !== undefined && typeof secret !== "boolean")
    ) {
      sendError(res, 400, openaiError("text must be a string, and eof and secret, when given, true or false"));
      return;
    }
    if (text.length === 0 && eof !== true) {
      sendError(res, 400, openaiError("nothing to type: text is empty and eof is not set"));
      return;
    }
    const outcome = controls.write(a.sessionId, a.jobId, text, eof === true, { secret: secret === true });
    if (outcome === "not_found") return notFound(res, a);
    if (outcome === "too_long") {
      sendError(res, 413, openaiError("that is too much to type in one go"));
      return;
    }
    if (outcome === "closed") {
      sendError(res, 409, openaiError(`job ${a.jobId} does not take input: it has ended or was not started as a terminal`));
      return;
    }
    sendJson(res, 200, {
      written: true,
      sessionId: a.sessionId,
      jobId: a.jobId,
      ...(secret === true ? { masked: secretInputMasked(text) } : {}),
    });
  };
}

export function createShellJobResizeHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const a = addressOf(ctx, res);
    if (!a) return;
    const controls = controlsOf(ctx, res);
    if (!controls) return;
    const body = await bodyOf(req, res);
    if (!body) return;
    const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= RESIZE_MIN && (n as number) <= RESIZE_MAX;
    if (!ok(body.cols) || !ok(body.rows)) {
      sendError(res, 400, openaiError(`cols and rows must be whole numbers from ${RESIZE_MIN} to ${RESIZE_MAX}`));
      return;
    }
    const outcome = controls.resize(a.sessionId, a.jobId, body.cols, body.rows);
    if (outcome === "not_found") return notFound(res, a);
    // Not an error: the system `script` terminal has a fixed size.
    sendJson(res, 200, { resized: outcome === "resized", sessionId: a.sessionId, jobId: a.jobId });
  };
}

export function createStopShellJobHandler(): HttpHandler {
  return (_req, res, ctx) => {
    const a = addressOf(ctx, res);
    if (!a) return;
    const controls = controlsOf(ctx, res);
    if (!controls) return;
    const outcome = controls.stop(a.sessionId, a.jobId);
    if (outcome === "not_found") return notFound(res, a);
    sendJson(res, 200, { stopped: outcome === "stopped", sessionId: a.sessionId, jobId: a.jobId });
  };
}
