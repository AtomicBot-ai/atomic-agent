/** Desktop error reporting (SPEC "Desktop Sentry"): crash reporter, envelope client, scrubber, handlers. */

export { baseTags, minidumpUrl, reportError, type ErrorInput } from "./client.js";
export {
  reportAgentExit,
  reportRendererError,
  startCrashReporter,
  wireProcessErrorReporting,
  wireWindowErrorReporting,
} from "./handlers.js";
export { MAX_FRAMES, safeBasename, safeMessage, safeTag, safeType, sanitizeStack, STATIC_MESSAGE_ERRORS } from "./scrub.js";
