import type { HookRunResult } from "./hook-runner.js";
import { describeHookSource, type HookCommand, type SessionHookEvent } from "./hook-types.js";

const MAX_TEXT_CHARS = 2_000;

/** What the hooks of one session event said, combined. */
export interface SessionHookVerdict {
  /**
   * UserPromptSubmit: the prompt is refused with this reason.
   * Stop / SubagentStop: the agent keeps working, with this reason as its instruction.
   * PermissionRequest: the request is refused without asking the person.
   * Never set for the events that only observe (SessionStart, PreCompact,
   * SessionEnd, FileChanged, Notification).
   */
  block?: string;
  /** SessionStart / UserPromptSubmit: text the model reads with this turn. */
  context?: string;
  /** A hook that failed, timed out or printed bad JSON. Never blocking. */
  error?: string;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? clip(value) : undefined;
}

/** Events whose plain stdout (exit 0, not JSON) is context, as in Claude Code. */
function stdoutIsContext(event: SessionHookEvent): boolean {
  return event === "SessionStart" || event === "UserPromptSubmit";
}

/** Events that may block: refuse the prompt or the request, or make the agent go on. */
function canBlock(event: SessionHookEvent): boolean {
  return event === "UserPromptSubmit" || event === "Stop" || event === "SubagentStop" || event === "PermissionRequest";
}

/**
 * One session-event hook run, read the way Claude Code reads it:
 *
 * - exit 2: UserPromptSubmit refuses the prompt, Stop / SubagentStop make
 *   the agent go on, PermissionRequest refuses the request; stderr is the
 *   reason. The other events cannot block, so their stderr is only logged.
 * - exit 0: SessionStart / UserPromptSubmit plain stdout is context; JSON
 *   may carry `decision: "block"` + `reason`, `continue: false` +
 *   `stopReason`, and `hookSpecificOutput.additionalContext`.
 * - any other exit, a timeout, or a failure to start: a non-blocking error.
 */
export function interpretSessionHookRun(event: SessionHookEvent, hook: HookCommand, run: HookRunResult): SessionHookVerdict {
  const who = `${event} hook "${hook.command}" from ${describeHookSource(hook.source)}`;
  if (run.timedOut) return { error: `${who} timed out after ${Math.round(hook.timeoutMs / 1000)} s and was stopped` };
  if (run.spawnError !== undefined) return { error: `${who} did not run: ${run.spawnError}` };
  if (run.exitCode === 2) {
    const reason = str(run.stderr) ?? "blocked by hook (exit code 2, no message)";
    return canBlock(event) ? { block: reason } : { error: `${who} exited 2 (${event} cannot block): ${reason}` };
  }
  if (run.exitCode !== 0) {
    const tail = str(run.stderr);
    return { error: `${who} failed with exit code ${run.exitCode ?? "unknown"}${tail ? `: ${tail}` : ""}` };
  }
  const out = run.stdout.trim();
  if (!out.startsWith("{")) {
    const text = str(out);
    return text !== undefined && stdoutIsContext(event) ? { context: text } : {};
  }
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(out);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    json = parsed as Record<string, unknown>;
  } catch {
    return { error: `${who} printed output that looks like JSON but does not parse; ignored` };
  }
  return sessionVerdictFromJson(event, json);
}

export function sessionVerdictFromJson(event: SessionHookEvent, json: Record<string, unknown>): SessionHookVerdict {
  const specific = json.hookSpecificOutput;
  const hso = specific !== null && typeof specific === "object" && !Array.isArray(specific) ? (specific as Record<string, unknown>) : {};
  const context = stdoutIsContext(event) ? str(hso.additionalContext) : undefined;
  const withContext = context !== undefined ? { context } : {};
  if (event === "PermissionRequest") return permissionVerdict(json, hso);
  if (event === "Stop" || event === "SubagentStop") {
    // `continue: false` means "stop for good", which is what a Stop already does.
    if (json.continue === false) return {};
    return json.decision === "block" ? { block: str(json.reason) ?? `a ${event} hook asked to keep working` } : {};
  }
  if (event === "UserPromptSubmit") {
    if (json.continue === false) return { block: str(json.stopReason) ?? str(json.reason) ?? "a hook stopped this prompt" };
    if (json.decision === "block") return { block: str(json.reason) ?? "blocked by hook" };
  }
  return withContext;
}

/**
 * PermissionRequest JSON, in Claude Code's shape:
 * `hookSpecificOutput.decision.behavior: "deny"` + `message` refuses, and
 * so do `permissionDecision: "deny"`, `decision: "block"` and
 * `continue: false`. An `allow` is not honoured: hooks only tighten, so
 * the person is still asked (Claude Code would approve here).
 */
function permissionVerdict(json: Record<string, unknown>, hso: Record<string, unknown>): SessionHookVerdict {
  const fallback = "denied by a PermissionRequest hook";
  const decision = hso.decision;
  const d = decision !== null && typeof decision === "object" && !Array.isArray(decision) ? (decision as Record<string, unknown>) : {};
  if (d.behavior === "deny") return { block: str(d.message) ?? fallback };
  if (hso.permissionDecision === "deny") return { block: str(hso.permissionDecisionReason) ?? fallback };
  if (json.decision === "block") return { block: str(json.reason) ?? fallback };
  if (json.continue === false) return { block: str(json.stopReason) ?? str(json.reason) ?? fallback };
  return {};
}

/** Hooks of one event ran in parallel: any block wins; contexts and errors are all kept. */
export function combineSessionVerdicts(verdicts: readonly SessionHookVerdict[]): SessionHookVerdict {
  const block = join(verdicts.map((v) => v.block));
  const context = join(verdicts.map((v) => v.context));
  const error = join(verdicts.map((v) => v.error));
  return {
    ...(block ? { block } : {}),
    ...(context ? { context } : {}),
    ...(error ? { error } : {}),
  };
}

function join(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join("\n") : undefined;
}
