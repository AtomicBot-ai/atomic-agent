export type {
  LlmFailureCategory,
  ModelFailureReason,
} from "./failure-category.js";
export {
  CancelledError,
  GrammarError,
  LlmFailure,
  ModelError,
  ToolExecutionError,
  TransportError,
} from "./llm-failures.js";
export type { LlmFailureOptions } from "./llm-failures.js";
export { classifyFailure } from "./classify-failure.js";
// `looksLikeDroppedConnection` is deliberately NOT re-exported: it is the
// classifier's own key, used inside `network-error.ts` by `isNetworkError`
// and asserted directly by that module's test, with no consumer outside
// the directory. Widening the barrel with it would advertise the broad
// predicate next to the narrow one and invite a caller to reach for the
// wrong half — the exact mix-up `network-error.ts` documents at length.
export {
  isNetworkError,
  looksLikeMidStreamDrop,
  readNetworkErrorCode,
} from "./network-error.js";
export { detectModelFailure } from "./detect-model-failure.js";
export type { DetectedModelFailure } from "./detect-model-failure.js";
