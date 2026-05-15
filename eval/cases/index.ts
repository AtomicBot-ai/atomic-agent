import type { EvalCase } from "../harness/case-schema.js";

import { fsReadReadme } from "./fs-read-readme.case.js";
import { fsGrepTodo } from "./fs-grep-todo.case.js";
import { fsCreateChangelog } from "./fs-create-changelog.case.js";
import { fsGlobTypescript } from "./fs-glob-typescript.case.js";
import { shellPrintMarker } from "./shell-print-marker.case.js";
import { gitStatusClean } from "./git-status-clean.case.js";
import { skillListInstalled } from "./skill-list-installed.case.js";
import { skillViewPing } from "./skill-view-ping.case.js";
import { httpGetStatus } from "./http-get-status.case.js";
import { httpPostEcho } from "./http-post-echo.case.js";
import { summarizeReadme } from "./summarize-readme.case.js";
import { explainTreeShape } from "./explain-tree-shape.case.js";
import { codingFixCartTotal } from "./coding-fix-cart-total.case.js";
import { debugFixSlugify } from "./debug-fix-slugify.case.js";
import { codingWireSharedTaxRate } from "./coding-wire-shared-tax-rate.case.js";

// Bucket A — AgentBench-OS-style fs + shell + grep.
import { osFsCountPyLines } from "./os-fs-count-py-lines.case.js";
import { osFsFindDuplicateFilenames } from "./os-fs-find-duplicate-filenames.case.js";
import { osFsExtractEmails } from "./os-fs-extract-emails.case.js";
import { osFsLargestFileName } from "./os-fs-largest-file-name.case.js";
import { osFsTailLastLine } from "./os-fs-tail-last-line.case.js";
import { osFsRenameMdToMdx } from "./os-fs-rename-md-to-mdx.case.js";
import { osFsHashSha256 } from "./os-fs-hash-sha256.case.js";
import { osGrepFindFunctionDef } from "./os-grep-find-function-def.case.js";

// Bucket B — single-file bug fixes (SWE-bench-Lite pattern).
import { codingFixPaginationOffset } from "./coding-fix-pagination-offset.case.js";
import { codingFixLooseEquality } from "./coding-fix-loose-equality.case.js";
import { codingFixMissingNullCheck } from "./coding-fix-missing-null-check.case.js";
import { codingFixSwappedDateArgs } from "./coding-fix-swapped-date-args.case.js";
import { codingFixWrongDefaultOption } from "./coding-fix-wrong-default-option.case.js";
import { codingFixGreedyRegex } from "./coding-fix-greedy-regex.case.js";

// Bucket C — multi-file refactors.
import { codingExtractSharedConstant } from "./coding-extract-shared-constant.case.js";
import { codingRenameFunctionAcrossFiles } from "./coding-rename-function-across-files.case.js";
import { codingSplitGodModule } from "./coding-split-god-module.case.js";

// Bucket D — judge-based knowledge / understanding.
import { judgeExplainCacheDecision } from "./judge-explain-cache-decision.case.js";
import { judgeSummarizeConfigSchema } from "./judge-summarize-config-schema.case.js";
import { judgeFindModuleDependency } from "./judge-find-module-dependency.case.js";

// Bucket E — axe-focused diagnostic cases. Each case isolates a single
// capability axis (see CapabilityAxis in case-schema.ts) so a fail
// directly identifies the component to fix.
import { axisToolSelectionReadNotShell } from "./axis-tool-selection-read-not-shell.case.js";
import { axisToolSelectionEditNotWrite } from "./axis-tool-selection-edit-not-write.case.js";
import { axisArgsShapingGrepSpecialChars } from "./axis-args-shaping-grep-special-chars.case.js";
import { axisArgsShapingWriteMode } from "./axis-args-shaping-write-mode.case.js";
import { axisMinStepsSingleRead } from "./axis-min-steps-single-read.case.js";
import { axisMinStepsTrivialReply } from "./axis-min-steps-trivial-reply.case.js";
import { axisBatchingFourIndependentReads } from "./axis-batching-four-independent-reads.case.js";
import { axisRecoveryBadPathThenFix } from "./axis-recovery-bad-path-then-fix.case.js";
import { axisInstructionNoEditJustReport } from "./axis-instruction-no-edit-just-report.case.js";
import { axisInstructionNoShell } from "./axis-instruction-no-shell.case.js";
import { axisSelfTermAfterFind } from "./axis-self-term-after-find.case.js";
import { axisGrammarAdherenceJsonInPrompt } from "./axis-grammar-adherence-json-in-prompt.case.js";
import { axisContextRetentionConfigValue } from "./axis-context-retention-config-value.case.js";
import { axisRefusalMissingFile } from "./axis-refusal-missing-file.case.js";
import { axisRefusalEmptyResult } from "./axis-refusal-empty-result.case.js";

// Bucket F — GAIA-style document QA. Self-contained PDF/XLSX
// fixtures (NOT real GAIA data) used as an internal proxy for
// assistant-style file-fact retrieval. See category="gaia-style"
// in case-schema.ts for the scope/limitations.
import { gaiaPdfTableCell } from "./gaia-pdf-table-cell.case.js";
import { gaiaPdfMultiPageFact } from "./gaia-pdf-multi-page-fact.case.js";
import { gaiaPdfCrossDocArithmetic } from "./gaia-pdf-cross-doc-arithmetic.case.js";
import { gaiaXlsxConditionalSum } from "./gaia-xlsx-conditional-sum.case.js";
import { gaiaXlsxCountDistinct } from "./gaia-xlsx-count-distinct.case.js";
import { gaiaPdfDisambiguateName } from "./gaia-pdf-disambiguate-name.case.js";
import { gaiaPdfDeepNeedle } from "./gaia-pdf-deep-needle.case.js";
import { gaiaXlsxWhichIsMissing } from "./gaia-xlsx-which-is-missing.case.js";
import { gaiaCrossFormatPolicyJoin } from "./gaia-cross-format-policy-join.case.js";
import { gaiaMultihopVendorBudget } from "./gaia-multihop-vendor-budget.case.js";
import { gaiaConditionalRevenue } from "./gaia-conditional-revenue.case.js";
import { gaiaXlsxTop3Customers } from "./gaia-xlsx-top-3-customers.case.js";
import { gaiaXlsxMultisheetJoin } from "./gaia-xlsx-multisheet-join.case.js";
import { gaiaHardVaguePrompt } from "./gaia-hard-vague-prompt.case.js";
import { gaiaHardDecoyFiles } from "./gaia-hard-decoy-files.case.js";
import { gaiaHardMultihopVague } from "./gaia-hard-multihop-vague.case.js";
import { gaiaHardStaleSource } from "./gaia-hard-stale-source.case.js";

/**
 * Eval corpus. Order is stable so report rows can be diff'd across runs
 * without sorting. The corpus is split into stable buckets:
 *
 *  - Original 15: smoke + first-iteration OS / skill / HTTP / coding /
 *    debug coverage.
 *  - Bucket A (+8): AgentBench-OS-style fs + shell + grep.
 *  - Bucket B (+6): SWE-bench-Lite-shaped single-file bug fixes.
 *  - Bucket C (+3): multi-file refactor (read-fan-out, multi-write).
 *  - Bucket D (+3): judge-based knowledge / code understanding.
 *  - Bucket E (+15): axe-focused diagnostics. Each case isolates ONE
 *    capability axis (tool_selection, args_shaping, min_steps,
 *    parallel_batching, tool_error_recovery, instruction_adherence,
 *    self_termination, grammar_adherence, context_retention,
 *    refusal_of_impossible). Failures from Bucket E directly point
 *    at the component to fix — they are the "where to improve"
 *    signal, while the other buckets remain the "how well overall"
 *    signal.
 *  - Bucket F (+17): GAIA-style document QA over self-authored
 *    PDF / XLSX fixtures. Mix of single-doc lookup, multi-doc
 *    join, long-context needle, set-difference, conditional
 *    answer, top-N ranking, multi-sheet JOIN, plus a "hard"
 *    sub-set that strips section pointers, adds decoy files,
 *    requires semantic-keyword bridging, and forces choosing
 *    a current source over a stale legacy. Internal proxy for
 *    assistant-style file fact retrieval — NOT comparable to
 *    published GAIA scores.
 *
 * Total = 67. Run `eval:summary` (after a full prog) to get a
 * per-axis pass-rate breakdown.
 */
export const EVAL_CASES: ReadonlyArray<EvalCase> = [
  // Original 15.
  fsReadReadme,
  fsGrepTodo,
  fsCreateChangelog,
  fsGlobTypescript,
  shellPrintMarker,
  gitStatusClean,
  skillListInstalled,
  skillViewPing,
  httpGetStatus,
  httpPostEcho,
  summarizeReadme,
  explainTreeShape,
  codingFixCartTotal,
  debugFixSlugify,
  codingWireSharedTaxRate,

  // Bucket A.
  osFsCountPyLines,
  osFsFindDuplicateFilenames,
  osFsExtractEmails,
  osFsLargestFileName,
  osFsTailLastLine,
  osFsRenameMdToMdx,
  osFsHashSha256,
  osGrepFindFunctionDef,

  // Bucket B.
  codingFixPaginationOffset,
  codingFixLooseEquality,
  codingFixMissingNullCheck,
  codingFixSwappedDateArgs,
  codingFixWrongDefaultOption,
  codingFixGreedyRegex,

  // Bucket C.
  codingExtractSharedConstant,
  codingRenameFunctionAcrossFiles,
  codingSplitGodModule,

  // Bucket D.
  judgeExplainCacheDecision,
  judgeSummarizeConfigSchema,
  judgeFindModuleDependency,

  // Bucket E — diagnostic axe-focused cases.
  axisToolSelectionReadNotShell,
  axisToolSelectionEditNotWrite,
  axisArgsShapingGrepSpecialChars,
  axisArgsShapingWriteMode,
  axisMinStepsSingleRead,
  axisMinStepsTrivialReply,
  axisBatchingFourIndependentReads,
  axisRecoveryBadPathThenFix,
  axisInstructionNoEditJustReport,
  axisInstructionNoShell,
  axisSelfTermAfterFind,
  axisGrammarAdherenceJsonInPrompt,
  axisContextRetentionConfigValue,
  axisRefusalMissingFile,
  axisRefusalEmptyResult,

  // Bucket F — GAIA-style.
  gaiaPdfTableCell,
  gaiaPdfMultiPageFact,
  gaiaPdfCrossDocArithmetic,
  gaiaXlsxConditionalSum,
  gaiaXlsxCountDistinct,
  gaiaPdfDisambiguateName,
  gaiaPdfDeepNeedle,
  gaiaXlsxWhichIsMissing,
  gaiaCrossFormatPolicyJoin,
  gaiaMultihopVendorBudget,
  gaiaConditionalRevenue,
  gaiaXlsxTop3Customers,
  gaiaXlsxMultisheetJoin,
  // Bucket F (hard sub-set) — strip the hints.
  gaiaHardVaguePrompt,
  gaiaHardDecoyFiles,
  gaiaHardMultihopVague,
  gaiaHardStaleSource,
];
