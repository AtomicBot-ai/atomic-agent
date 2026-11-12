/**
 * The only TUI module that builds a report, writes its zip and talks to
 * GitHub on the operator's behalf. The reducer and popup stay pure.
 *
 * Two async legs, each announced through the bus so the popup can show
 * where things stand:
 *
 *   pick(level)  → building → zip on disk → confirm (path, size, page count)
 *   send()       → sending  → issue + comments → sent (url)
 *
 * The zip is written *before* confirmation so the question on screen —
 * "send this?" — refers to a file the operator can open. Nothing
 * reaches GitHub until `send()`, and `send()` refuses without a token
 * rather than falling back to anything anonymous.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getAppVersion } from "../../version.js";
import {
  isAnalyticsKilledByEnv,
  readSupportId,
  resolveInstallChannel,
} from "../../analytics/index.js";
import {
  GITHUB_NOT_CONNECTED,
  GithubApi,
  resolveGithubToken,
  scrubGithubToken,
} from "../../github/index.js";
import type { SessionStore } from "../../session/session-store.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { buildDebugBundleSnapshot } from "../debug-bundle/build-snapshot.js";
import { selectLlmActiveRouteSummary } from "../llm-panel/llm-panel-selectors.js";
import type { TuiState } from "../tui-state.js";
import { buildIssueReport, type IssueReport } from "./build-issue-report.js";
import {
  packIssue,
  type PackedIssue,
  type ReportSection,
} from "./issue-body.js";
import type {
  IssueReportAction,
  IssueReportToggle,
} from "./issue-report-state.js";
import type { RedactionContext } from "./redact.js";
import { ISSUE_REPORT_LEVELS, type IssueReportLevel } from "./report-levels.js";
import { writeReportZip } from "./write-report-zip.js";

/** Where reports are filed. */
export const ISSUE_REPORT_REPO = {
  owner: "AtomicBot-ai",
  repo: "atomic-agent",
} as const;
export const ISSUE_REPORT_DIR_NAME = "atomic-agent-debug";
const TRACE_LIMIT = 5;
const ISSUE_LABELS = ["bug", "from-agent"];

export interface IssueReportBus {
  emit(
    action:
      | IssueReportAction
      | { type: "system_message"; text: string; variant?: "normal" | "warn" }
      | { type: "runtime_info"; line: string },
  ): void;
}

export interface IssueReportRuntime {
  config: Pick<AtomicAgentConfig, "tracing"> &
    Partial<Pick<AtomicAgentConfig, "stateDir" | "analytics">>;
  sessionStore: Pick<SessionStore, "listRecent">;
}

export interface IssueReportDeps {
  resolveToken?: () => string | null;
  apiFactory?: (
    token: string,
  ) => Pick<GithubApi, "createIssue" | "addIssueComment">;
  homeDir?: string;
  outDir?: string;
  now?: () => Date;
  /** The session on screen, so its trace is first in the zip. */
  currentSessionId?: () => string | null;
  /** Support id (ATO-1466); defaults to `readSupportId` over the state dir. */
  readSupportId?: () => string | null;
  /** Whether analytics is on; off unticks the support id by default. */
  analyticsEnabled?: () => boolean;
  /** Install channel; defaults to `resolveInstallChannel`. */
  installChannel?: () => string;
}

interface PreparedReport {
  report: IssueReport;
  packed: PackedIssue;
  zipPath: string;
  zipBytes: number;
  /** Everything `buildIssueReport` needs again when a toggle flips. */
  build: Omit<Parameters<typeof buildIssueReport>[0], "supportId" | "includeLogs">;
  /** Extra inline sections (the zipped traces) packed after the report's. */
  extraSections: readonly ReportSection[];
  supportId: string | null;
  includeSupportId: boolean;
  includeLogs: boolean;
}

export class IssueReportOrchestrator {
  private prepared: PreparedReport | null = null;
  private busy = false;
  /**
   * Bumped on every open / close. A leg that finishes after the popup
   * it belonged to was closed drops its result instead of reviving a
   * screen the operator left.
   */
  private generation = 0;

  constructor(
    private readonly runtime: IssueReportRuntime,
    private readonly bus: IssueReportBus,
    private readonly deps: IssueReportDeps = {},
  ) {}

  open(): void {
    // Not while a leg runs: the reducer refuses to reopen over it too.
    if (this.busy) return;
    this.generation += 1;
    this.prepared = null;
    this.bus.emit({ type: "issue_report_opened" });
  }

  close(): void {
    this.generation += 1;
    this.prepared = null;
    this.bus.emit({ type: "issue_report_closed" });
  }

  /** Build the report at `level` from the state on screen and write the zip. */
  async pick(level: IssueReportLevel, state: TuiState): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const generation = this.generation;
    this.bus.emit({ type: "issue_report_building" });
    try {
      const snapshot = buildDebugBundleSnapshot(state);
      const route = selectLlmActiveRouteSummary(state);
      const now = (this.deps.now ?? (() => new Date()))();
      const redaction: RedactionContext = {
        homeDir: this.deps.homeDir ?? homedir(),
        workingDir: state.session.workingDir,
      };
      const localActive = route.activeTextProvider?.kind === "llama-server";
      const backend = state.localModelsPanel.backend;
      const supportId = this.supportId();
      const includeSupportId = supportId !== null && this.analyticsEnabled();
      const build = {
        snapshot,
        level,
        redaction,
        facts: {
          version: getAppVersion(),
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          providerLabel: route.providerLabel,
          textModel: route.textModel,
          toolTransport: route.toolTransportLabel,
          approvalLevel: state.session.approvalLevel,
          codingMode: state.codingMode,
          capturedAt: now.toISOString(),
          surface: "terminal",
          installChannel: this.installChannel(),
          engine: localActive
            ? `${backend.engine ?? "local"}${backend.currentTag ? ` ${backend.currentTag}` : ""}`
            : "cloud",
        },
      };
      // The zip on disk is built without the id: the checkbox decides
      // only what goes into the issue.
      const zipReport = buildIssueReport(build);
      const zip = await writeReportZip({
        report: zipReport,
        traceDir: this.runtime.config.tracing.trace.dir,
        sessionIds: this.collectSessionIds(state),
        outDir:
          this.deps.outDir ??
          join(
            this.deps.homeDir ?? homedir(),
            "Documents",
            ISSUE_REPORT_DIR_NAME,
          ),
        redaction,
        now,
      });
      const report = includeSupportId
        ? buildIssueReport({ ...build, supportId })
        : zipReport;
      const packed = packIssue(report.header, [
        ...report.sections,
        ...zip.traceSections,
      ]);
      if (generation !== this.generation) return;
      this.prepared = {
        report,
        packed,
        zipPath: zip.path,
        zipBytes: zip.bytes,
        build,
        extraSections: zip.traceSections,
        supportId,
        includeSupportId,
        includeLogs: true,
      };
      this.emitPreview(this.prepared);
    } catch (err) {
      if (generation === this.generation) {
        this.bus.emit({ type: "issue_report_failed", error: describe(err) });
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Flip "include support ID" or "include log tail" on the confirm
   * screen (ATO-1466): rebuild the body from the same inputs (pure, the
   * zip on disk is unchanged) and show the new preview.
   */
  toggle(option: IssueReportToggle): void {
    const prepared = this.prepared;
    if (this.busy || !prepared) return;
    if (option === "supportId") {
      // Nothing to include without an id; the row says why.
      if (prepared.supportId === null) return;
      prepared.includeSupportId = !prepared.includeSupportId;
    } else {
      prepared.includeLogs = !prepared.includeLogs;
    }
    prepared.report = buildIssueReport({
      ...prepared.build,
      supportId: prepared.includeSupportId ? prepared.supportId : null,
      includeLogs: prepared.includeLogs,
    });
    prepared.packed = packIssue(prepared.report.header, [
      ...prepared.report.sections,
      ...prepared.extraSections,
    ]);
    this.emitPreview(prepared);
  }

  /** File the prepared report as a GitHub issue. */
  async send(): Promise<void> {
    if (this.busy) return;
    const prepared = this.prepared;
    if (!prepared) {
      this.bus.emit({
        type: "issue_report_failed",
        error: "nothing to send — pick a level first",
      });
      return;
    }
    const token = (this.deps.resolveToken ?? (() => resolveGithubToken()))();
    if (!token) {
      this.bus.emit({
        type: "issue_report_failed",
        error: GITHUB_NOT_CONNECTED,
      });
      return;
    }
    this.busy = true;
    this.bus.emit({ type: "issue_report_sending" });
    try {
      const api = (
        this.deps.apiFactory ?? ((t: string) => new GithubApi({ token: t }))
      )(token);
      const issue = await api.createIssue({
        ...ISSUE_REPORT_REPO,
        title: prepared.report.title,
        body: prepared.packed.body,
        labels: ISSUE_LABELS,
      });
      let posted = 0;
      for (const comment of prepared.packed.comments) {
        try {
          await api.addIssueComment({
            ...ISSUE_REPORT_REPO,
            number: issue.number,
            body: comment,
          });
          posted += 1;
        } catch (err) {
          // The issue exists; a lost comment is a note, not a failure.
          this.bus.emit({
            type: "runtime_info",
            line: `issue report: comment ${posted + 1}/${prepared.packed.comments.length} failed: ${describe(err)}`,
          });
          break;
        }
      }
      this.prepared = null;
      this.bus.emit({ type: "issue_report_sent", url: issue.htmlUrl });
      this.bus.emit({
        type: "system_message",
        text: `Issue filed: ${issue.htmlUrl}\n  report zip: ${prepared.zipPath}${prepared.packed.overflow.length > 0 ? "\n  some sections were too large to inline — drag the zip into the issue if the maintainer asks" : ""}`,
      });
    } catch (err) {
      this.bus.emit({ type: "issue_report_failed", error: describe(err) });
    } finally {
      this.busy = false;
    }
  }

  private emitPreview(prepared: PreparedReport): void {
    this.bus.emit({
      type: "issue_report_previewed",
      preview: {
        level: prepared.report.level,
        zipPath: prepared.zipPath,
        zipBytes: prepared.zipBytes,
        title: prepared.report.title,
        bodyChars: prepared.packed.body.length,
        comments: prepared.packed.comments.length,
        overflow: prepared.packed.overflow,
        supportId: prepared.supportId,
        includeSupportId: prepared.includeSupportId,
        includeLogs: prepared.includeLogs,
      },
    });
  }

  private supportId(): string | null {
    try {
      if (this.deps.readSupportId) return this.deps.readSupportId();
      const stateDir = this.runtime.config.stateDir;
      return stateDir ? readSupportId({ stateDir }) : null;
    } catch {
      return null;
    }
  }

  private analyticsEnabled(): boolean {
    if (this.deps.analyticsEnabled) return this.deps.analyticsEnabled();
    if (isAnalyticsKilledByEnv()) return false;
    return this.runtime.config.analytics?.enabled ?? true;
  }

  private installChannel(): string {
    if (this.deps.installChannel) return this.deps.installChannel();
    const stateDir = this.runtime.config.stateDir;
    try {
      return stateDir ? resolveInstallChannel(stateDir) : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Levels in picker order, so the key layer and the popup agree. */
  levelAt(cursor: number): IssueReportLevel {
    return (ISSUE_REPORT_LEVELS[cursor] ?? ISSUE_REPORT_LEVELS[0]!).level;
  }

  private collectSessionIds(state: TuiState): string[] {
    const ids: string[] = [];
    const current = this.deps.currentSessionId?.() ?? state.session.sessionId;
    if (current) ids.push(current);
    try {
      for (const s of this.runtime.sessionStore.listRecent(TRACE_LIMIT)) {
        if (!ids.includes(s.id)) ids.push(s.id);
      }
    } catch {
      // A session-store hiccup costs older traces, not the report.
    }
    return ids.slice(0, TRACE_LIMIT);
  }
}

function describe(err: unknown): string {
  return scrubGithubToken(err instanceof Error ? err.message : String(err));
}
