export type {
  LlmFailureCategory,
  ModelFailureReason,
  ModelFailureStage,
  TruncationCause,
  TruncationDetail,
} from "./failure-category.js";
export {
  CancelledError,
  GrammarError,
  LlmFailure,
  ModelError,
  ToolExecutionError,
  TransportError,
} from "./llm-failures.js";
export type { LlmFailureOptions, ModelErrorOptions } from "./llm-failures.js";
export { classifyFailure } from "./classify-failure.js";
export {
  LOCAL_ENGINE_DOWN_CODE,
  LOCAL_ENGINE_DOWN_MESSAGE,
  LOCAL_ENGINE_START_HINT,
  LocalEngineDownError,
  isLocalEngineDown,
} from "./local-engine-down.js";
export {
  LOCAL_CONTEXT_EXCEEDED_CODE,
  LOCAL_PROVIDER_NOT_FOUND_CODE,
  LOCAL_REQUEST_INVALID_CODE,
  LOCAL_SERVER_NOT_FOUND_ADVICE,
  LOCAL_SERVER_NOT_FOUND_CODE,
  LOCAL_SERVER_NOT_FOUND_MESSAGE,
  LOCAL_SERVER_RECHECK_COMMAND,
  LOCAL_SERVER_RECHECK_HINT,
  classifyLocalServerError,
  localServerErrorLines,
  type ClassifyLocalServerErrorOptions,
  type LocalServerError,
  type LocalServerErrorCode,
} from "./local-server-error.js";
export { isRequestSizeRejection } from "./request-size-rejection.js";
export {
  readProviderErrorVerdict,
  type ProviderErrorVerdict,
} from "./provider-error-verdict.js";
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
export {
  classifyTruncation,
  detectModelFailure,
  formatTruncatedMessage,
} from "./detect-model-failure.js";
export type {
  DetectModelFailureOptions,
  DetectedModelFailure,
} from "./detect-model-failure.js";
export {
  STREAM_LOOP_MIN_REPEATS,
  createStreamRepetitionWatcher,
} from "./stream-repetition-watcher.js";
export type {
  StreamRepetition,
  StreamRepetitionWatcher,
} from "./stream-repetition-watcher.js";
export {
  FABRICATED_TRANSCRIPT_MIN_LINES,
  STREAM_FABRICATION_ABORT_MIN_LINES,
  createFabricatedTranscriptWatcher,
  detectFabricatedToolTranscript,
} from "./fabricated-tool-transcript.js";
export type {
  FabricatedToolTranscript,
  FabricatedTranscriptWatcher,
} from "./fabricated-tool-transcript.js";
