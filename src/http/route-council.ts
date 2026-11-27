import { getConfig, type AtomicAgentConfig } from "../config/index.js";
import { COUNCIL_MAX_QUESTION_CHARS, runRuntimeCouncil, type CouncilRequest } from "../runtime/council-service.js";
import { openaiError } from "./openai-errors.js";
import {
  SSE_HEARTBEAT_MS,
  beginSse,
  onClientGone,
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/council`: the model council for the desktop view and other
 * clients (ATO-2432), the same council as the TUI's `/council` and
 * `models council`: every seat answers, a judge lists Agree / Disagree /
 * Unique, the members rank each other's answers with the names hidden,
 * and a chairman writes the final answer. Nothing is written to any
 * session.
 *
 * Body: `{ question, models?, judge?, chairman?, rank?, max_usd?, dry_run? }`.
 * `models` is the `--models` list (`a,b*2`; absent: the chat's model three
 * times), `chairman: null` skips the chairman, `rank: false` skips the
 * ranking.
 *
 * `dry_run: true` answers JSON `{ cost_line, forecast }` and sends nothing.
 * Otherwise an SSE stream, since a council takes minutes: `forecast`
 * `{ cost_line, forecast }`, then `progress` frames (`runCouncil`'s
 * stages), then one `result` `{ report, cost_line, skipped }` or one
 * `error` `{ message }` (no usable seat, or over `max_usd` before any
 * request), then the stream ends. A client that disconnects aborts every
 * request still running.
 *
 * `400` for a bad body before the stream starts.
 */
export function createCouncilHandler(options: { config?: () => AtomicAgentConfig } = {}): HttpHandler {
  const config = options.config ?? getConfig;
  return async (req, res, ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const parsed = parseCouncilBody(body);
    if ("message" in parsed) {
      sendError(res, 400, openaiError(parsed.message, "invalid_request_error", parsed.param));
      return;
    }
    const completePlain = ctx.runtime.completePlain?.bind(ctx.runtime);
    const deps = { config: config(), ...(completePlain ? { completePlain } : {}) };
    if (body.dry_run === true) {
      const result = await runRuntimeCouncil({ ...parsed, forecastOnly: true }, deps);
      if (!result.ok && !result.forecast) {
        sendError(res, 400, openaiError(result.reason, "invalid_request_error"));
        return;
      }
      sendJson(res, 200, { cost_line: result.costLine, forecast: result.forecast, ...(result.ok ? {} : { refused: result.reason }) });
      return;
    }
    const controller = new AbortController();
    onClientGone(res, () => controller.abort());
    const sse = beginSse(res, {}, { heartbeatMs: SSE_HEARTBEAT_MS });
    try {
      const result = await runRuntimeCouncil(
        {
          ...parsed,
          signal: controller.signal,
          onForecast: (costLine, forecast) => sse.writeEvent("forecast", { cost_line: costLine, forecast }),
          onProgress: (event) => sse.writeEvent("progress", event),
        },
        deps,
      );
      if (result.ok) {
        sse.writeEvent("result", { report: result.report, cost_line: result.costLine, skipped: result.skipped });
      } else {
        sse.writeEvent("error", { message: result.reason, ...(result.skipped ? { skipped: result.skipped } : {}) });
      }
    } catch (err) {
      sse.writeEvent("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      sse.close();
    }
  };
}

/** The council request a body names, or what is wrong with it. Exported for the tests. */
export function parseCouncilBody(
  body: unknown,
): Omit<CouncilRequest, "signal" | "onProgress" | "onForecast" | "forecastOnly"> | { message: string; param?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.question !== "string" || b.question.trim() === "") {
    return { message: "question must be a non-empty string", param: "question" };
  }
  if (b.question.trim().length > COUNCIL_MAX_QUESTION_CHARS) {
    return { message: `question is too long (over ${COUNCIL_MAX_QUESTION_CHARS} characters)`, param: "question" };
  }
  for (const key of ["models", "judge"] as const) {
    if (b[key] !== undefined && b[key] !== null && typeof b[key] !== "string") return { message: `${key} must be a string`, param: key };
  }
  if (b.chairman !== undefined && b.chairman !== null && typeof b.chairman !== "string") {
    return { message: "chairman must be a string or null", param: "chairman" };
  }
  if (b.rank !== undefined && typeof b.rank !== "boolean") return { message: "rank must be a boolean", param: "rank" };
  if (b.max_usd !== undefined && (typeof b.max_usd !== "number" || !Number.isFinite(b.max_usd) || b.max_usd < 0)) {
    return { message: "max_usd must be a non-negative number", param: "max_usd" };
  }
  return {
    question: b.question.trim(),
    ...(typeof b.models === "string" && b.models.trim() !== "" ? { models: b.models } : {}),
    ...(typeof b.judge === "string" && b.judge.trim() !== "" ? { judge: b.judge } : {}),
    ...(b.chairman === null ? { chairman: null } : typeof b.chairman === "string" && b.chairman.trim() !== "" ? { chairman: b.chairman } : {}),
    ...(typeof b.rank === "boolean" ? { rank: b.rank } : {}),
    ...(typeof b.max_usd === "number" ? { maxUsd: b.max_usd } : {}),
  };
}
