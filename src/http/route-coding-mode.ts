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

/**
 * Read the live switches back as the mode they amount to — the BOOT SEED
 * ONLY, never the readback of a choice.
 *
 * `resolveCodingMode` is not injective, so this cannot be the answer to
 * "what did the operator pick". At `agent.approvalLevel: 5` — a real
 * operator configuration — `default`, `auto` and `bypass` all resolve to
 * level 5 with plan off, so every one of them reads back as `bypass`
 * here. The TUI never infers either: it holds the mode in view state
 * (src/tui/tui-state.ts `codingMode: CodingMode`, initially "default").
 *
 * What inference is genuinely good for is the first GET of a process,
 * before anyone has chosen anything: an agent started with
 * `--no-approval` really is sitting at level 5, and saying `bypass` there
 * is honest where saying `default` would be a lie. Note the consequence
 * at approvalLevel 5: the seed reports `bypass`, so the desktop chip
 * opens red until a mode is chosen. That is the live gate, not a bug.
 */
function inferMode(planMode: boolean, level: number, base: number): CodingMode {
  if (planMode) return "plan";
  if (level >= 5) return "bypass";
  if (level > base || (level >= 2 && base < 2)) return "auto";
  return "default";
}

export interface CodingModeHandlers {
  readonly get: HttpHandler;
  readonly set: HttpHandler;
}

/**
 * The GET and the POST share one closure, and that is the whole point.
 *
 * The chosen stance is per-process state — one runtime, one approval
 * gate, one plan flag — so it belongs to the pair of handlers, created
 * once in `buildRouteTable`. Two independent factories could not do it,
 * and a module-level `let` would leak between servers inside one vitest
 * worker.
 */
export function createCodingModeHandlers(): CodingModeHandlers {
  /** What was last POSTed. `null` until then: fall back to the seed. */
  let chosen: CodingMode | null = null;

  const snapshot = (ctx: {
    runtime: { getPlanMode(): boolean; getApprovalLevel(): number };
  }) => {
    const base = baseLevel();
    const planMode = ctx.runtime.getPlanMode();
    const approvalLevel = ctx.runtime.getApprovalLevel();
    const mode = chosen ?? inferMode(planMode, approvalLevel, base);
    return { mode, approvalLevel, planMode, baseLevel: base, look: codingModeLook(mode) };
  };

  const get: HttpHandler = async (_req, res, ctx) => {
    sendJson(res, 200, snapshot(ctx));
  };

  const set: HttpHandler = async (req, res, ctx) => {
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
    // Remember the stance itself, not just its projection onto the two
    // switches — the projection is lossy (see `inferMode`).
    chosen = body.mode;
    sendJson(res, 200, snapshot(ctx));
  };

  return { get, set };
}
