import type { ApprovalDecision, ApprovalRequest } from "../approval/approval-gate.js";
import { ApprovalDeniedError } from "../approval/dangerous-tool.js";
import { compressToolResult, type CompressedToolResult } from "../compressor/result-compressor.js";
import { loadAllHooks } from "./hook-config.js";
import { claudeToolName, matcherMatches } from "./hook-matcher.js";
import { combineVerdicts, interpretHookRun } from "./hook-output.js";
import { runHookCommand, type RunHookOptions, type HookRunResult } from "./hook-runner.js";
import type { HookCommand, HookVerdict, LoadedHooks, ToolHookEvent } from "./hook-types.js";

/** One tool call as the hooks see it. */
export interface ToolHookCall {
  tool: string;
  args: unknown;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
}

/** The part of `ApprovalGate` the engine uses for a hook's `ask`. */
export interface HookApprover {
  request(
    params: Omit<ApprovalRequest, "approvalId">,
    options?: { signal?: AbortSignal },
  ): Promise<ApprovalDecision>;
}

export interface HookLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ToolHookEngineOptions {
  stateDir: string;
  /** Where an `ask` goes. Without it, `ask` is treated as a deny. */
  approvals?: HookApprover;
  logger?: HookLogger;
  /** Test seams. */
  load?: () => LoadedHooks;
  run?: (hook: HookCommand, input: unknown, options: RunHookOptions) => Promise<HookRunResult>;
}

export type PreToolOutcome =
  | { kind: "proceed"; errors?: string }
  | { kind: "refuse"; result: CompressedToolResult };

/**
 * Runs PreToolUse / PostToolUse hooks around tool calls. It only ever
 * tightens: a hook can refuse a call or ask the user about it, but an
 * `allow` does not skip the approval gate the tool itself goes through.
 */
export class ToolHookEngine {
  private readonly logged = new Set<string>();

  constructor(private readonly options: ToolHookEngineOptions) {}

  private hooks(): LoadedHooks {
    const loaded = this.options.load ? this.options.load() : loadAllHooks(this.options.stateDir);
    for (const line of loaded.diagnostics) {
      if (this.logged.has(line)) continue;
      this.logged.add(line);
      this.options.logger?.warn("hooks: entry skipped", { diagnostic: line });
    }
    return loaded;
  }

  /** The hook commands of `event` whose matcher selects `tool`. */
  matching(event: ToolHookEvent, tool: string): HookCommand[] {
    const groups = this.hooks().config[event] ?? [];
    const out: HookCommand[] = [];
    for (const group of groups) {
      if (matcherMatches(group.matcher, tool)) out.push(...group.hooks);
    }
    return out;
  }

  /** Run every matching hook of `event` in parallel and combine what they said. */
  async runToolEvent(event: ToolHookEvent, call: ToolHookCall, response?: unknown): Promise<HookVerdict & { ran: number }> {
    const hooks = this.matching(event, call.tool);
    if (hooks.length === 0) return { decision: "none", ran: 0 };
    const input = hookInput(event, call, response);
    const run = this.options.run ?? runHookCommand;
    const verdicts = await Promise.all(
      hooks.map(async (hook) => interpretHookRun(event, hook, await run(hook, input, { cwd: call.cwd, signal: call.signal }))),
    );
    const combined = combineVerdicts(verdicts);
    if (combined.error) this.options.logger?.warn("hooks: hook failed", { event, tool: call.tool, error: combined.error });
    return { ...combined, ran: hooks.length };
  }

  /** PreToolUse: proceed, or the refusal result that takes the call's place. */
  async beforeTool(call: ToolHookCall): Promise<PreToolOutcome> {
    const verdict = await this.runToolEvent("PreToolUse", call);
    if (verdict.decision === "deny") return { kind: "refuse", result: hookRefusal(call.tool, verdict.reason) };
    if (verdict.decision === "ask") {
      if (!this.options.approvals) {
        return { kind: "refuse", result: hookRefusal(call.tool, `${verdict.reason ?? "a hook asked to confirm this call"} (no one to ask, so it was not run)`) };
      }
      const decision = await this.options.approvals.request(
        {
          sessionId: call.sessionId,
          tool: call.tool,
          // Asks at every level below full trust; no grant or smart review answers it.
          category: "hook_ask",
          reason: `A PreToolUse hook asks you to confirm this call${verdict.reason ? `: ${verdict.reason}` : "."}`,
          preview: previewOf(call.args),
        },
        { signal: call.signal },
      );
      if (!decision.approved) {
        const denied = new ApprovalDeniedError(call.tool, decision.reason, {
          byUser: decision.automatic !== true,
          declinedEarlier: decision.declinedEarlier === true,
        });
        return {
          kind: "refuse",
          result: compressToolResult({
            tool: call.tool,
            status: "error",
            output: denied.message,
            details: { errorName: denied.name, hookAsked: true },
          }),
        };
      }
    }
    return verdict.error ? { kind: "proceed", errors: verdict.error } : { kind: "proceed" };
  }

  /** PostToolUse: the result, with any hook feedback added for the model. */
  async afterTool(call: ToolHookCall, result: CompressedToolResult): Promise<CompressedToolResult> {
    const verdict = await this.runToolEvent("PostToolUse", call, {
      status: result.status,
      output: result.summary,
      truncated: result.truncated,
    });
    if (verdict.ran === 0) return result;
    return withHookNotes(result, verdict.feedback, verdict.error);
  }
}

/**
 * Wrap one tool invocation with its hooks. `engine` absent means no hooks:
 * `invoke` runs exactly as before. Cancellation thrown by `invoke` passes
 * through untouched.
 */
export async function runWithToolHooks(
  engine: ToolHookEngine | null | undefined,
  call: ToolHookCall,
  invoke: () => Promise<CompressedToolResult>,
): Promise<CompressedToolResult> {
  if (!engine) return invoke();
  const before = await engine.beforeTool(call);
  if (before.kind === "refuse") return before.result;
  let result = await invoke();
  if (before.errors) result = withHookNotes(result, undefined, before.errors);
  if (call.signal.aborted) return result;
  return engine.afterTool(call, result);
}

/** The refusal is our text plus the hook's reason (clipped to 2 000 chars); keep it whole. */
const REFUSAL_COMPRESS_OPTIONS = { maxSummaryLength: 4_000, maxTailLines: Number.MAX_SAFE_INTEGER } as const;

/** The error result a call gets when a PreToolUse hook refused it. */
export function hookRefusal(tool: string, reason: string | undefined): CompressedToolResult {
  return compressToolResult({
    tool,
    status: "error",
    output:
      `${tool} was not run: a PreToolUse hook blocked it` +
      (reason ? `. Reason: ${reason}` : ".") +
      "\nThis is a rule the user set up, not a tool failure; do not retry the same call.",
    details: { hookDenied: true, hookEvent: "PreToolUse", ...(reason ? { hookReason: reason } : {}) },
  }, REFUSAL_COMPRESS_OPTIONS);
}

function withHookNotes(result: CompressedToolResult, feedback: string | undefined, error: string | undefined): CompressedToolResult {
  if (!feedback && !error) return result;
  return {
    ...result,
    summary: feedback ? `${result.summary}\n\n[PostToolUse hook] ${feedback}` : result.summary,
    details: {
      ...result.details,
      ...(feedback ? { hookFeedback: feedback } : {}),
      ...(error ? { hookErrors: error } : {}),
    },
  };
}

function previewOf(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    text = String(args);
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/**
 * The JSON a hook reads on stdin, in Claude Code's shape. `tool_name` is
 * the Claude name when there is one (so `if tool_name == "Bash"` scripts
 * work), and `atomic_tool_name` is always ours. `tool_input` carries our
 * arguments plus Claude's key names for the common ones (`file_path`,
 * `command`, `old_string`, `new_string`).
 */
export function hookInput(event: ToolHookEvent, call: ToolHookCall, response?: unknown): Record<string, unknown> {
  const alias = claudeToolName(call.tool);
  return {
    session_id: call.sessionId,
    transcript_path: null,
    cwd: call.cwd,
    permission_mode: "default",
    hook_event_name: event,
    tool_name: alias ?? call.tool,
    atomic_tool_name: call.tool,
    claude_tool_name: alias,
    tool_input: claudeShapedInput(call.tool, call.args),
    ...(event === "PostToolUse" ? { tool_response: response ?? null } : {}),
  };
}

export function claudeShapedInput(tool: string, args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = { ...a };
  if (typeof a.path === "string" && out.file_path === undefined) out.file_path = a.path;
  if (typeof a.oldString === "string" && out.old_string === undefined) out.old_string = a.oldString;
  if (typeof a.newString === "string" && out.new_string === undefined) out.new_string = a.newString;
  if (tool === "os.shell.run" && typeof a.cmd === "string" && out.command === undefined) {
    const rest = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [];
    out.command = [a.cmd, ...rest].join(" ");
  }
  return out;
}

let active: ToolHookEngine | null = null;

/** Set by the runtime at boot; the batch executor reads it per call. */
export function installToolHooks(engine: ToolHookEngine | null): void {
  active = engine;
}

export function activeToolHooks(): ToolHookEngine | null {
  return active;
}
