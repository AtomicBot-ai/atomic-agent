export { ApprovalGate, ApprovalGateError } from "./approval-gate.js";
export type {
  ApprovalDecision,
  ApprovalEmitter,
  ApprovalRequest,
} from "./approval-gate.js";
export {
  APPROVAL_LEVEL_NAMES,
  clampApprovalLevel,
  formatApprovalLevel,
  isAutoApprovedAt,
  MAX_APPROVAL_LEVEL,
  MIN_APPROVAL_LEVEL,
  resolveBootApprovalLevel,
} from "./approval-level.js";
export type { ApprovalCategory, ApprovalLevel } from "./approval-level.js";
export { ApprovalRouter } from "./approval-router.js";
export type { ApprovalHandler } from "./approval-router.js";
export {
  requireApproval,
  ApprovalDeniedError,
} from "./dangerous-tool.js";
export type {
  DangerousToolOptions,
  ApprovalPrompt,
} from "./dangerous-tool.js";
