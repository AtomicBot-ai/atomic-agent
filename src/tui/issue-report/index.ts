/**
 * "Report an issue on GitHub" — `/report`. See AGENTS.md §"Issue reports".
 */

export {
  ISSUE_REPORT_LEVELS,
  issueReportLevelInfo,
  type IssueReportLevel,
  type IssueReportLevelInfo,
} from "./report-levels.js";
export {
  mapStrings,
  maskSecrets,
  redactPersonal,
  scrubText,
  type RedactionContext,
} from "./redact.js";
export {
  redactTraceNdjson,
  type TraceRedactionStats,
} from "./trace-redaction.js";
export {
  packIssue,
  renderSection,
  type PackedIssue,
  type ReportSection,
} from "./issue-body.js";
export {
  buildIssueReport,
  type IssueReport,
  type IssueReportFacts,
} from "./build-issue-report.js";
export {
  reportZipFileName,
  writeReportZip,
  type WriteReportZipResult,
} from "./write-report-zip.js";
export {
  createIssueReportState,
  isIssueReportAction,
  reduceIssueReport,
  type IssueReportAction,
  type IssueReportPreview,
  type IssueReportState,
  type IssueReportStep,
} from "./issue-report-state.js";
export {
  ISSUE_REPORT_DIR_NAME,
  ISSUE_REPORT_REPO,
  IssueReportOrchestrator,
  type IssueReportDeps,
} from "./issue-report-orchestrator.js";
