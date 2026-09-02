import { getConfig } from "../config/index.js";
import {
  CODING_MODES,
  codingModeLook,
  resolveCodingMode,
  type CodingMode,
} from "../tui/coding-mode.js";
import { clampApprovalLevel } from "../approval/approval-level.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/coding-mode` and `POST /api/coding-mode` — the composer's
 * coding mode (default / plan / auto / bypass) over HTTP.
 *
 * This is the TUI's `onCodingModeChanged` verbatim: resolve the mode
 * against the configured baseline, then move the LIVE ladder and the
 * LIVE plan flag — `runtime.setApprovalLevel` and `runtime.setPlanMode`
 * — and write nothing to config.json. The mode is a stance for this
 * session; the persisted baseline stays whatever `agent.approvalLevel`
 * says, so a session that passed through `bypass` cannot leave the
 * machine trusting everything on the next boot.
 *
 * Until now that pair of setters had exactly one caller, the TUI, so no
 * HTTP client could offer the mode at all.
 */
function isCodingMode(value: unknown): value is CodingMode {
  return typeof value === "string" && (CODING_MODES as readonly string[]).includes(value);
}

function baseLevel(): ReturnType<typeof clampApprovalLevel> {
  return clampApprovalLevel(getConfig().agent.approvalLevel);
}

/** Read the live switches back as the mode they amount to. */
function currentMode(planMode: boolean, level: number, base: number): CodingMode {
  if (planMode) return "plan";
  if (level >= 5) return "bypass";
  if (level > base || (level >= 2 && base < 2)) return "auto";
  return "default";
}

function snapshot(ctx: { runtime: { getPlanMode(): boolean; getApprovalLevel(): number } }) {
  const base = baseLevel();
  const planMode = ctx.runtime.getPlanMode();
  const approvalLevel = ctx.runtime.getApprovalLevel();
  const mode = currentMode(planMode, approvalLevel, base);
  return { mode, approvalLevel, planMode, baseLevel: base, look: codingModeLook(mode) };
}

export function createGetCodingModeHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    sendJson(res, 200, snapshot(ctx));
  };
}

export function createSetCodingModeHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: { mode?: unknown };
    try {
      body = await readJsonBody<{ mode?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isCodingMode(body.mode)) {
      sendError(res, 400, openaiError(`mode must be one of ${CODING_MODES.join("|")}`));
      return;
    }
    const resolved = resolveCodingMode(body.mode, baseLevel());
    ctx.runtime.setApprovalLevel(resolved.approvalLevel);
    ctx.runtime.setPlanMode(resolved.planMode);
    sendJson(res, 200, snapshot(ctx));
  };
}
