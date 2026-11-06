import type { HookRunResult } from "./hook-runner.js";
import { describeHookSource, type HookCommand, type HookVerdict, type ToolHookEvent } from "./hook-types.js";

const MAX_REASON_CHARS = 2_000;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS)}…` : t;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? clip(value) : undefined;
}

/**
 * Turn one hook run into a verdict, the way Claude Code reads it:
 *
 * - exit 2: block. stderr is the reason (PreToolUse: the call is refused;
 *   PostToolUse: the text goes back to the model with the result).
 * - exit 0: allowed; stdout may hold JSON with `decision: "block"|"approve"`,
 *   `reason`, `continue: false` + `stopReason`, or
 *   `hookSpecificOutput.permissionDecision: "allow"|"deny"|"ask"` with
 *   `permissionDecisionReason` (wins over `decision`), and
 *   `hookSpecificOutput.additionalContext` for PostToolUse.
 * - any other exit, a timeout, or a failure to start: a non-blocking error.
 */
export function interpretHookRun(event: ToolHookEvent, hook: HookCommand, run: HookRunResult): HookVerdict {
  const who = `${event} hook "${hook.command}" from ${describeHookSource(hook.source)}`;
  if (run.timedOut) {
    return { decision: "none", error: `${who} timed out after ${Math.round(hook.timeoutMs / 1000)} s and was stopped` };
  }
  if (run.spawnError !== undefined) {
    return { decision: "none", error: `${who} did not run: ${run.spawnError}` };
  }
  if (run.exitCode === 2) {
    const reason = str(run.stderr) ?? "blocked by hook (exit code 2, no message)";
    return event === "PreToolUse" ? { decision: "deny", reason } : { decision: "none", feedback: reason };
  }
  if (run.exitCode !== 0) {
    const tail = str(run.stderr);
    return { decision: "none", error: `${who} failed with exit code ${run.exitCode ?? "unknown"}${tail ? `: ${tail}` : ""}` };
  }
  const out = run.stdout.trim();
  if (!out.startsWith("{")) return { decision: "none" };
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(out);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { decision: "none" };
    json = parsed as Record<string, unknown>;
  } catch {
    return { decision: "none", error: `${who} printed output that looks like JSON but does not parse; ignored` };
  }
  return verdictFromJson(event, json);
}

export function verdictFromJson(event: ToolHookEvent, json: Record<string, unknown>): HookVerdict {
  const specific = json.hookSpecificOutput;
  const hso = specific !== null && typeof specific === "object" && !Array.isArray(specific) ? (specific as Record<string, unknown>) : {};
  const context = str(hso.additionalContext);

  if (json.continue === false) {
    const reason = str(json.stopReason) ?? str(json.reason) ?? "a hook stopped this call";
    return event === "PreToolUse" ? { decision: "deny", reason } : { decision: "none", feedback: reason };
  }

  if (event === "PreToolUse") {
    const permission = hso.permissionDecision;
    const permissionReason = str(hso.permissionDecisionReason);
    if (permission === "deny") return { decision: "deny", reason: permissionReason ?? "denied by hook" };
    if (permission === "ask") return { decision: "ask", ...(permissionReason ? { reason: permissionReason } : {}) };
    if (permission === "allow") return { decision: "allow", ...(permissionReason ? { reason: permissionReason } : {}) };
    const reason = str(json.reason);
    if (json.decision === "block") return { decision: "deny", reason: reason ?? "blocked by hook" };
    if (json.decision === "approve") return { decision: "allow", ...(reason ? { reason } : {}) };
    return { decision: "none" };
  }

  // PostToolUse: the call already ran; a block only tells the model why.
  const parts: string[] = [];
  if (json.decision === "block") parts.push(str(json.reason) ?? "a PostToolUse hook flagged this result");
  if (context) parts.push(context);
  return parts.length > 0 ? { decision: "none", feedback: parts.join("\n") } : { decision: "none" };
}

/**
 * Several hooks matched one call (they run in parallel, as in Claude Code):
 * any deny wins, then any ask, then any allow. Reasons, feedback and errors
 * of the hooks that decided are all kept.
 */
export function combineVerdicts(verdicts: readonly HookVerdict[]): HookVerdict {
  const pick = (d: HookVerdict["decision"]) => verdicts.filter((v) => v.decision === d);
  const decided = pick("deny").length > 0 ? pick("deny") : pick("ask").length > 0 ? pick("ask") : pick("allow");
  const decision = decided[0]?.decision ?? "none";
  const reason = join(decided.map((v) => v.reason));
  const feedback = join(verdicts.map((v) => v.feedback));
  const error = join(verdicts.map((v) => v.error));
  return {
    decision,
    ...(reason ? { reason } : {}),
    ...(feedback ? { feedback } : {}),
    ...(error ? { error } : {}),
  };
}

function join(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join("\n") : undefined;
}
