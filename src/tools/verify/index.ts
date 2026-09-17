import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolRegistry } from "../tool-registry.js";
import { buildVerifyRunTool } from "./verify-run.js";
import { verifySyntaxTool } from "./verify-syntax.js";

export {
  VERIFY_SYNTAX_TOOL,
  VERIFY_SYNTAX_MAX_FILES,
  VERIFY_SUMMARY_MAX_CHARS,
  parseVerifySyntaxArgs,
  verifySyntax,
  verifySyntaxTool,
} from "./verify-syntax.js";
export type { VerifySyntaxReport } from "./verify-syntax.js";
export type { SyntaxFileResult } from "./syntax-check-types.js";
export {
  checkJavaScriptFile,
  checkJavaScriptSource,
  checkPythonFile,
  checkShellFile,
  runChecker,
} from "./check-script-syntax.js";
export type { CheckerRun } from "./check-script-syntax.js";
export { checkCssSource, CSS_CHECKER } from "./check-css-syntax.js";
export {
  checkHtmlSource,
  extractInlineScripts,
  trailingContentWarning,
  HTML_CHECKER,
} from "./check-html-syntax.js";
export {
  checkTypeScriptFiles,
  findTsconfig,
  findTscBinary,
  TS_CHECKER,
} from "./check-typescript-syntax.js";

export {
  VERIFY_RUN_TOOL,
  buildVerifyRunTool,
  describeVerifyRun,
} from "./verify-run.js";
export type { VerifyRunToolOptions } from "./verify-run.js";
export { runVerify, runChecks } from "./run-verify.js";
export type { VerifyRunResult, VerifyRunContext } from "./run-verify.js";
export {
  parseVerifyRunArgs,
  VERIFY_RUN_DEFAULT_TIMEOUT_MS,
  VERIFY_RUN_MAX_TIMEOUT_MS,
  VERIFY_READY_DEFAULT_TIMEOUT_MS,
  VERIFY_PAGE_DEFAULT_SECONDS,
  VERIFY_PAGE_MAX_SECONDS,
} from "./verify-run-args.js";
export type {
  VerifyRunArgs,
  VerifyRunKind,
  VerifyRequestSpec,
  VerifyScriptStep,
  VerifyProbe,
} from "./verify-run-args.js";
export { evaluateCheck, evaluateChecks, tokenizeCheck } from "./verify-checks.js";
export type { CheckOutcome, CheckSubject } from "./verify-checks.js";
export {
  createVerifyWorkspace,
  copyTreeWithExclusions,
  measureTree,
  VERIFY_COPY_EXCLUDED,
  VERIFY_COPY_MAX_BYTES,
} from "./verify-workspace-copy.js";
export type { VerifyWorkspace, CreateWorkspaceOptions } from "./verify-workspace-copy.js";
export {
  networkBlockEnv,
  resolveInvocation,
  spawnVerifyProcess,
  NETWORK_BLOCK_PROXY,
  OUTPUT_TAIL_CHARS,
  TailBuffer,
} from "./spawn-verify-process.js";
export type { VerifyProcess, VerifyProcessExit } from "./spawn-verify-process.js";
export { runCommandKind } from "./run-command-kind.js";
export type { CommandRunOutcome } from "./run-command-kind.js";
export { runServiceKind } from "./run-service-kind.js";
export type { ServiceRunOutcome, RequestOutcome, FetchLike } from "./run-service-kind.js";
export { runPageKind, defaultBrowserLauncher } from "./run-page-kind.js";
export type { PageRunOutcome, BrowserLauncher } from "./run-page-kind.js";
export { downsample, sampleProbes, MISSING_SELECTOR_INIT_SCRIPT } from "./page-probe-script.js";
export type { ProbeSample } from "./page-probe-script.js";
export { renderVerifyRunSummary, VERIFY_RUN_SUMMARY_MAX_CHARS } from "./verify-run-summary.js";

export interface RegisterVerifyToolsOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "browser">;
}

/**
 * Register the `verify.*` family. Both tools are `readonly` so the fusion
 * orchestrator gate and plan mode let them run — verification reads and
 * executes copies, it never changes the workspace.
 */
export function registerVerifyTools(
  registry: ToolRegistry,
  options: RegisterVerifyToolsOptions,
): void {
  registry.register(verifySyntaxTool);
  registry.register(
    buildVerifyRunTool({
      approvals: options.approvals,
      approvalRequired: options.approvalRequired,
      config: options.config,
    }),
  );
}
