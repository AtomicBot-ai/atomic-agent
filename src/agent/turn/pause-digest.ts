import type { ConversationTurn } from "../../session/conversation-turn.js";

/**
 * A summary of a paused task built from the turn's own records, with no
 * model call.
 *
 * A task paused at a ceiling gets one reserved step to summarise its work.
 * On a slow local model that step can overrun its own deadline (or spend
 * itself on refused tool calls), and the user was left with a bare
 * "(paused: …)" line after two hours of work. This digest is what they get
 * instead whenever the turn ends without the model's summary: what was
 * asked, how many calls ran, which files were changed, the last steps and
 * the last thing the agent said. It is instant and cannot fail, so the
 * pause always explains itself.
 *
 * Bounded on purpose: the stop reply is recorded in the transcript and read
 * again on `continue`, so every field is capped and the step list is short.
 */

const MAX_RECENT_STEPS = 5;
const MAX_FILES = 8;
const REQUEST_CHARS = 160;
const TARGET_CHARS = 80;
const DETAIL_CHARS = 120;
const NOTE_CHARS = 240;

/** Tools whose `path` argument is a file the task changed. */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
  "os.fs.trash",
  "os.fs.move",
]);

type ToolCallTurn = Extract<ConversationTurn, { kind: "assistant_tool_call" }>;
type ToolResultTurn = Extract<ConversationTurn, { kind: "tool_result" }>;

interface StepRecord {
  call: ToolCallTurn;
  result: ToolResultTurn | null;
}

/**
 * Digest of one macro-turn (the slice after the last closing reply), or
 * `null` when the slice holds no work worth reporting.
 */
export function formatPauseDigest(
  turns: readonly ConversationTurn[],
): string | null {
  const steps = pairSteps(turns);
  const note = lastProgressNote(turns);
  if (steps.length === 0 && note === null) return null;

  const lines: string[] = [];
  const request = turns.find(
    (t): t is Extract<ConversationTurn, { kind: "user" }> =>
      t.kind === "user" && t.steered !== true,
  );
  if (request !== undefined) {
    lines.push(`- Request: "${clip(oneLine(request.text), REQUEST_CHARS)}"`);
  }

  const finished = steps.filter((s) => s.result !== null);
  if (steps.length > 0) {
    const failed = finished.filter((s) => s.result?.status === "error").length;
    const ok = finished.length - failed;
    lines.push(
      `- Tool calls: ${steps.length} (${ok} ok, ${failed} failed` +
        (steps.length > finished.length
          ? `, ${steps.length - finished.length} not finished)`
          : ")"),
    );
  }

  const files = changedFiles(steps);
  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILES).join(", ");
    const more = files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} more)` : "";
    lines.push(`- Files changed: ${shown}${more}`);
  }

  const recent = steps.slice(-MAX_RECENT_STEPS);
  if (recent.length > 0) {
    lines.push("- Last steps:");
    for (const step of recent) lines.push(`  - ${describeStep(step)}`);
  }

  if (note !== null) {
    lines.push(`- Last note: "${clip(oneLine(note), NOTE_CHARS)}"`);
  }

  return [
    "Summary from this task's log (the model did not get to write one):",
    ...lines,
  ].join("\n");
}

/**
 * Match each call to the result that answered it. Results arrive in call
 * order per tool, so a per-tool queue pairs them; a call left without a
 * result was still in flight when the task stopped.
 */
function pairSteps(turns: readonly ConversationTurn[]): StepRecord[] {
  const steps: StepRecord[] = [];
  const open = new Map<string, StepRecord[]>();
  for (const turn of turns) {
    if (turn.kind === "assistant_tool_call") {
      const step: StepRecord = { call: turn, result: null };
      steps.push(step);
      const queue = open.get(turn.tool) ?? [];
      queue.push(step);
      open.set(turn.tool, queue);
    } else if (turn.kind === "tool_result") {
      const step = open.get(turn.tool)?.shift();
      if (step !== undefined) step.result = turn;
    }
  }
  return steps;
}

function changedFiles(steps: readonly StepRecord[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (!FILE_CHANGING_TOOLS.has(step.call.tool)) continue;
    if (step.result?.status !== "ok") continue;
    for (const path of changedPathsOf(step.call.tool, step.call.args)) {
      seen.add(path);
    }
  }
  return Array.from(seen);
}

/** `path`, or for `os.fs.move` every destination (`to`, or each of `moves`). */
function changedPathsOf(tool: string, args: Record<string, unknown>): string[] {
  const raw: unknown[] =
    tool === "os.fs.move"
      ? (Array.isArray(args["moves"]) ? args["moves"] : [args]).map((item: unknown) =>
          typeof item === "object" && item !== null
            ? (item as Record<string, unknown>)["to"]
            : undefined,
        )
      : [args["path"]];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function describeStep(step: StepRecord): string {
  const target = targetOf(step.call.args);
  const head = target === null ? step.call.tool : `${step.call.tool} ${target}`;
  if (step.result === null) return `${head} (not finished)`;
  if (step.result.status === "ok") return `${head} (ok)`;
  const detail = clip(oneLine(step.result.summary), DETAIL_CHARS);
  return detail.length > 0 ? `${head} (failed: ${detail})` : `${head} (failed)`;
}

/** The argument that says what a call acted on, when it has one. */
function targetOf(args: Record<string, unknown>): string | null {
  const cmd = args["cmd"] ?? args["command"];
  if (typeof cmd === "string" && cmd.length > 0) {
    const argv = Array.isArray(args["args"])
      ? args["args"].filter((a): a is string => typeof a === "string")
      : [];
    return `\`${clip(oneLine([cmd, ...argv].join(" ")), TARGET_CHARS)}\``;
  }
  for (const key of ["path", "url", "query", "pattern", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return clip(oneLine(value), TARGET_CHARS);
    }
  }
  return null;
}

function lastProgressNote(turns: readonly ConversationTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.kind === "assistant_reply" && turn.progressNote === true) {
      const text = turn.text.trim();
      if (text.length > 0) return text;
    }
  }
  return null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
