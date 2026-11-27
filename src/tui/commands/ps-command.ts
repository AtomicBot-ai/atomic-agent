import {
  formatShellElapsed,
  type BackgroundJobsControl,
  type BackgroundJobView,
} from "../../tools/os/index.js";

/**
 * `/ps` and `/stop` (ATO-2437): the person sees the background jobs the
 * agent started in this chat and can stop one or all of them. Codex CLI
 * has the same pair (`/ps` lists background terminals, `/stop` ends
 * them). Parsing and the text are here; the runtime call is the
 * caller's (`tui-command.ts`), through `AgentRuntime.backgroundJobs`.
 */

export type BackgroundJobsCommand =
  | { kind: "list" }
  | { kind: "stop"; id: number }
  | { kind: "stop_all" };

export type ParsedBackgroundJobsCommand =
  | { ok: true; command: BackgroundJobsCommand }
  | { ok: false; usage: string };

const PS_USAGE = "usage: /ps (lists this chat's background jobs; takes no arguments)";
const STOP_USAGE = "usage: /stop (stops every running background job in this chat) | /stop <id> (one, the id from /ps)";

export function parsePsCommand(args: string): ParsedBackgroundJobsCommand {
  return args.trim().length === 0 ? { ok: true, command: { kind: "list" } } : { ok: false, usage: PS_USAGE };
}

export function parseStopCommand(args: string): ParsedBackgroundJobsCommand {
  const raw = args.trim().replace(/^#/, "");
  if (raw.length === 0 || raw === "all") return { ok: true, command: { kind: "stop_all" } };
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return { ok: false, usage: STOP_USAGE };
  return { ok: true, command: { kind: "stop", id: Number(raw) } };
}

function describeState(job: BackgroundJobView): string {
  const elapsed = formatShellElapsed(job.elapsedMs);
  if (job.state === "running") return `running ${elapsed}${job.keep ? ", kept" : ""}`;
  if (job.state === "killed") {
    return job.stopReason === "user" ? `stopped by you after ${elapsed}` : `stopped after ${elapsed}`;
  }
  const status = job.exitCode !== null ? `exit ${job.exitCode}` : `signal ${job.signal ?? "?"}`;
  return `finished (${status}) after ${elapsed}`;
}

/** The `/ps` text: one row per job, then what to type next. */
export function formatBackgroundJobs(jobs: readonly BackgroundJobView[]): string {
  if (jobs.length === 0) return "no background jobs in this chat";
  const rows = jobs.map((job) => {
    const monitor = job.monitor === null ? "" : `, monitor ${JSON.stringify(job.monitor)}`;
    return `  job ${job.id}  ${job.command}  ${describeState(job)}${monitor}`;
  });
  const running = jobs.some((job) => job.state === "running");
  return [
    "background jobs in this chat:",
    ...rows,
    ...(running ? ["/stop <id> stops one | /stop stops every running one"] : []),
  ].join("\n");
}

/** Run a parsed command against the runtime; the line to show. */
export function runBackgroundJobsCommand(
  command: BackgroundJobsCommand,
  sessionId: string | null,
  control: BackgroundJobsControl | undefined,
): string {
  if (sessionId === null || control === undefined) return "no background jobs in this chat";
  if (command.kind === "list") return formatBackgroundJobs(control.list(sessionId));
  if (command.kind === "stop_all") {
    const stopped = control.stopAll(sessionId);
    return stopped === 0
      ? "no running background jobs in this chat"
      : `stopped ${stopped} background job${stopped === 1 ? "" : "s"}; the agent sees that you stopped ${stopped === 1 ? "it" : "them"}`;
  }
  if (control.stop(sessionId, command.id)) {
    return `stopped background job ${command.id}; the agent sees that you stopped it`;
  }
  const exists = control.list(sessionId).some((job) => job.id === command.id);
  return exists
    ? `background job ${command.id} is not running`
    : `no background job ${command.id} in this chat; /ps lists them`;
}
