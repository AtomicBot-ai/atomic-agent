import { ConfigValidationError } from "./config-validation-error.js";

import { parsePositiveInt, parseBoundedPositiveInt, parseBool } from "./config-primitives.js";

import { parseUrl } from "./config-values.js";

export interface RuntimeSkillsConfig {
  /**
   * Soft budget for the `### skills` catalog in the stable prefix,
   * in tokens. `buildSkillCatalog` converts it to a char cap at
   * `SKILL_CATALOG_CHARS_PER_TOKEN` (8) chars/token and drops
   * catalog entries past the cap so the prompt stays bounded. Env
   * `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET`, default `512` — which
   * maps to the historical hardcoded 4096-char cap, so an unset
   * key keeps pre-existing behavior byte-for-byte. Env values are
   * clamped to `[1, 100_000]` tokens, so a zero or negative value
   * cannot drive `maxChars` to 0 and silently collapse the catalog.
   */
  catalogTokenBudget: number;
  /**
   * Names of installed skills that should be hidden from the
   * registry. A disabled name is filtered out of `SkillRegistry.list()`
   * entirely — the catalog row in `### skills` disappears and
   * `skill.view` returns `SkillNotFoundError`. Mirrors
   * `UserConfigFile.skills.disabled`. Editing the list invalidates
   * KV-cache once because the stable prefix changes.
   */
  disabled: string[];
  /**
   * GitHub `owner/repo` repositories the skill hub browses for
   * installable SKILL.md skills. Mirrors `UserConfigFile.skills.taps`.
   */
  taps: string[];
  /**
   * ClawHub registry (https://clawhub.ai) — the primary skill
   * marketplace. Mirrors `UserConfigFile.skills.clawhub`.
   */
  clawhub: {
    enabled: boolean;
    apiBase: string;
    browseLimit: number;
    nonSuspiciousOnly: boolean;
  };
}

export interface UserSkillsConfig {
  catalogTokenBudget: number;
  disabled: string[];
  taps: string[];
  clawhub: {
    enabled: boolean;
    apiBase: string;
    browseLimit: number;
    nonSuspiciousOnly: boolean;
  };
}

/**
 * Default `skills.catalogTokenBudget`, shared by the file defaults and
 * `ENV_DEFAULTS.SKILLS_CATALOG_BUDGET` so the two cannot drift apart.
 * 512 tokens × 8 chars/token is the historical 4096-char catalog cap —
 * see `SKILL_CATALOG_CHARS_PER_TOKEN`.
 */
export const DEFAULT_SKILLS_CATALOG_BUDGET = 512;

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const TAP_REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Parse a list of skill names (kebab-case, matches the `name` regex
 * enforced by `skill-manifest.ts`). Empty input is accepted and
 * returned as an empty array. Duplicates are silently deduped to
 * keep the on-disk representation canonical.
 */
export function parseSkillNameArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    if (!SKILL_NAME_RE.test(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected kebab-case skill name, got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Parse the skill hub `taps` list — GitHub `owner/repo` repository
 * strings. Empty input is accepted. Duplicates are deduped so the
 * on-disk representation stays canonical.
 */
export function parseSkillTapArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    if (!TAP_REPO_RE.test(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected GitHub owner/repo, got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Parse the `skills.clawhub` block (config v31). Missing / partial input
 * is filled from {@link USER_CONFIG_DEFAULTS} so older config files
 * transparently inherit the public-registry defaults.
 */
export function parseClawHubConfigWithDefaults(
  raw: unknown,
  readDefaults: () => UserSkillsConfig["clawhub"],
): RuntimeSkillsConfig["clawhub"] {
  const defaults = readDefaults();
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "skills.clawhub",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: parseBool(
      obj.enabled ?? defaults.enabled,
      "skills.clawhub.enabled",
    ),
    apiBase: parseUrl(
      obj.apiBase ?? defaults.apiBase,
      "skills.clawhub.apiBase",
    ),
    browseLimit: parsePositiveInt(
      obj.browseLimit ?? defaults.browseLimit,
      "skills.clawhub.browseLimit",
    ),
    nonSuspiciousOnly: parseBool(
      obj.nonSuspiciousOnly ?? defaults.nonSuspiciousOnly,
      "skills.clawhub.nonSuspiciousOnly",
    ),
  };
}

export function createSkillsDefaults(): UserSkillsConfig {
  return {
    catalogTokenBudget: DEFAULT_SKILLS_CATALOG_BUDGET,
    disabled: [],
    taps: ["anthropics/skills", "openai/skills", "vercel-labs/agent-skills"],
    clawhub: {
      enabled: true,
      apiBase: "https://clawhub.ai",
      browseLimit: 100,
      nonSuspiciousOnly: true,
    },
  };
}

export function parseSkillsConfig(
  skills: Record<string, unknown>,
  readDefaults: () => UserSkillsConfig,
): UserSkillsConfig {
  return {
    catalogTokenBudget: parseBoundedPositiveInt(
      skills.catalogTokenBudget ??
        readDefaults().catalogTokenBudget,
      "skills.catalogTokenBudget",
      1,
      100_000,
    ),
    disabled: parseSkillNameArray(
      skills.disabled ?? readDefaults().disabled,
      "skills.disabled",
    ),
    taps: parseSkillTapArray(
      skills.taps ?? readDefaults().taps,
      "skills.taps",
    ),
    clawhub: parseClawHubConfigWithDefaults(skills.clawhub, () => readDefaults().clawhub),
  };
}
