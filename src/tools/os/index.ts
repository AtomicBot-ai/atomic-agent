import { resolve } from "node:path";
import type { ToolRegistry } from "../tool-registry.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { createToolSecretSource } from "../../config/tool-secrets.js";
import { buildOsShellTool } from "./shell/shell.js";
import type { ShellGuardPolicy } from "./shell-command-guard/index.js";
import type { ShellJobRegistry } from "./shell/shell-jobs.js";
import { osFsReadTool } from "./fs/fs-read.js";
import { buildOsFsWriteTool } from "./fs/fs-write.js";
import { buildOsFsTrashTool } from "./fs/fs-trash.js";
import { osFsListTool } from "./fs/fs-list.js";
import { osFsGlobTool } from "./fs/fs-glob.js";
import { buildOsFsLocateProjectTool } from "./fs/fs-locate-project.js";
import { buildOsFsCodeMapTool } from "./code-map/index.js";
import {
  buildOsCodeLspTool,
  buildOsCodeRewriteTool,
  buildOsCodeSearchTool,
} from "./code/index.js";
import type { RecentSessionDir } from "./fs/fs-locate-project-sources.js";
import { buildOsFsGrepTool } from "./fs/fs-grep.js";
import { buildOsFsEditTool } from "./fs/fs-edit.js";
import { buildOsFsReadDocumentTool } from "./read-document/index.js";
import { buildOsFsWritePptxTool, type OsFsWritePptxOptions } from "./pptx/index.js";
import { buildOsFsDocxTool, buildOsFsXlsxTool } from "./office/index.js";
import {
  buildOsFsArchiveListTool,
  buildOsFsArchiveReadEntryTool,
  buildOsFsArchiveExtractTool,
} from "./archive/index.js";
import { buildOsHttpRequestTool } from "./web/http-request.js";
import { buildOsWebFetchTool } from "./web/web-fetch.js";
import { buildOsWebCrawlTool } from "./web/web-crawl.js";
import type { PageRenderer } from "./web/web-fetch-ladder.js";
import { buildOsWebSearchTool, type WebSearchKeyHelp } from "./web-search/index.js";
import { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
import { osWindowListTool, osWindowFocusTool } from "./window.js";
import { buildOsEmailInboxTool, buildOsEmailSendTool } from "./email.js";
import { osNotifyTool } from "./notify.js";
import { osFsHashTool } from "./fs/fs-hash.js";
import { osFsDiffTool } from "./fs/fs-diff.js";
import { buildOsFsPatchTool } from "./fs/fs-patch.js";
import { buildOsFsRestoreTool } from "./fs/fs-restore.js";
import { buildOsFsMoveTool } from "./fs/fs-move.js";
import { FileRestoreStore } from "./fs/fs-restore-store.js";
import { createLspDiagnostics, createLspServerPool, type LspServerPool } from "./fs/lsp/index.js";
import { askToStartLspThroughApprovals } from "./fs/lsp/lsp-start-question.js";
import type { DeclaredInputsRegistry } from "./fs/fs-declared-inputs.js";
import { osFsWatchTool } from "./fs/fs-watch.js";
import {
  osGitStatusTool,
  osGitLogTool,
  osGitDiffTool,
  osGitShowTool,
  osGitBlameTool,
  osGitBranchTool,
  buildOsGitInitTool,
  buildOsGitAddTool,
  buildOsGitCheckoutTool,
  buildOsGitCommitTool,
  buildOsGitRemoteTool,
  buildOsGitFetchTool,
  buildOsGitPullTool,
  buildOsGitPushTool,
  buildOsGitCloneTool,
} from "./git/index.js";
import { osProcListTool, buildOsProcKillTool } from "./proc/index.js";

export { buildOsShellTool } from "./shell/shell.js";
export { osFsReadTool } from "./fs/fs-read.js";
export { buildOsFsWriteTool } from "./fs/fs-write.js";
export { buildOsFsTrashTool } from "./fs/fs-trash.js";
export { osFsListTool } from "./fs/fs-list.js";
export { osFsGlobTool } from "./fs/fs-glob.js";
export {
  buildOsFsLocateProjectTool,
  type OsFsLocateProjectDeps,
} from "./fs/fs-locate-project.js";
export type { RecentSessionDir } from "./fs/fs-locate-project-sources.js";
export { buildOsFsGrepTool } from "./fs/fs-grep.js";
export { buildOsFsEditTool } from "./fs/fs-edit.js";
export { buildOsFsReadDocumentTool } from "./read-document/index.js";
export { buildOsFsWritePptxTool } from "./pptx/index.js";
export { buildOsFsDocxTool, buildOsFsXlsxTool } from "./office/index.js";
export {
  buildOsFsArchiveListTool,
  buildOsFsArchiveReadEntryTool,
  buildOsFsArchiveExtractTool,
} from "./archive/index.js";
export { buildOsHttpRequestTool } from "./web/http-request.js";
export { buildOsWebFetchTool } from "./web/web-fetch.js";
export { buildOsWebCrawlTool } from "./web/web-crawl.js";
export type { PageRenderer } from "./web/web-fetch-ladder.js";
export { buildOsWebSearchTool } from "./web-search/index.js";
export type { WebSearchKeyHelp } from "./web-search/index.js";
export { osClipboardReadTool, osClipboardWriteTool } from "./clipboard.js";
export { osWindowListTool, osWindowFocusTool } from "./window.js";
export { osNotifyTool } from "./notify.js";
export { claimScreenOverlay, OS_SCREEN_TOOL_NAMES, registerOsScreenTools } from "./screen/index.js";
export type { RegisterOsScreenToolsOptions } from "./screen/index.js";
export { buildOsEmailInboxTool, buildOsEmailSendTool } from "./email.js";
export { osFsHashTool } from "./fs/fs-hash.js";
export { osFsDiffTool } from "./fs/fs-diff.js";
export { buildOsFsPatchTool } from "./fs/fs-patch.js";
export { buildOsFsRestoreTool } from "./fs/fs-restore.js";
export { buildOsFsMoveTool, type OsFsMoveDeps } from "./fs/fs-move.js";
export { FileRestoreStore } from "./fs/fs-restore-store.js";
export { checkInputReplacement, refuseInputReplacement } from "./fs/fs-input-guard.js";
export type { InputGuardInput, InputRefusal } from "./fs/fs-input-guard.js";
export { DeclaredInputsRegistry } from "./fs/fs-declared-inputs.js";
export { osFsWatchTool } from "./fs/fs-watch.js";
export {
  osGitStatusTool,
  osGitLogTool,
  osGitDiffTool,
  osGitShowTool,
  osGitBlameTool,
  osGitBranchTool,
  buildOsGitInitTool,
  buildOsGitAddTool,
  buildOsGitCheckoutTool,
  buildOsGitCommitTool,
  buildOsGitRemoteTool,
  buildOsGitFetchTool,
  buildOsGitPullTool,
  buildOsGitPushTool,
  buildOsGitCloneTool,
} from "./git/index.js";
export { osProcListTool, buildOsProcKillTool } from "./proc/index.js";
export { isGogCommand } from "./shell-command-guard/index.js";
export type { ShellGuardPolicy } from "./shell-command-guard/index.js";
export {
  describeShellTimeoutDefault,
  formatShellDetachNotice,
  formatShellDuration,
  formatShellElapsed,
  formatShellTimeoutNotice,
  resolveShellTimeout,
} from "./shell/shell-timeout.js";
export type {
  ResolvedShellTimeout,
  ShellTimeoutSource,
} from "./shell/shell-timeout.js";
export {
  DEFAULT_SHELL_JOB_MAX_MS,
  DEFAULT_SHELL_MAX_JOBS,
  ShellJobRegistry,
} from "./shell/shell-jobs.js";
export type {
  ShellJobRecord,
  ShellJobRegistryOptions,
  ShellJobState,
  ShellJobStopReason,
} from "./shell/shell-jobs.js";
export { createShellJobHostControls, SHELL_JOB_INPUT_MAX_CHARS } from "./shell/shell-job-host.js";
export type {
  ShellJobHostControls,
  ShellJobResizeOutcome,
  ShellJobStopOutcome,
  ShellJobView,
  ShellJobWriteOutcome,
} from "./shell/shell-job-host.js";
export { createBackgroundJobsControl } from "./shell/background-jobs-control.js";
export type { BackgroundJobsControl, BackgroundJobView } from "./shell/background-jobs-control.js";
export type { MonitorWake, MonitorWakeHandler } from "./shell/shell-monitor-wake.js";

export interface RegisterOsToolsOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "http" | "web" | "projects" | "tools">;
  /**
   * Column-only recent-session projection for `os.fs.locate_project`
   * (`SessionStore.listRecentWorkingDirs`). A closure so the caller
   * decides which store backs it; must be callable by the time the
   * first tool invocation happens.
   */
  listRecentSessionDirs: (limit: number) => readonly RecentSessionDir[];
  /**
   * Absolute paths of the agent's trust config (`config.json`, `.env`),
   * resolved once by the bootstrap from `config.paths`
   * (`getTrustConfigPaths`) and threaded into every fs-mutating tool. The
   * tools layer never derives this — it does not know *where* the trust
   * surface lives. Omitted / empty disables the `trust_config` guard.
   */
  trustConfigPaths?: readonly string[];
  /**
   * Absolute state directory (`config.paths.stateDir`), resolved by the
   * bootstrap and threaded into `os.web.search` so its result cache and
   * provider cooldown can survive the process (#256), and into the fs
   * mutation tools as `<stateDir>/restore/` — where a replaced user
   * file's previous content is kept for `os.fs.restore`. Omitted keeps
   * the search cache in-memory and turns the replace guard off, which is
   * what existing embedders and tests get.
   */
  stateDir?: string;
  /**
   * The operator's request behind the turn running on a session (the
   * bootstrap's per-turn record the workers' briefs quote), for the
   * input refusal of `os.fs.write` (`fs-input-guard.ts`). Omitted
   * (embedders, tests) leaves only the F36 warn-and-save path.
   */
  resolveOriginalRequest?: (sessionId: string) => string | undefined;
  /** The agent's reply before the turn's user message, for the same refusal (ATO-860). */
  resolvePreviousReply?: (sessionId: string) => string | undefined;
  /** A fan-out's declared inputs per worker session (`fs-declared-inputs.ts`); omitted declares nothing. */
  declaredInputs?: Pick<DeclaredInputsRegistry, "inputsOf">;
  /**
   * Operator policy for the shell guard — today the git remote-sync
   * switch. Predicates rather than values so a toggle flipped live in
   * the Integrations hub is honoured on the next command. Omitted
   * disables the policy layer (embedders, tests).
   */
  shellPolicy?: ShellGuardPolicy;
  /**
   * The registry of commands `os.shell.run` detached at the default
   * timeout (F47). The bootstrap owns it so the turn-end, session-end
   * and shutdown paths can stop the jobs; omitted (embedders, tests)
   * the tool keeps a private one whose jobs die only at the ceiling.
   */
  shellJobs?: ShellJobRegistry;
  /**
   * Where the user adds an Exa key, for the advice in an `os.web.search`
   * error (ATO-345). The terminal UI passes `integrations-hub`; omitted
   * keeps the desktop / `.env` advice.
   */
  webSearchKeyHelp?: WebSearchKeyHelp;
  /**
   * Renders a page that answered `os.web.fetch` with a bot wall in the
   * agent's own browser (ATO-968). The composition root builds it from
   * the browser backend; absent ⇒ the fetch ladder skips that step.
   */
  webFetchRenderPage?: PageRenderer;
  /**
   * Whether the operator trusts a folder (project folder trust,
   * `skills.projectTrust`), read live. A language server (ATO-503)
   * starts without a question only in a trusted work tree; elsewhere the
   * first start asks once. Omitted: no folder is trusted.
   */
  isTrustedProject?: (dir: string) => boolean;
  /**
   * Filled with the language-server pool when `tools.lsp.enabled` built
   * one, so `@problems` (ATO-2472) reads the same servers as the tools.
   */
  lspPoolRef?: LspPoolRef;
  /** ATO-2444: each slide `os.fs.write_pptx` lays out, for the session's UIs. Omitted: none. */
  onPptxProgress?: OsFsWritePptxOptions["onProgress"];
}

/** Where registerOsTools leaves its language-server pool (ATO-2472). */
export interface LspPoolRef {
  pool?: LspServerPool;
}

export function registerOsTools(
  registry: ToolRegistry,
  options: RegisterOsToolsOptions,
): void {
  registry.register(
    buildOsShellTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
      defaultTimeoutMs: options.config.tools.shell.defaultTimeoutMs,
      envPassthrough: options.config.tools.shell.envPassthrough,
      ...(options.stateDir === undefined
        ? {}
        : {
            stateDir: options.stateDir,
            // `{{secret:NAME}}` (ATO-476): `toolSecrets` of `<stateDir>/secret-sources.json`.
            secrets: createToolSecretSource(options.stateDir),
          }),
      ...(options.shellPolicy === undefined
        ? {}
        : { shellPolicy: options.shellPolicy }),
      ...(options.shellJobs === undefined ? {} : { jobs: options.shellJobs }),
    }),
  );
  // Opt-in (ATO-503, ATO-2373): one pool of language servers for the
  // after-edit diagnostics and `os.code.lsp`; nothing starts until the
  // first use inside a git repository.
  const lspPool =
    options.config.tools.lsp?.enabled === true
      ? createLspServerPool({
          // A server runs project code: outside a trusted folder the
          // first start in a work tree asks once (trust_config).
          askToStart: askToStartLspThroughApprovals({
            approvals: options.approvals,
            approvalRequired: options.approvalRequired,
          }),
          ...(options.isTrustedProject === undefined
            ? {}
            : { isTrustedProject: options.isTrustedProject }),
        })
      : null;
  if (lspPool !== null && options.lspPoolRef !== undefined) options.lspPoolRef.pool = lspPool;
  // One option bag for every tool that replaces file content, so the
  // write, the edit, the patch and the restore share the store that
  // remembers what each session created and what was replaced in each
  // working directory (by any session — a fusion worker's included).
  const fsMutation = {
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
    trustConfigPaths: options.trustConfigPaths,
    ...(options.stateDir === undefined
      ? {}
      : { restore: new FileRestoreStore(resolve(options.stateDir, "restore")) }),
    ...(options.resolveOriginalRequest === undefined
      ? {}
      : { resolveOriginalRequest: options.resolveOriginalRequest }),
    ...(options.resolvePreviousReply === undefined
      ? {}
      : { resolvePreviousReply: options.resolvePreviousReply }),
    ...(options.declaredInputs === undefined
      ? {}
      : { declaredInputs: options.declaredInputs }),
    ...(lspPool !== null
      ? { lspDiagnostics: createLspDiagnostics({ enabled: true, pool: lspPool }) }
      : {}),
  };
  registry.register(osFsReadTool);
  registry.register(buildOsFsWriteTool(fsMutation));
  registry.register(buildOsFsTrashTool(options));
  registry.register(osFsListTool);
  registry.register(osFsGlobTool);
  registry.register(
    buildOsFsLocateProjectTool({
      listRecentSessions: options.listRecentSessionDirs,
      projectRoots: options.config.projects.roots,
    }),
  );
  registry.register(buildOsFsCodeMapTool());
  registry.register(buildOsFsGrepTool());
  registry.register(buildOsFsEditTool(fsMutation));
  registry.register(buildOsFsReadDocumentTool());
  // The same bag as os.fs.write: an input deck is refused, a replaced
  // one keeps a restore copy.
  registry.register(
    buildOsFsWritePptxTool({
      ...fsMutation,
      ...(options.onPptxProgress === undefined ? {} : { onProgress: options.onPptxProgress }),
    }),
  );
  registry.register(buildOsFsDocxTool(fsMutation));
  registry.register(buildOsFsXlsxTool(fsMutation));
  registry.register(buildOsFsArchiveListTool());
  registry.register(buildOsFsArchiveReadEntryTool());
  registry.register(
    buildOsFsArchiveExtractTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
      trustConfigPaths: options.trustConfigPaths,
    }),
  );
  registry.register(
    buildOsHttpRequestTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
      config: options.config,
      // The same live threshold the shell guard reads (ATO-2505).
      ...(options.shellPolicy?.argScanThreshold === undefined
        ? {}
        : { argScanThreshold: options.shellPolicy.argScanThreshold }),
      // `{{secret:NAME}}` in a header value (ATO-2530), from the same
      // `toolSecrets` as the shell's.
      ...(options.stateDir === undefined
        ? {}
        : { secrets: createToolSecretSource(options.stateDir) }),
    }),
  );
  registry.register(
    buildOsWebSearchTool({
      config: options.config,
      stateDir: options.stateDir,
      ...(options.webSearchKeyHelp === undefined
        ? {}
        : { keyHelp: options.webSearchKeyHelp }),
    }),
  );
  registry.register(
    buildOsWebFetchTool({
      config: options.config,
      dangerous: {
        approvals: options.approvals,
        approvalRequired: options.approvalRequired,
      },
      ...(options.webFetchRenderPage === undefined
        ? {}
        : { renderPage: options.webFetchRenderPage }),
    }),
  );
  registry.register(
    buildOsWebCrawlTool({
      config: options.config,
      ...(options.webFetchRenderPage === undefined
        ? {}
        : { renderPage: options.webFetchRenderPage }),
    }),
  );
  registry.register(osClipboardReadTool);
  registry.register(osClipboardWriteTool);
  registry.register(osWindowListTool);
  registry.register(osWindowFocusTool);
  registry.register(osNotifyTool);
  registry.register(
    buildOsEmailInboxTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
  registry.register(
    buildOsEmailSendTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
  registry.register(osFsHashTool);
  registry.register(osFsDiffTool);
  registry.register(buildOsFsPatchTool(fsMutation));
  registry.register(buildOsFsRestoreTool(fsMutation));
  registry.register(buildOsFsMoveTool(fsMutation));
  // Structural search / rewrite through the user's ast-grep CLI (ATO-696);
  // the rewrite rides the same write funnel and guards as the patch.
  registry.register(buildOsCodeSearchTool());
  registry.register(buildOsCodeRewriteTool(fsMutation));
  // Language-server navigation (ATO-2373): only with `tools.lsp.enabled`.
  if (lspPool !== null) registry.register(buildOsCodeLspTool({ pool: lspPool }));
  registry.register(osFsWatchTool);
  registry.register(osGitStatusTool);
  registry.register(osGitLogTool);
  registry.register(osGitDiffTool);
  registry.register(osGitShowTool);
  registry.register(osGitBlameTool);
  registry.register(osGitBranchTool);
  // Local git writes ride the fs approval ladder against the repo root.
  const gitWriteOptions = {
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
    trustConfigPaths: options.trustConfigPaths,
  };
  registry.register(buildOsGitInitTool(gitWriteOptions));
  registry.register(buildOsGitAddTool(gitWriteOptions));
  registry.register(buildOsGitCheckoutTool(gitWriteOptions));
  registry.register(buildOsGitCommitTool(gitWriteOptions));
  // Network git shares the shell guard's remote-sync predicate so the
  // dedicated tools and the escape hatch can never disagree. With no
  // policy injected (embedders, tests) the repository stays closed —
  // the conservative reading of "nobody said it may leave".
  const gitRemote = {
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
    isRemoteSyncEnabled:
      options.shellPolicy?.isGitRemoteSyncEnabled ?? (() => false),
  };
  registry.register(buildOsGitRemoteTool(gitRemote));
  registry.register(buildOsGitFetchTool(gitRemote));
  registry.register(buildOsGitPullTool(gitRemote));
  registry.register(buildOsGitPushTool(gitRemote));
  registry.register(buildOsGitCloneTool(gitRemote));
  registry.register(osProcListTool);
  registry.register(
    buildOsProcKillTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
    }),
  );
}
