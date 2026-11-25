import { getConfig } from "../config/index.js";
import {
  answerAppendLocalQuestion,
  inspectAppendLocalQuestion,
  type AppendLocalQuestionPaths,
} from "../runtime/append-local-question.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * ATO-1461: the one-time "Local model is set as your last-resort
 * fallback. Keep it?" question, for the desktop. The TUI asks the same
 * question from the same files (`runtime/append-local-question.ts`), so an
 * answer given in either one is not asked again in the other.
 */
function questionPaths(): AppendLocalQuestionPaths {
  const config = getConfig();
  return { userConfigFile: config.paths.userConfigFile, stateDir: config.paths.stateDir };
}

/**
 * `GET /api/fallback/local-question` — `{ question, detail, appendLocal,
 * answer }`. `question` is null when there is nothing to ask: the switch
 * is off, or the person answered already.
 */
export function createFallbackLocalQuestionStatusHandler(): HttpHandler {
  return async (_req, res) => {
    sendJson(res, 200, inspectAppendLocalQuestion(questionPaths()));
  };
}

/**
 * `POST /api/fallback/local-question` with `{ answer: "keep" | "off" }` —
 * remember the answer. "off" writes `llm.fallback.appendLocal: false`
 * (read on the next turn, no restart). Answers with the new status.
 */
export function createFallbackLocalQuestionAnswerHandler(): HttpHandler {
  return async (req, res) => {
    let body: { answer?: unknown };
    try {
      body = await readJsonBody<{ answer?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body.answer !== "keep" && body.answer !== "off") {
      sendError(res, 400, openaiError('answer must be "keep" or "off"'));
      return;
    }
    try {
      sendJson(res, 200, answerAppendLocalQuestion(questionPaths(), body.answer));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, openaiError(`answer not saved: ${message}`, "server_error"));
    }
  };
}
