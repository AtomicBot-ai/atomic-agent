export {
  ApprovalGate,
  ApprovalGateError,
  canGrantCategory,
  canGrantShape,
} from "./approval-gate.js";
export type {
  ApprovalDecision,
  ApprovalEmitter,
  ApprovalGrantScope,
  ApprovalRequest,
  SessionGrantsSnapshot,
} from "./approval-gate.js";
export {
  APPROVAL_CATEGORY_LABELS,
  APPROVAL_LEVEL_NAMES,
  clampApprovalLevel,
  formatApprovalCategory,
  formatApprovalLevel,
  isAutoApprovedAt,
  isGrantableCategory,
  MAX_APPROVAL_LEVEL,
  MIN_APPROVAL_LEVEL,
  resolveBootApprovalLevel,
} from "./approval-level.js";
export type { ApprovalCategory, ApprovalLevel } from "./approval-level.js";
export {
  excerptPreview,
  hiddenLinesNote,
  isPreviewCut,
  pagePreview,
  previewLines,
} from "./approval-preview.js";
export type {
  PreviewExcerpt,
  PreviewExcerptLimits,
} from "./approval-preview.js";
export {
  buildAlwaysRule,
  canGrantAlways,
  describeAlwaysRule,
  describeRule,
  matchRules,
  parseApprovalRulesFile,
} from "./approval-rules.js";
export type {
  ApprovalRule,
  ApprovalRuleDecision,
  NewApprovalRule,
} from "./approval-rules.js";
export {
  ApprovalRulesStore,
  getApprovalRulesPath,
  getProjectApprovalRulesPath,
} from "./approval-rules-store.js";
export type { ApprovalRulesSource } from "./approval-rules-store.js";
export { ReadScopeGrants } from "./read-scope-grants.js";
export { ApprovalRouter } from "./approval-router.js";
export type { ApprovalHandler } from "./approval-router.js";
export {
  requireApproval,
  ApprovalDeniedError,
  describeApprovalDenial,
} from "./dangerous-tool.js";
export type {
  DangerousToolOptions,
  ApprovalPrompt,
  ApprovalOutcome,
} from "./dangerous-tool.js";
