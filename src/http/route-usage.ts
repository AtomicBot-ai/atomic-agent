import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";
import { USAGE_HISTORY_MAX_DAYS, type UsageHistoryFile } from "../session/usage-history.js";
import { buildUsageReport, usageReportJson } from "../session/usage-report.js";
import { DEFAULT_USAGE_DAYS } from "../session/usage-report-args.js";
import {
  readDefaultUsageHistory,
  usageReferenceProviders,
  usageToday,
  type UsageReferenceProviders,
} from "../session/usage-report-defaults.js";

/**
 * `GET /api/usage?days=N|all&compare=<model>` (ATO-2442): the report
 * `atomic-agent usage --models --tools --projects --json` prints, for
 * the desktop's Usage tab and any HTTP client: tokens and cloud cost
 * per day and model, sessions per day, tools, projects and the "saved
 * by local" estimate (`savedByLocal.estimate: true`). Read-only; it
 * reads `<stateDir>/usage-history.json` and the live config, so the
 * figures are the same as the terminal's.
 */
export interface UsageRouteDeps {
  readHistory?: (stateDir: string) => UsageHistoryFile;
  today?: () => string;
  providers?: () => UsageReferenceProviders;
}

const MAX_COMPARE_LENGTH = 200;

export function createUsageHandler(deps: UsageRouteDeps = {}): HttpHandler {
  return async (req, res, ctx) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const days = parseDays(params.get("days"));
    if (days === null) {
      sendError(res, 400, openaiError(`days must be a whole number from 1 to ${USAGE_HISTORY_MAX_DAYS}, or all`, "invalid_request_error", "days"));
      return;
    }
    const compare = params.get("compare")?.trim() || null;
    if (compare !== null && compare.length > MAX_COMPARE_LENGTH) {
      sendError(res, 400, openaiError("compare is too long", "invalid_request_error", "compare"));
      return;
    }
    const stateDir = ctx.runtime.config.paths.stateDir;
    const history = (deps.readHistory ?? readDefaultUsageHistory)(stateDir);
    const report = buildUsageReport(history, {
      days,
      today: (deps.today ?? (() => usageToday()))(),
      compare,
      ...(deps.providers ?? usageReferenceProviders)(),
    });
    sendJson(res, 200, usageReportJson(report, { models: true, tools: true, projects: true }));
  };
}

function parseDays(raw: string | null): number | "all" | null {
  if (raw === null || raw.trim() === "") return DEFAULT_USAGE_DAYS;
  if (raw.trim().toLowerCase() === "all") return "all";
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= USAGE_HISTORY_MAX_DAYS ? n : null;
}
