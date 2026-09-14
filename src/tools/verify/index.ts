import type { ToolRegistry } from "../tool-registry.js";
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

/**
 * Register the `verify.*` family. Both tools are `readonly` so the fusion
 * orchestrator gate and plan mode let them run — verification reads and
 * executes copies, it never changes the workspace.
 */
export function registerVerifyTools(registry: ToolRegistry): void {
  registry.register(verifySyntaxTool);
}
