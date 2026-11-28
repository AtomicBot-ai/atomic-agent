import type { ApprovalRequest } from "../approval/approval-gate.js";
import { claudeShapedInput, currentToolHookCall, type HookLogger } from "./hook-engine.js";
import { claudeToolName } from "./hook-matcher.js";
import { sessionHookBase, type SessionHookEngine } from "./session-hook-engine.js";

/** Requests that ask the person for input rather than for a permission. */
const NOT_PERMISSIONS = new Set<string>(["user_question", "browser_take_over"]);

/** Claude Code's `notification_type` for what the person is being asked. */
export function notificationTypeFor(request: Pick<ApprovalRequest, "category">): string {
  return NOT_PERMISSIONS.has(request.category) ? "elicitation_dialog" : "permission_prompt";
}

/** The Notification `message`, worded like Claude Code's ("Claude needs your permission to use Bash"). */
export function notificationMessageFor(request: Pick<ApprovalRequest, "category" | "tool">): string {
  if (request.category === "user_question") return "Atomic Agent has a question for you";
  if (request.category === "browser_take_over") return "Atomic Agent needs you to take over the browser";
  return `Atomic Agent needs your permission to use ${claudeToolName(request.tool) ?? request.tool}`;
}

/**
 * The PermissionRequest / Notification hooks (ATO-2462), installed on the
 * approval gate (`ApprovalGate.setPromptHooks`). Both fire only when a
 * person is about to be asked: an auto-approval, a rule, a grant or a
 * refuse policy settles the request before them.
 *
 * - PermissionRequest runs first and may refuse the request (exit 2 or a
 *   `deny`), so the person is never asked. Its `allow` is ignored: hooks
 *   only tighten, and the ladder is not skipped without a person's yes.
 *   Not fired for a clarifying question or a browser hand-over, which
 *   are not permissions.
 * - Notification runs when the prompt goes out, fire-and-forget, so a
 *   script can ping the person (a desktop notice, a phone push). It never
 *   delays or changes the prompt. Its matcher is the `notification_type`.
 */
export class PermissionHooks {
  constructor(
    private readonly engine: Pick<SessionHookEngine, "runEvent">,
    private readonly logger?: HookLogger,
  ) {}

  /** A refusal reason, or undefined to let the prompt go out. */
  async beforePrompt(request: ApprovalRequest, signal?: AbortSignal): Promise<string | undefined> {
    if (NOT_PERMISSIONS.has(request.category)) return undefined;
    const cwd = request.workdir ?? process.cwd();
    const alias = claudeToolName(request.tool);
    const verdict = await this.engine.runEvent(
      "PermissionRequest",
      {
        ...sessionHookBase("PermissionRequest", { sessionId: request.sessionId, cwd }),
        tool_name: alias ?? request.tool,
        atomic_tool_name: request.tool,
        claude_tool_name: alias,
        tool_input: toolInputFor(request),
        permission_suggestions: [],
        atomic_category: request.category,
        atomic_reason: request.reason,
      },
      { cwd, target: request.tool, ...(signal ? { signal } : {}) },
    );
    return verdict.block;
  }

  /** Fire the Notification hooks for a prompt that just went out. Never throws. */
  onPrompt(request: ApprovalRequest): void {
    const cwd = request.workdir ?? process.cwd();
    const type = notificationTypeFor(request);
    void this.engine
      .runEvent(
        "Notification",
        {
          ...sessionHookBase("Notification", { sessionId: request.sessionId, cwd }),
          message: notificationMessageFor(request),
          title: type === "permission_prompt" ? "Permission needed" : "Input needed",
          notification_type: type,
          atomic_tool_name: request.tool,
          atomic_category: request.category,
        },
        { cwd, target: type },
      )
      .catch((err: unknown) => {
        this.logger?.warn("hooks: Notification hook failed", { error: err instanceof Error ? err.message : String(err) });
      });
  }
}

/**
 * The tool's input as a Claude hook reads it: the real arguments when the
 * call that asked is in scope (`runWithToolHooks`), else what the request
 * itself carries.
 */
function toolInputFor(request: ApprovalRequest): unknown {
  const call = currentToolHookCall();
  if (call && call.sessionId === request.sessionId && call.tool === request.tool) {
    return claudeShapedInput(call.tool, call.args);
  }
  return {
    ...(request.commandArgv ? { command: request.commandArgv.join(" ") } : {}),
    ...(request.targetPaths?.[0] !== undefined ? { file_path: request.targetPaths[0] } : {}),
    ...(request.preview !== undefined ? { preview: request.preview } : {}),
  };
}
