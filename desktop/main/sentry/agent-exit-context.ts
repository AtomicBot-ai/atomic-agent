/**
 * ATO-2416 — more about an AgentExited report, as words from closed lists.
 *
 * Desktop 0.0.10 still reports the agent leaving under a running app, and
 * the tags it had (exit-reason.ts) could not tell a crash from an agent that
 * closed itself on purpose. A stop the app makes never reaches the report
 * (agent-client childExited: a child in `stopped` reads as stopped), so an
 * agent that says it closed was told to by someone else. `atag serve` says
 * why it is closing in one of its own `[atomic-agent]` lines
 * (src/cli/serve-command.ts, serve-memory-guard.ts). Those lines are INFO,
 * so they never reach the ring of last error lines that exit-reason.ts
 * reads: this reads them as they pass, and answers ONE word.
 *
 * Pure: no Electron, no fs. The unit test drives it on made-up lines.
 */

export const AGENT_CLOSE_WORDS = ["sigterm", "sigint", "sighup", "parent_exited", "parent_exited_busy", "memory_guard", "serve_failed"] as const;
export type AgentCloseWord = (typeof AGENT_CLOSE_WORDS)[number];

/**
 * The reason a line of serve's own says it is closing, or null for any other
 * line. Matched on serve's fixed wording only; the rest of the line (a path,
 * a stack) is never read out.
 */
export function agentCloseWord(line: string): AgentCloseWord | null {
  const l = line.replace(/^[!\s]+/, "");
  // serve-command.ts: `[atomic-agent] ${signal} received, closing`.
  const sig = /^\[atomic-agent\] (SIGTERM|SIGINT|SIGHUP) received, closing/.exec(l);
  if (sig) return sig[1]!.toLowerCase() as AgentCloseWord;
  // serve-command.ts waitForOrphaning: the orphan watch saw the parent (or Windows' stand-in for it) go.
  if (/^\[atomic-agent\] parent exited and no turn is running, closing/.test(l)) return "parent_exited";
  if (/^\[atomic-agent\] parent exited; finishing the turn in flight before closing/.test(l)) return "parent_exited_busy";
  // serve-memory-guard.ts: the guard ends serve with MEMORY_GUARD_EXIT_CODE.
  if (/^\[atomic-agent\] memory guard: closing the agent cleanly/.test(l)) return "memory_guard";
  // serve-command.ts: a boot that threw, `serve failed: <stack>`.
  if (/^serve failed:/.test(l)) return "serve_failed";
  return null;
}

/**
 * The close word for the agent's lines so far: the newest one seen wins
 * (`parent_exited_busy` gives way to the `parent_exited` that follows once
 * the turn is done). Null: it never said.
 */
export function nextCloseWord(was: AgentCloseWord | null, line: string): AgentCloseWord | null {
  return agentCloseWord(line) ?? was;
}

/** Turns streaming from the agent when it went, as a bucket: "0" is an idle agent, which no turn's work can explain. */
export function turnsBucket(n: number | null | undefined): "0" | "1" | "gt_1" | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  if (n === 0) return "0";
  if (n === 1) return "1";
  return "gt_1";
}

/**
 * Who ended the agent, as far as the app can tell (the `stopped_by` tag):
 *  - `os`: the system was shutting down or logging off (powerMonitor
 *    `shutdown`, the window's `session-end`) before the app's own quit;
 *  - `outside_signal`: serve said it got a signal the app did not send;
 *  - `parent_gone`: serve's orphan watch closed it (on Windows, its stand-in
 *    for the app went);
 *  - `memory_guard`: serve's own guard, before the system ran out;
 *  - `self`: it went with no word of why: a crash, a kill, an abort.
 */
export function stoppedBy(closed: AgentCloseWord | null, osEnding: boolean): "os" | "outside_signal" | "parent_gone" | "memory_guard" | "boot_failed" | "self" {
  if (osEnding) return "os";
  switch (closed) {
    case "sigterm":
    case "sigint":
    case "sighup":
      return "outside_signal";
    case "parent_exited":
    case "parent_exited_busy":
      return "parent_gone";
    case "memory_guard":
      return "memory_guard";
    case "serve_failed":
      return "boot_failed";
    default:
      return "self";
  }
}
