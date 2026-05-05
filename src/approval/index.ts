export { ApprovalGate, ApprovalGateError } from "./approval-gate.js";
export type {
  ApprovalDecision,
  ApprovalEmitter,
  ApprovalRequest,
} from "./approval-gate.js";
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
