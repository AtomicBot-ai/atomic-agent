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
  /**
   * The base the stance was chosen against.
   *
   * `snapshot` recomputes `baseLevel` from `getConfig()` on every read, so
   * an edit to `agent.approvalLevel` in config.json while `serve` is
   * running moves the baseline out from under a stance that was resolved
   * against the old one — e.g. `default` chosen at base 5, base then
   * lowered to 1, would keep answering mode `default` / baseLevel 1 /
   * approvalLevel 5, a triple `resolveCodingMode("default", 1)` can never
   * produce. When the base moves, the remembered stance is no longer an
   * answer to anything: drop it and fall back to the seed, which reads the
   * live switches and is at least self-consistent.
   */
  let chosenBase: number | null = null;

  const snapshot = (ctx: {
    runtime: { getPlanMode(): boolean; getApprovalLevel(): number };
  }) => {
    const base = baseLevel();
    if (chosenBase !== null && chosenBase !== base) {
      chosen = null;
      chosenBase = null;
    }
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
    const base = baseLevel();
    const resolved = resolveCodingMode(body.mode, base);
    ctx.runtime.setApprovalLevel(resolved.approvalLevel);
    ctx.runtime.setPlanMode(resolved.planMode);
    // Remember the stance itself, not just its projection onto the two
    // switches — the projection is lossy (see `inferMode`) — and the base
    // it was resolved against, so a later edit to `agent.approvalLevel`
    // invalidates it rather than being reported against the wrong base.
    chosen = body.mode;
    chosenBase = base;
    sendJson(res, 200, snapshot(ctx));
  };

  return { get, set };
}
