export {
  SENTRY_DSN,
  SENTRY_PLACEHOLDER_DSN,
  parseSentryDsn,
} from "./sentry-config.js";
export type { ParsedSentryDsn } from "./sentry-config.js";
export {
  scrubError,
  sanitizeStack,
  extractSafeCode,
  extractSafeReason,
  extractSafeTool,
  extractSafeTransportHost,
  readKnownCategory,
  STATIC_MESSAGE_ERRORS,
} from "./error-scrubber.js";
export type { ScrubbedErrorEvent, SentryStackFrame } from "./error-scrubber.js";
export { sanitizeLlmFailureTags } from "./llm-failure-tags.js";
export {
  knownSecretsFromEnv,
  maskSecrets,
  redactedMarker,
  MIN_KNOWN_SECRET_LENGTH,
} from "./secret-detector.js";
export type { KnownSecret } from "./secret-detector.js";
export type { LlmFailureContext } from "./llm-failure-tags.js";
export {
  buildEnvelope,
  buildFingerprint,
  buildSentryAuthHeader,
} from "./sentry-envelope.js";
export {
  SentryRateLimiter,
  SENTRY_RATE_LIMIT_FILE,
  SENTRY_RATE_LIMIT_MAX_EVENTS,
  SENTRY_RATE_LIMIT_MAX_KEYS,
  SENTRY_RATE_LIMIT_WINDOW_MS,
  hashKey,
  sentryGroupingKey,
} from "./sentry-rate-limit.js";
export type { SentryRateLimiterOptions } from "./sentry-rate-limit.js";
export type {
  EnvelopeMeta,
  BuiltEnvelope,
  ErrorReportDimensions,
} from "./sentry-envelope.js";
export { SentryClient, createSentryClient } from "./sentry-client.js";
export type {
  SentryClientOptions,
  ErrorReportLogger,
  FetchLike,
} from "./sentry-client.js";
export {
  captureError,
  installGlobalErrorHandlers,
  installStdioErrorGuards,
  resetGlobalErrorHandlersForTests,
} from "./error-reporter.js";
export type {
  BrokenPipePolicy,
  GlobalErrorHandlerOptions,
} from "./error-reporter.js";
export { isBrokenPipeError } from "./broken-pipe.js";
