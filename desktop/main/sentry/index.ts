/** Desktop error reporting (desktop/ANALYTICS.md "Error reports"): envelope client, scrubber, handlers. No minidumps. */

export { baseTags, reportError, type ErrorInput } from "./client.js";
export {
  reportAgentExit,
  reportRendererError,
  wireProcessErrorReporting,
  wireWindowErrorReporting,
} from "./handlers.js";
export { KNOWN_TYPES, MAX_FRAMES, safeBasename, safeMessage, safeTag, safeType, sanitizeStack, STATIC_MESSAGE_ERRORS } from "./scrub.js";
