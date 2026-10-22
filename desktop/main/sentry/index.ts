/** Desktop error reporting (desktop/ANALYTICS.md "Error reports"): envelope client, scrubber, handlers. No minidumps. */

export { baseTags, reportError, setSourceTags, type ErrorInput } from "./client.js";
export {
  reportAgentExit,
  reportRendererError,
  wireProcessErrorReporting,
  wireWindowErrorReporting,
} from "./handlers.js";
export { LAST_ERROR_CATEGORIES, LAST_LINES, lastErrorCategory, uptimeBucket, type LastErrorCategory } from "./exit-reason.js";
export { KNOWN_TYPES, MAX_FRAMES, safeBasename, safeMessage, safeTag, safeType, sanitizeStack, STATIC_MESSAGE_ERRORS } from "./scrub.js";
