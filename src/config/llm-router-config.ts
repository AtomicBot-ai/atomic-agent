import { emitConfigNoticeOnce } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

/**
 * `llm.router` (ATO-483, step 1): opt-in rules that send a turn to a
 * configured provider by what the request looks like. Off unless
 * `enabled` is true and at least one rule is set. The matcher lives in
 * `src/llm/router/`; this file only reads the block.
 *
 * Every condition of a rule must hold; the first rule that matches wins,
 * so order is precedence. A rule with no condition matches every turn
 * (a catch-all, useful last).
 */
export type UserLlmRouterRule = {
  /** Shown in the log line when the rule picks a provider. */
  name?: string;
  /** A configured provider id the matching turn runs on. */
  provider: string;
  when?: UserLlmRouterConditions;
};

export type UserLlmRouterConditions = {
  /** The message is at least this many estimated tokens. */
  minTokens?: number;
  /** The message is at most this many estimated tokens. */
  maxTokens?: number;
  /** The message names an image file (png, jpg, jpeg, webp, gif) or not. */
  hasImage?: boolean;
  /** The message contains any of these words or phrases (case-insensitive). */
  contains?: string[];
  /** The message matches this regular expression (case-insensitive). */
  matches?: string;
  /** The turn offers tools (every ordinary agent turn does) or not. */
  needsTools?: boolean;
  /** The session's working folder is this folder or inside it (`~` allowed). */
  workingDir?: string;
};

export type UserLlmRouterConfig = {
  enabled: boolean;
  rules: UserLlmRouterRule[];
};

const CONDITION_KEYS = new Set([
  "minTokens",
  "maxTokens",
  "hasImage",
  "contains",
  "matches",
  "needsTools",
  "workingDir",
]);

export function parseLlmRouterConfig(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
): UserLlmRouterConfig {
  const obj = asObject(raw, field);
  const enabled = obj.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new ConfigValidationError(`${field}.enabled`, "expected boolean");
  }
  const rawRules = obj.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new ConfigValidationError(`${field}.rules`, "expected array");
  }
  const rules = rawRules.map((rule, i) =>
    parseRule(rule, providerIds, `${field}.rules[${i}]`),
  );
  return { enabled, rules };
}

function parseRule(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
): UserLlmRouterRule {
  const obj = asObject(raw, field);
  const provider = obj.provider;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new ConfigValidationError(`${field}.provider`, "expected a provider id");
  }
  // A rule naming a provider that is not configured (removed later, or
  // set aside by an older build) is kept and skipped at turn time
  // (`routeTurn`), rather than refusing the whole config: deleting a
  // provider must not stop the agent from loading. Noted once.
  if (!providerIds.has(provider)) {
    emitConfigNoticeOnce(
      `${field}.provider names "${provider}", which is not configured; the rule is skipped.`,
    );
  }
  const name = obj.name;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    throw new ConfigValidationError(`${field}.name`, "expected non-empty string");
  }
  const when =
    obj.when === undefined || obj.when === null
      ? undefined
      : parseConditions(obj.when, `${field}.when`);
  return {
    provider,
    ...(name !== undefined ? { name } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

function parseConditions(raw: unknown, field: string): UserLlmRouterConditions {
  const obj = asObject(raw, field);
  for (const key of Object.keys(obj)) {
    if (!CONDITION_KEYS.has(key)) {
      throw new ConfigValidationError(
        `${field}.${key}`,
        `unknown condition; expected one of ${[...CONDITION_KEYS].join(", ")}`,
      );
    }
  }
  const out: UserLlmRouterConditions = {};
  const minTokens = optionalCount(obj.minTokens, `${field}.minTokens`);
  if (minTokens !== undefined) out.minTokens = minTokens;
  const maxTokens = optionalCount(obj.maxTokens, `${field}.maxTokens`);
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const hasImage = optionalBoolean(obj.hasImage, `${field}.hasImage`);
  if (hasImage !== undefined) out.hasImage = hasImage;
  const needsTools = optionalBoolean(obj.needsTools, `${field}.needsTools`);
  if (needsTools !== undefined) out.needsTools = needsTools;
  if (obj.contains !== undefined) {
    if (
      !Array.isArray(obj.contains) ||
      obj.contains.length === 0 ||
      obj.contains.some((s) => typeof s !== "string" || s.length === 0)
    ) {
      throw new ConfigValidationError(
        `${field}.contains`,
        "expected a non-empty array of non-empty strings",
      );
    }
    out.contains = [...(obj.contains as string[])];
  }
  if (obj.matches !== undefined) {
    if (typeof obj.matches !== "string" || obj.matches.length === 0) {
      throw new ConfigValidationError(`${field}.matches`, "expected non-empty string");
    }
    try {
      new RegExp(obj.matches, "i");
    } catch {
      throw new ConfigValidationError(`${field}.matches`, "expected a valid regular expression");
    }
    out.matches = obj.matches;
  }
  if (obj.workingDir !== undefined) {
    if (typeof obj.workingDir !== "string" || obj.workingDir.trim().length === 0) {
      throw new ConfigValidationError(`${field}.workingDir`, "expected non-empty string");
    }
    out.workingDir = obj.workingDir;
  }
  if (
    out.minTokens !== undefined &&
    out.maxTokens !== undefined &&
    out.minTokens > out.maxTokens
  ) {
    throw new ConfigValidationError(`${field}.minTokens`, "must not exceed maxTokens");
  }
  return out;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  return raw as Record<string, unknown>;
}

function optionalCount(raw: unknown, field: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new ConfigValidationError(field, "expected non-negative integer");
  }
  return raw;
}

function optionalBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new ConfigValidationError(field, "expected boolean");
  }
  return raw;
}
