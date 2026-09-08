/**
 * The three privacy levels of an issue report.
 *
 * A bug report is a trade: the more of the session it carries, the
 * more likely the maintainer can reproduce, and the more of the
 * operator's work leaves the machine with it. That trade is the
 * operator's to make, per report, with the consequences spelled out on
 * the same screen — not a default buried in config.
 *
 * Ordered least to most revealing. `errors` is safe to send to a
 * public tracker from a machine full of client work; `full` is what
 * you send when the maintainer is a colleague and you want it fixed
 * today.
 */
export type IssueReportLevel = "errors" | "scrubbed" | "full";

export interface IssueReportLevelInfo {
  level: IssueReportLevel;
  label: string;
  /** What leaves the machine, in the operator's words. */
  detail: string;
  /** One line rendered in the issue body so the reader knows what to expect. */
  disclosure: string;
}

export const ISSUE_REPORT_LEVELS: readonly IssueReportLevelInfo[] = [
  {
    level: "errors",
    label: "Errors only",
    detail:
      "version, platform, model, the failures and warn/error log lines. No chat, no file paths.",
    disclosure:
      "errors only — no conversation, no paths, no tool arguments",
  },
  {
    level: "scrubbed",
    label: "Logs, scrubbed",
    detail:
      "plus all logs, the runtime feed, run history and session traces; paths, emails, URLs and secrets redacted, chat text removed.",
    disclosure:
      "logs and traces with paths / emails / URLs / secrets redacted; conversation text removed",
  },
  {
    level: "full",
    label: "Everything",
    detail:
      "the full debug bundle: conversation, reasoning, tool arguments and results, traces. Secrets masked.",
    disclosure:
      "full debug bundle including the conversation; only secrets are masked",
  },
];

export function issueReportLevelInfo(
  level: IssueReportLevel,
): IssueReportLevelInfo {
  const info = ISSUE_REPORT_LEVELS.find((l) => l.level === level);
  if (!info) throw new Error(`unknown issue report level ${level}`);
  return info;
}
