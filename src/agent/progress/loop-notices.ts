import type { LoopCheckVerdict } from "./loop-contract.js";
/**
 * Notice injected into the next prompt's `### notice` section when a
 * repeat is detected (warn). Class-aware so the hint is actionable.
 */
export function formatRepeatNotice(verdict: {
  count: number;
  tool: string;
  target?: string;
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "notice", verdict);
}

/**
 * Body of the synthetic veto tool result (critical). Same class-aware
 * guidance as the notice, plus an explicit "do not repeat" instruction.
 *
 * `target` names the invariant that stayed the same across the blocked
 * attempts (host for web/HTTP calls, command name for shell). `detector`
 * distinguishes a true no-progress repeat from a `wandering` escalation
 * riding the same veto path — the two need opposite wording, because a
 * wandering `count` is a spread of DISTINCT arguments, not a run of
 * identical outcomes.
 */
export function formatVetoInstruction(verdict: {
  count: number;
  tool: string;
  target?: string;
  detector?: LoopCheckVerdict["detector"];
}): string {
  return formatLoopGuidance(verdict.tool, verdict.count, "veto", verdict);
}

/**
 * Notice injected when a recognized test command was re-run against an
 * unchanged workspace (issue #118, warn-only). The run has already
 * executed when the model reads this — the wording is therefore an
 * after-the-fact nudge, not a block, and explicitly leaves the
 * intentional-repeat path open (nothing is vetoed; the generic loop
 * protection stays fully active either way).
 */
export function formatTestRepeatNotice(verdict: {
  count: number;
  target?: string;
  previousSummary?: string;
}): string {
  const target = sanitizeLoopTarget(verdict.target);
  const label = target ? `\`${target}\`` : "the same test command";
  const lines = [
    `You ran ${label} ${verdict.count} times with no workspace change in between. No project file changed since the previous run, so this run could not produce new evidence.`,
  ];
  if (verdict.previousSummary !== undefined) {
    const summary = sanitizeTestSummary(verdict.previousSummary);
    if (summary !== undefined) {
      lines.push(`Previous result: ${summary}`);
    }
  }
  lines.push(
    "Change the code or the test selection before re-running. If the repeat was intentional (e.g. probing for flakiness), continue — this is a warning, nothing was blocked.",
  );
  return lines.join("\n");
}

/**
 * Notice injected when the same result has come back three times this
 * turn with no write in between (warn-only). The arguments may all have
 * differed — that is the case the argument-keyed detectors miss — so the
 * wording is about the RESULT: re-checking will not change it, only a
 * change to the workspace or the approach will.
 */
export function formatOutcomeRepeatNotice(verdict: {
  count: number;
  tool: string;
}): string {
  const times = verdict.count === 3 ? "three times" : `${verdict.count} times`;
  return [
    `Same result ${times} from \`${verdict.tool}\` — change approach or write. Re-checking returns the same answer; nothing has changed since the last time you saw it.`,
    "Act on what you already know: edit or write the file the result points at, run a different command, or reply with what you found. This is a warning, nothing was blocked.",
  ].join("\n");
}

/**
 * Notice injected when the same unchanged file was read again without
 * reaching a new line (issue #114, warn-only).
 *
 * Deliberately concrete about WHAT was already read — the last returned
 * range and the covered line set — because the failure mode this catches
 * is the model not realising its shifted `offset`/`limit` landed inside
 * text it already has. Line numbers and the path only: no file content
 * appears here, in the event, or in the log line.
 *
 * The remediation sentence is chosen from three cases, because the same
 * advice is not true of all of them. A read that returned nothing did
 * NOT re-read a covered range — it asked for a range that does not
 * exist, either past the end of the file or (when `truncated`) behind
 * the read's byte budget — and telling that model to "read a range you
 * have not covered" points it straight back at the request that just
 * failed. Naming the reachable window, and the byte cap when there is
 * one, is the only advice that can actually unstick it.
 */
export function formatReadRepeatNotice(verdict: {
  count: number;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  covered: string;
  truncated?: boolean;
}): string {
  const label = sanitizeReadPath(verdict.path);
  const empty = verdict.startLine === 0;
  const reach =
    verdict.totalLines > 0
      ? `lines 1-${verdict.totalLines}`
      : "no lines at all";
  const lines: string[] = [];
  if (empty) {
    lines.push(
      `You read ${label} ${verdict.count} times in a row without reaching a line you had not already read this turn. The last read returned no lines at all: the range you asked for is outside the part of the file this read can reach, which is ${reach}.`,
    );
  } else {
    lines.push(
      `You read ${label} ${verdict.count} times in a row without reaching a line you had not already read this turn. The last read returned lines ${verdict.startLine}-${verdict.endLine}, and the file's content has not changed since the previous read.`,
    );
  }
  if (verdict.covered.length > 0) {
    lines.push(
      `Already read this turn: lines ${verdict.covered}${verdict.totalLines > 0 ? ` (of ${verdict.totalLines} readable lines)` : ""}.`,
    );
  }
  if (empty && verdict.truncated === true) {
    lines.push(
      `The file is larger than this read's \`maxBytes\` budget, so everything past line ${verdict.totalLines} is invisible to it no matter which \`offset\` you pass. Raise \`maxBytes\` to reach further into the file, or work with the part you can already see.`,
    );
  } else if (empty) {
    lines.push(
      `Asking for an \`offset\` past the end returns nothing. Stay inside ${reach}, open a different file, or act on what you already have.`,
    );
  } else {
    lines.push(
      "Re-reading a covered range returns the same text. Read a range you have not covered, open a different file, or act on what you already have.",
    );
  }
  lines.push(
    "If the repeat was intentional, continue — this is a warning, nothing was blocked.",
  );
  return lines.join("\n");
}

/**
 * Path label for the read-repeat notice. `sanitizeLoopTarget` keeps the
 * HEAD of an over-long label, which is exactly wrong for a path — the
 * identifying part of `/very/long/prefix/src/agent/loop-detector.ts` is
 * its tail — so a long path is elided from the left instead.
 */
function sanitizeReadPath(raw: string): string {
  const cleaned = raw.replace(/[`\r\n]+/g, " ").trim();
  if (cleaned.length === 0) return "that file";
  const label = cleaned.length > 80 ? `…${cleaned.slice(-77)}` : cleaned;
  return `\`${label}\``;
}

/**
 * Compact a previous-result summary for inline quoting in a notice:
 * whitespace collapsed to one line, length-capped. Returns `undefined`
 * for an empty summary so the caller omits the line entirely.
 */
function sanitizeTestSummary(raw: string): string | undefined {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

/**
 * Notice injected when a wandering loop is detected (warn-level). Unlike
 * the repeat veto ("do not do X"), this is an actionable redirect ("do Y
 * instead"): the model has probed many distinct URLs/queries/pages on one
 * tool without converging, so steer it toward search or an honest reply.
 */
export function formatWanderingRedirect(tool: string, spread: number): string {
  const lines = [
    `You have called \`${tool}\` with ${spread} different arguments in a row without using what came back.`,
    "This is a wandering loop. STOP and change strategy:",
  ];
  if (tool === "os.web.search") {
    // The redirect must name the move that ENDS the run. For a search
    // tool that is opening a result, not "stop probing pages" — the
    // generic wording named no action a search tool can take, which is
    // what a reporter's model was handed on the run that then hit the
    // cap (issue #458).
    lines.push(
      "- You already have search results. Open the most promising one with `os.web.fetch` instead of re-phrasing the query.",
    );
  } else if (tool === "os.web.fetch" || tool === "os.http.request") {
    lines.push(
      "- Run `os.web.search` first to find the right page, then fetch that one URL — do not keep guessing URLs.",
    );
  } else if (tool.startsWith("browser.")) {
    lines.push(
      "- Re-read `### world`; the answer may already be on the page. Navigate to a single more-direct URL or run a search instead of clicking around.",
    );
  }
  lines.push(
    "- If you already have enough information, end the turn with `reply` and your best-effort answer.",
  );
  return lines.join("\n");
}

/**
 * Synthetic assistant reply emitted when the breaker fires (the model
 * ignored repeated vetoes, or a wandering spread crossed the escalation
 * cap). Reused by the agent loop's forced graceful termination path.
 *
 * `detector` decides the wording, the same way it does for the veto. A
 * wandering stop's `count` is the spread of DISTINCT arguments measured
 * by whichever rule fired (`WanderingStop.rule`), counting the call that
 * was blocked, and most of those calls ran and may well have returned
 * what the model needed, so "no-progress loop", "blocked attempts" and
 * "the repeated tool call" would all be false. The count is not quoted
 * as the cap: a parallel batch is gated before any of its calls record,
 * so the spread can pass the cap before a call is refused. Nor is it
 * "this turn": both rules read a recent slice of it, not the whole.
 *
 * A repeat stop's `count` is the no-progress STREAK, and most of that
 * streak ran: with the defaults the breaker trips on the 4th refusal
 * while the streak has plateaued at 5. So the streak is never quoted as
 * "blocked attempts". `blocked` — the tracker's consecutive-veto count,
 * including the call refused right now — is the refusal count, and the
 * production caller always has it (a veto is recorded before the signal
 * is built, so it is never 0 there). The `blocked`-less form is for the
 * exported 3-argument API: it quotes no number at all, because `count`
 * on a breaker signal is `max(streak, breakerVetoStreak)` and so is not
 * a streak this function can honestly describe.
 */
export function formatForcedLoopReply(
  tool: string,
  count: number,
  detector?: LoopCheckVerdict["detector"],
  blocked?: number,
): string {
  if (detector === "wandering") {
    return [
      `(stopped: \`${tool}\` hit the limit on different arguments within recent tool calls — ${count}, counting the last call, which was not run).`,
      "Here is my best answer with the information gathered so far — the task may be incomplete.",
    ].join(" ");
  }
  const cause =
    blocked !== undefined && blocked > 0
      ? `(stopped: \`${tool}\` kept returning the same no-progress outcome, and the same call was refused ${blocked} ${blocked === 1 ? "time" : "times"} in a row, counting this one).`
      : `(stopped: \`${tool}\` kept returning the same no-progress outcome, and this call was not run).`;
  return [
    cause,
    "I could not make further progress with the repeated tool call.",
    "Here is my best answer with the information gathered so far — the task may be incomplete.",
  ].join(" ");
}

function formatLoopGuidance(
  tool: string,
  count: number,
  mode: "notice" | "veto",
  context: {
    target?: string;
    detector?: LoopCheckVerdict["detector"];
  } = {},
): string {
  const target = sanitizeLoopTarget(context.target);
  const wandering = context.detector === "wandering";

  let header: string;
  if (mode === "veto" && wandering) {
    // Wandering: `count` is a spread of DISTINCT arguments, so calling
    // these "identical outcomes" would be flatly wrong.
    // Not "and still no answer": most of those attempts ran, and in both
    // reports on issue #458 they returned usable content. What is
    // certainly true is that the turn kept probing without acting on it.
    header = target
      ? `BLOCKED: \`${tool}\` — ${count} different attempts against \`${target}\` in a row without using what came back.`
      : `BLOCKED: \`${tool}\` — ${count} different attempts in a row without using what came back.`;
  } else if (mode === "veto" && count > 1) {
    header = target
      ? `BLOCKED: \`${tool}\` — ${count} consecutive calls to \`${target}\` returned the same no-progress outcome.`
      : `BLOCKED: \`${tool}\` — ${count} consecutive calls returned the same no-progress outcome.`;
  } else if (mode === "veto") {
    // The breaker can fire on a verdict that carries no streak of its own
    // (a wandering episode the model ended by settling on one argument).
    // State only what is certainly true rather than quoting a count that
    // would read as "0 consecutive calls".
    header = target
      ? `BLOCKED: \`${tool}\` — repeated calls to \`${target}\` are not making progress.`
      : `BLOCKED: \`${tool}\` — repeated calls are not making progress.`;
  } else {
    header = target
      ? `You called \`${tool}\` on \`${target}\` ${count} times with the same arguments and neither the result nor the world snapshot changed.`
      : `You called \`${tool}\` with the same arguments ${count} times and neither the result nor the world snapshot changed.`;
  }

  // Actionable alternative, modelled on the wandering redirect: name the
  // next move, do not restate the failure mode.
  let webHint: string | null = null;
  if (tool === "os.web.search") {
    webHint = wandering
      ? "- You already have search results. Open the most promising one with `os.web.fetch` instead of re-phrasing the query."
      : "- Re-phrasing will not change this result. Open one of the results you already have with `os.web.fetch`, or answer from what you have.";
  } else if (tool === "os.web.fetch" || tool === "os.http.request") {
    if (wandering && target) {
      webHint = `- Stop guessing URLs on \`${target}\`. Run \`os.web.search\` for the fact you need and fetch a result from a DIFFERENT host.`;
    } else if (target) {
      webHint = `- Run \`os.web.search\` for the fact you need and fetch a result from a DIFFERENT host — stop retrying \`${target}\`. The URL may be dead or returning an HTTP error; read the status in the tool result.`;
    } else {
      webHint =
        "- Run `os.web.search` for the fact you need, then fetch one URL from the results — do not keep guessing URLs. The URL may be dead or returning an HTTP error; read the status in the tool result.";
    }
  }
  const browserHint = tool.startsWith("browser.")
    ? "- Re-read `### world` — the answer may already be on the page. Try `browser.scroll`, a different element, or `browser.navigate` to a more direct URL. An `[expanded]` element is already open."
    : null;
  const shellHint =
    tool.startsWith("os.shell.") || tool.startsWith("os.fs.")
      ? target
        ? `- \`${target}\` will not behave differently on a re-run — change the arguments or path, or use a different command entirely.`
        : "- Change the command, path, or arguments — repeating the same invocation will not produce a different result."
      : null;

  const lines = [
    header,
    "Change strategy BEFORE calling any tool again:",
    webHint,
    browserHint,
    shellHint,
    "- If you have enough information already, end the turn with `reply`.",
    mode === "veto"
      ? "- Do NOT repeat this exact call. Either try a different approach or close the turn with `reply` giving your best answer / honestly report you could not complete the task."
      : null,
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

/**
 * Defensive cleanup for a caller-supplied invariant label before it is
 * echoed into model context: single line, no backticks (they would break
 * the surrounding code span), length-capped. Returns `undefined` for
 * anything empty so callers degrade to the generic wording.
 */
function sanitizeLoopTarget(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[`\r\n]+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

/**
 * Extract the invariant that stayed the same across a loop's blocked
 * attempts, for use as the `target` label in guidance messages.
 *
 * Deliberately coarse: web/HTTP calls collapse to the URL's HOST and
 * shell calls to the leading command word, so no query parameters,
 * credentials, paths, or other potentially sensitive argument content
 * reaches the model context. Returns `undefined` when nothing meaningful
 * can be extracted, so the caller falls back to the generic wording.
 * Never throws on malformed args.
 */
export function extractLoopTarget(
  tool: string,
  args: unknown,
): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;

  if (tool === "os.web.fetch" || tool === "os.http.request") {
    const raw = record.url ?? record.uri ?? record.endpoint;
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
    try {
      const host = new URL(candidate).hostname;
      return host.length > 0 ? host : undefined;
    } catch {
      return undefined;
    }
  }

  if (tool === "os.shell.run") {
    const raw = record.command ?? record.cmd;
    if (typeof raw !== "string") return undefined;
    // Leading word only: the executable name, never the full argv.
    const name = raw.trim().split(/\s+/)[0];
    return name !== undefined && name.length > 0 ? name : undefined;
  }

  return undefined;
}
