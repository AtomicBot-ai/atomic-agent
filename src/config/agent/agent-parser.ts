import { parseCompactionConfig } from "./compaction-config.js";
import type { ApprovalLevel } from "../../approval/approval-level.js";
import type { ReadScope, UserAgentConfig } from "./agent-types.js";
import { ConfigValidationError } from "../config-validation-error.js";
import {
  coerceIntLike,
  parseBool,
  parsePositiveInt,
  parseBoundedPositiveInt,
  parseNonNegativeInt,
  parseHalfOpenUnitInterval,
} from "../config-primitives.js";
import { parseProviderWait, parseAgentTask } from "../agent-execution-config.js";

export const READ_SCOPES: readonly ReadScope[] = [
  "working-dir",
  "unrestricted",
];

export function parseReadScope(raw: unknown, field: string): ReadScope {
  if (
    typeof raw === "string" &&
    (READ_SCOPES as readonly string[]).includes(raw)
  ) {
    return raw as ReadScope;
  }
  throw new ConfigValidationError(
    field,
    `expected ${READ_SCOPES.join("|")}, got ${JSON.stringify(raw)}`,
  );
}

export function parseApprovalLevel(raw: unknown, field: string): ApprovalLevel {
  // `coerceIntLike`, like every other numeric parser in this file, and
  // not a bare `typeof raw === "number"`. `config set <key> <value>`
  // hands the schema the raw argv string on purpose — guessing the type
  // at the CLI would be a second source of truth — so a number-only
  // check made `agent.approvalLevel` the single key the dotted-key
  // editor could never write. It is also the one safety-critical
  // setting in the file, and it failed with a message that asked for
  // exactly what it had just been given: `config set
  // agent.approvalLevel 3` answered `expected an integer between 1 and
  // 5, got "3"`.
  const value = coerceIntLike(raw);
  if (Number.isInteger(value) && value >= 1 && value <= 5) {
    return value as ApprovalLevel;
  }
  throw new ConfigValidationError(
    field,
    `expected an integer between 1 and 5, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Bounds of `agent.conversationMaxPairs`, shared with the TUI's
 * `/context` selector so it can neither offer nor clamp to less.
 */
export const CONVERSATION_MAX_PAIRS_MIN = 1;

export const CONVERSATION_MAX_PAIRS_MAX = 1000;

/**
 * v37 migration: the binary `agent.approvalRequired` became the
 * five-step `agent.approvalLevel`. The new key wins whenever present;
 * otherwise the legacy boolean maps onto the levels that reproduce its
 * behaviour exactly — `false` ("approve everything") becomes level 5,
 * `true` becomes level 1 — and an absent pair falls back to the level-1
 * default. Presence-driven rather than version-gated so hand-written
 * harness configs that still carry only the boolean keep working. The
 * legacy key is validated when present (garbage still fails loudly) and
 * is never written back: `UserConfigFile` no longer has the field.
 */
function resolveApprovalLevel(
  rawLevel: unknown,
  rawLegacyRequired: unknown,
  readDefaults: () => UserAgentConfig,
): ApprovalLevel {
  if (rawLevel !== undefined && rawLevel !== null) {
    return parseApprovalLevel(rawLevel, "agent.approvalLevel");
  }
  if (rawLegacyRequired !== undefined && rawLegacyRequired !== null) {
    return parseBool(rawLegacyRequired, "agent.approvalRequired") ? 1 : 5;
  }
  return readDefaults().approvalLevel;
}

export function parseAgentConfig(
  agent: Record<string, unknown>,
  readDefaults: () => UserAgentConfig,
): UserAgentConfig {
  return {
    tokenBudget: parsePositiveInt(
      agent.tokenBudget ?? readDefaults().tokenBudget,
      "agent.tokenBudget",
    ),
    maxSteps: parsePositiveInt(
      agent.maxSteps ?? readDefaults().maxSteps,
      "agent.maxSteps",
    ),
    providerWait: parseProviderWait(
      agent.providerWait,
      readDefaults().providerWait,
    ),
    nameSessions: parseBool(
      agent.nameSessions ?? readDefaults().nameSessions,
      "agent.nameSessions",
    ),
    task: parseAgentTask(
      agent.task,
      readDefaults().task,
    ),
    toolTimeoutMs: parsePositiveInt(
      agent.toolTimeoutMs ?? readDefaults().toolTimeoutMs,
      "agent.toolTimeoutMs",
    ),
    // The upgrade step for a pre-v67 file: no field, the default.
    readScope: parseReadScope(
      agent.readScope ?? readDefaults().readScope,
      "agent.readScope",
    ),
    approvalLevel: resolveApprovalLevel(
      agent.approvalLevel,
      agent.approvalRequired,
      readDefaults,
    ),
    // Non-negative rather than positive: `0` is the "auto" sentinel
    // (`CONVERSATION_CAP_AUTO`), not a request for a zero-token
    // transcript.
    compaction: parseCompactionConfig(agent.compaction, readDefaults().compaction),
    conversationMaxTokens: parseNonNegativeInt(
      agent.conversationMaxTokens ??
        readDefaults().conversationMaxTokens,
      "agent.conversationMaxTokens",
    ),
    // Bounded, unlike the token cap: there is no "auto" here. `1`
    // means the agent sees only the task in front of it; the upper
    // bound keeps a fat-fingered `1000` from turning into a prompt
    // nobody meant to pay for.
    conversationMaxPairs: parseBoundedPositiveInt(
      agent.conversationMaxPairs ??
        readDefaults().conversationMaxPairs,
      "agent.conversationMaxPairs",
      CONVERSATION_MAX_PAIRS_MIN,
      CONVERSATION_MAX_PAIRS_MAX,
    ),
    // `(0, 1]`: `1` is a real setting (cut just enough, every step),
    // `0` would drop the whole transcript at the first overflow.
    conversationLowWater: parseHalfOpenUnitInterval(
      agent.conversationLowWater ??
        readDefaults().conversationLowWater,
      "agent.conversationLowWater",
    ),
    // Non-negative like `conversationMaxTokens`, and for the same
    // reason: `0` is the "derive it from the share" sentinel
    // (`SESSION_SECTIONS_CAP_AUTO`), not a request for no session
    // sections at all.
    sessionSectionsMaxTokens: parseNonNegativeInt(
      agent.sessionSectionsMaxTokens ??
        readDefaults().sessionSectionsMaxTokens,
      "agent.sessionSectionsMaxTokens",
    ),
    worldSnapshotMaxTokens: parsePositiveInt(
      agent.worldSnapshotMaxTokens ??
        readDefaults().worldSnapshotMaxTokens,
      "agent.worldSnapshotMaxTokens",
    ),
  };
}
