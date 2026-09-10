/**
 * From a debug-bundle snapshot to the pieces of a GitHub issue.
 *
 * Three levels, one function: the level decides which fields survive
 * and which redaction pass runs over the survivors, and the result is
 * both the markdown the maintainer reads and the JSON that goes in the
 * zip. Pure — the orchestrator supplies the snapshot, the facts and the
 * clock, so a test can pin exactly what each level lets through.
 */

import type { DebugBundleSnapshot } from "../debug-bundle/build-snapshot.js";
import type { LogRecord } from "../../tracing/structured-logger.js";
import type { ReportSection } from "./issue-body.js";
import {
  mapStrings,
  maskSecrets,
  redactPaths,
  scrubText,
  type RedactionContext,
} from "./redact.js";
import {
  issueReportLevelInfo,
  type IssueReportLevel,
} from "./report-levels.js";

/** Environment facts the orchestrator reads at report time. */
export interface IssueReportFacts {
  version: string;
  platform: string;
  arch: string;
  node: string;
  providerLabel: string;
  textModel: string | null;
  toolTransport: string;
  approvalLevel: number;
  codingMode: string;
  capturedAt: string;
}

export interface IssueReport {
  level: IssueReportLevel;
  title: string;
  /** Opens the issue body; never cut by the packer. */
  header: string;
  sections: ReportSection[];
  /** The level-filtered snapshot, for the zip. */
  snapshot: Record<string, unknown>;
}

const MAX_LOG_LINES = 400;
const MAX_FEED_LINES = 400;
const MAX_RUNS = 30;

export function buildIssueReport(input: {
  snapshot: DebugBundleSnapshot;
  facts: IssueReportFacts;
  level: IssueReportLevel;
  redaction: RedactionContext;
}): IssueReport {
  const { snapshot, facts, level, redaction } = input;
  // Both reduced levels mask absolute paths: `redactPersonal` only knows
  // the home and working directories, so a path into another project —
  // or one the model mistyped, which end-to-end testing turned up — sails
  // through, and the level's own copy promises paths are redacted.
  const scrub = (s: string): string =>
    level === "full" ? maskSecrets(s) : redactPaths(scrubText(s, redaction));
  const deep = (v: unknown): unknown => mapStrings(v, scrub);
  // A model name can be a GGUF path on a local backend.
  const safeFacts = deep(facts) as IssueReportFacts;

  const lastRunStatus =
    snapshot.lastRunStatus === null ? null : scrub(snapshot.lastRunStatus);
  const runs = snapshot.runHistory.slice(-MAX_RUNS).map((r) => ({
    outcome: r.outcome,
    reason: scrub(r.reason),
    stepCount: r.stepCount,
    durationMs: r.durationMs,
    finishedAt: r.finishedAt,
    ...(level === "full" ? { message: scrub(r.message) } : {}),
  }));
  const logs = (
    level === "errors"
      ? snapshot.logs.filter((l) => l.level === "warn" || l.level === "error")
      : snapshot.logs
  )
    .slice(-MAX_LOG_LINES)
    .map((l) => ({
      timestamp: l.timestamp,
      level: l.level,
      message: scrub(l.message),
      ...(l.context === undefined
        ? {}
        : { context: deep(dropJoinKeys(l.context, level)) }),
    }));

  const title = buildTitle(lastRunStatus, safeFacts);
  const header = buildHeader(title, safeFacts, level, snapshot);
  const sections: ReportSection[] = [];

  if (runs.length > 0) {
    sections.push({
      title: `Run history (${runs.length})`,
      body: runs
        .map(
          (r) =>
            `${new Date(r.finishedAt).toISOString()}  ${r.outcome.padEnd(9)} ${r.stepCount} steps  ${r.durationMs} ms${r.reason ? `  — ${r.reason}` : ""}`,
        )
        .join("\n"),
      fenced: true,
      lang: "text",
      collapsed: true,
    });
  }
  sections.push({
    title:
      level === "errors"
        ? `Warnings and errors (${logs.length})`
        : `Logs (${logs.length})`,
    body: logs.length > 0 ? logs.map(formatLog).join("\n") : "(none)",
    fenced: true,
    lang: "text",
    collapsed: true,
  });

  const filtered: Record<string, unknown> = {
    level,
    capturedAt: facts.capturedAt,
    facts: safeFacts,
    session: sessionFacts(snapshot, level, scrub),
    lastRunStatus,
    runHistory: runs,
    logs,
    metrics: snapshot.metrics,
  };

  if (level !== "errors") {
    const feed = snapshot.feed.slice(-MAX_FEED_LINES).map((f) => ({
      timestamp: f.timestamp,
      kind: f.kind,
      stepIndex: f.stepIndex,
      line: scrub(level === "full" ? f.line : stripToolPayload(f.kind, f.line)),
    }));
    filtered.feed = feed;
    sections.push({
      title: `Runtime feed (${feed.length})`,
      body:
        feed.length > 0
          ? feed
              .map(
                (f) =>
                  `${new Date(f.timestamp).toISOString().slice(11, 19)} ${f.kind} ${f.line}`,
              )
              .join("\n")
          : "(none)",
      fenced: true,
      lang: "text",
      collapsed: true,
    });
  }

  if (level === "scrubbed") {
    // Shape of the conversation without its words: which tools ran,
    // how many steps, which turns failed.
    filtered.messages = snapshot.messages.map((m) => ({
      role: m.role,
      ...(m.variant === undefined ? {} : { variant: m.variant }),
      timestamp: m.timestamp,
      chars: m.text.length,
      tools: (m.toolCards ?? []).map((c) => c.tool),
    }));
  }
  if (level === "full") {
    filtered.uiMode = snapshot.uiMode;
    filtered.activeTab = snapshot.activeTab;
    filtered.messages = deep(snapshot.messages);
    filtered.reasoning = deep(snapshot.reasoning);
    sections.push({
      title: `Conversation (${snapshot.messages.length} messages)`,
      body: snapshot.messages
        .map((m) => `[${m.role}] ${scrub(m.text)}`)
        .join("\n\n"),
      fenced: true,
      lang: "text",
      collapsed: true,
    });
  }

  return { level, title, header, sections, snapshot: filtered };
}

function buildTitle(
  lastRunStatus: string | null,
  facts: IssueReportFacts,
): string {
  if (lastRunStatus && /^failed/i.test(lastRunStatus)) {
    const line = lastRunStatus.replace(/^failed\s*/i, "").split("\n")[0] ?? "";
    const short = line.length > 90 ? `${line.slice(0, 87)}…` : line;
    return `Turn failed ${short}`.trim();
  }
  return `Issue report from atomic-agent v${facts.version}`;
}

function buildHeader(
  title: string,
  facts: IssueReportFacts,
  level: IssueReportLevel,
  snapshot: DebugBundleSnapshot,
): string {
  const info = issueReportLevelInfo(level);
  const rows: [string, string][] = [
    ["Version", facts.version],
    ["Platform", `${facts.platform} ${facts.arch}, node ${facts.node}`],
    [
      "Provider",
      `${facts.providerLabel}${facts.textModel ? ` · ${facts.textModel}` : ""} (${facts.toolTransport})`,
    ],
    ["Approval level", `${facts.approvalLevel} · mode ${facts.codingMode}`],
    ["Last run", snapshot.lastRunStatus === null ? "—" : "see below"],
    ["Captured", facts.capturedAt],
    ["Report level", `${info.label} — ${info.disclosure}`],
  ];
  const table = [
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| **${k}** | ${escapeCell(v)} |`),
  ].join("\n");
  return [
    `**What happened:** _(describe what you were doing — the details below were attached automatically)_`,
    "",
    table,
    "",
    `_Filed from atomic-agent's \`/report\`. Title: ${title}_`,
  ].join("\n");
}

function sessionFacts(
  snapshot: DebugBundleSnapshot,
  level: IssueReportLevel,
  scrub: (s: string) => string,
): Record<string, unknown> {
  const s = snapshot.session;
  const base = {
    approvalLevel: s.approvalLevel,
    maxSteps: s.maxSteps,
    completionMaxTokens: s.completionMaxTokens,
    skillCount: s.skillCount,
    browserChannel: s.browserChannel,
    browserHeadless: s.browserHeadless,
    localBackendConfigured: s.localBackendConfigured,
  };
  if (level === "errors") return base;
  return {
    ...base,
    // The session id is a join key; only the full level carries it.
    ...(level === "full" ? { sessionId: s.sessionId } : {}),
    workingDir: scrub(s.workingDir),
    llamaUrl: scrub(s.llamaUrl),
  };
}

/**
 * Strip the keys that join a report back to the operator's other
 * files. A log record's `context` carries `sessionId` on every "tool
 * executed" line, which is how a session id survived the trace-level
 * and session-facts stripping and reached a `scrubbed` report — found
 * by end-to-end testing.
 */
function dropJoinKeys(context: unknown, level: IssueReportLevel): unknown {
  if (level === "full") return context;
  if (typeof context !== "object" || context === null) return context;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "sessionId") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Feed rows quote the session back at the reader, and below `full` the
 * quote has to go while the shape stays.
 *
 * A tool call carries its arguments and its result preview
 * (`→ tool({…})`, `← tool ok: …`). A step row carries the step's
 * summary, which is the first tool result for a tool step and the
 * assistant's own reply for the last one — so `step_finished` was
 * putting the model's answer, verbatim, into a report whose level
 * promises the conversation is removed. Found by end-to-end testing:
 * it reached both the zip and the public issue body.
 */
export function stripToolPayload(kind: string, line: string): string {
  if (kind === "tool_call_parsed") {
    const open = line.indexOf("(");
    return open === -1 ? line : `${line.slice(0, open)}(…)`;
  }
  if (kind === "tool_call_executed") {
    const colon = line.indexOf(":");
    return colon === -1 ? line : `${line.slice(0, colon)}: …`;
  }
  if (STEP_SUMMARY_KINDS.has(kind)) {
    // Keep the `[step N]` / `»` marker and the trailing `(123ms)`;
    // everything between them is the summary.
    const marker = /^(\s*(?:\[step \d+\]|»|✗|●)?\s*)/.exec(line)?.[1] ?? "";
    const timing = /\s(\(\d+ms\))\s*$/.exec(line)?.[1] ?? "";
    return `${marker}…${timing ? ` ${timing}` : ""}`;
  }
  return line;
}

/**
 * Feed kinds whose line is a summary of what happened rather than a
 * label for it.
 */
const STEP_SUMMARY_KINDS: ReadonlySet<string> = new Set([
  "step_finished",
  "step_error",
  "loop_completed",
  "loop_failed",
]);

function formatLog(l: {
  timestamp: number;
  level: LogRecord["level"];
  message: string;
  context?: unknown;
}): string {
  const ctx = l.context === undefined ? "" : ` ${safeJson(l.context)}`;
  return `${new Date(l.timestamp).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.message}${ctx}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
