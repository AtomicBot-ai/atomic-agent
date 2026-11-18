import { ConfigValidationError } from "./config-validation-error.js";

import { parsePositiveInt, parseBoundedPositiveInt, parseBool } from "./config-primitives.js";

import { parseUrl } from "./config-values.js";

export interface CloudWorkspaceSkillsPolicy {
  workingDir: string;
  projectSkillsEnabled: boolean;
  disabled: string[];
}

/**
 * The operator's answer for one project folder (ATO-298 soft trust).
 * Project skills and instruction files a repository ships are untrusted
 * until the person says yes. Items are remembered by skill name and by
 * workspace-relative instruction path, so an edit of a trusted file is
 * not asked about again while a new name or a new file is. Items that
 * are in neither list are pending: they stay unloaded until answered.
 */
export interface ProjectTrustRecord {
  /** Canonical real path of the folder (see `canonicalTrustWorkspace`). */
  workingDir: string;
  trustedSkills: string[];
  declinedSkills: string[];
  /** Workspace-relative paths with forward slashes, e.g. `AGENTS.md`, `pkg/CLAUDE.md`. */
  trustedInstructions: string[];
  declinedInstructions: string[];
}

/**
 * Skill Lab settings (`skills.eval`, ATO-1101). `judgeProvider` names the
 * configured provider (an id from `llm.providers`) that grades `judge`
 * checks in `atomic-agent skill eval`. Unset: the active text provider,
 * when it is a cloud one. Never a built-in paid endpoint.
 */
export interface SkillsEvalConfig {
  judgeProvider?: string;
}

/**
 * Self-learning (`skills.selfLearning`, ATO-67): after a long turn the
 * agent reviews it in the background and may write a new skill or patch a
 * learned one. Unversioned, additive: a file without the block reads the
 * defaults below.
 */
export interface SkillsSelfLearningConfig {
  /** After a long turn, review it in the background and save what was learned as a skill (a new SKILL.md, or a fix to a skill it used). Every change is listed by `/learn` and undone with `/learn undo <id>`. */
  enabled: boolean;
  /** Model steps a turn needs before it is reviewed for something to learn. */
  minSteps: number;
}

export interface RuntimeSkillsConfig {
  cloudWorkspaces: CloudWorkspaceSkillsPolicy[];
  /** Per-folder trust answers for project skills and instruction files. Mirrors `UserConfigFile.skills.projectTrust`. */
  projectTrust: ProjectTrustRecord[];
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
  /** Skill Lab settings; absent when config.json has no `skills.eval`. */
  eval?: SkillsEvalConfig;
  /** Self-learning (ATO-67); absent in narrow fixtures, which read the defaults. */
  selfLearning?: SkillsSelfLearningConfig;
}

export interface UserSkillsConfig {
  /** Per-folder skill policies keyed by canonical `workingDir`: `projectSkillsEnabled` turns that folder's project skills off, `disabled` lists skill names hidden only there. Written when a skill is toggled for a workspace; default empty. */
  cloudWorkspaces: CloudWorkspaceSkillsPolicy[];
  projectTrust: ProjectTrustRecord[];
  catalogTokenBudget: number;
  disabled: string[];
  taps: string[];
  clawhub: {
    /** Include the ClawHub registry when browsing or searching the skill hub. With `false` no ClawHub request is made. Default `true`. */
    enabled: boolean;
    /** Base URL of the ClawHub registry API. Default `https://clawhub.ai`. */
    apiBase: string;
    /** Most ClawHub skills one browse or search returns. Default `100`. */
    browseLimit: number;
    /** Ask ClawHub to leave out skills it flags as suspicious when browsing or searching. Default `true`. */
    nonSuspiciousOnly: boolean;
  };
  /** Skill Lab settings; absent when config.json has no `skills.eval`. */
  eval?: SkillsEvalConfig;
  /** Self-learning (ATO-67). Optional so older literals still type-check; defaults and parsing always set it. */
  selfLearning?: SkillsSelfLearningConfig;
}

/**
 * Self-learning defaults (ATO-67): on, like OpenClaw's skill workshop
 * (`autonomous.mode: "auto"`), after a turn of at least 10 model steps,
 * the iteration count OpenClaw and Hermes review at.
 */
export const DEFAULT_SKILLS_SELF_LEARNING: SkillsSelfLearningConfig = { enabled: true, minSteps: 10 };

/**
 * Default `skills.catalogTokenBudget`, shared by the file defaults and
 * `ENV_DEFAULTS.SKILLS_CATALOG_BUDGET` so the two cannot drift apart.
 * 512 tokens × 8 chars/token is the historical 4096-char catalog cap —
 * see `SKILL_CATALOG_CHARS_PER_TOKEN`.
 */
export const DEFAULT_SKILLS_CATALOG_BUDGET = 512;

// `plugin:skill` is how a skill from an installed plugin is named (src/plugins).
const SKILL_NAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?:)?[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

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
    cloudWorkspaces: [],
    projectTrust: [],
    taps: ["anthropics/skills", "openai/skills", "vercel-labs/agent-skills"],
    clawhub: {
      enabled: true,
      apiBase: "https://clawhub.ai",
      browseLimit: 100,
      nonSuspiciousOnly: true,
    },
    selfLearning: { ...DEFAULT_SKILLS_SELF_LEARNING },
  };
}

export function parseSkillsConfig(
  skills: Record<string, unknown>,
  readDefaults: () => UserSkillsConfig,
): UserSkillsConfig {
  return {
    cloudWorkspaces: parseCloudWorkspaces(skills.cloudWorkspaces),
    projectTrust: parseProjectTrust(skills.projectTrust),
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
    ...parseSkillsEvalConfig(skills.eval),
    selfLearning: parseSelfLearningConfig(skills.selfLearning, readDefaults().selfLearning ?? DEFAULT_SKILLS_SELF_LEARNING),
  };
}

/** `skills.selfLearning` (unversioned, additive): missing fields take the defaults. */
export function parseSelfLearningConfig(
  raw: unknown,
  defaults: SkillsSelfLearningConfig = DEFAULT_SKILLS_SELF_LEARNING,
): SkillsSelfLearningConfig {
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("skills.selfLearning", `expected object, got ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: parseBool(obj.enabled ?? defaults.enabled, "skills.selfLearning.enabled"),
    minSteps: parseBoundedPositiveInt(obj.minSteps ?? defaults.minSteps, "skills.selfLearning.minSteps", 1, 1000),
  };
}

/** `skills.eval` (unversioned, additive): absent or `{}` leaves the key out. */
function parseSkillsEvalConfig(raw: unknown): { eval?: SkillsEvalConfig } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigValidationError("skills.eval", "expected an object");
  const judge = (raw as Record<string, unknown>).judgeProvider;
  if (judge === undefined || judge === null) return {};
  if (typeof judge !== "string" || judge.trim() === "") {
    throw new ConfigValidationError("skills.eval.judgeProvider", `expected a provider id, got ${JSON.stringify(judge)}`);
  }
  return { eval: { judgeProvider: judge.trim() } };
}

function parseCloudWorkspaces(raw: unknown): CloudWorkspaceSkillsPolicy[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigValidationError("skills.cloudWorkspaces", "expected an array");
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `skills.cloudWorkspaces[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ConfigValidationError(field, "expected an object");
    const value = entry as Record<string, unknown>;
    if (typeof value.workingDir !== "string" || !value.workingDir.trim()) throw new ConfigValidationError(`${field}.workingDir`, "expected a non-empty path");
    if (seen.has(value.workingDir)) throw new ConfigValidationError(field, "duplicate workspace");
    seen.add(value.workingDir);
    return { workingDir: value.workingDir, projectSkillsEnabled: parseBool(value.projectSkillsEnabled ?? true, `${field}.projectSkillsEnabled`),
      disabled: parseSkillNameArray(value.disabled, `${field}.disabled`) };
  });
}

function parseProjectTrust(raw: unknown): ProjectTrustRecord[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigValidationError("skills.projectTrust", "expected an array");
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `skills.projectTrust[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ConfigValidationError(field, "expected an object");
    const value = entry as Record<string, unknown>;
    if (typeof value.workingDir !== "string" || !value.workingDir.trim()) throw new ConfigValidationError(`${field}.workingDir`, "expected a non-empty path");
    if (seen.has(value.workingDir)) throw new ConfigValidationError(field, "duplicate workspace");
    seen.add(value.workingDir);
    return {
      workingDir: value.workingDir,
      trustedSkills: parseSkillNameArray(value.trustedSkills, `${field}.trustedSkills`),
      declinedSkills: parseSkillNameArray(value.declinedSkills, `${field}.declinedSkills`),
      trustedInstructions: parseInstructionPathArray(value.trustedInstructions, `${field}.trustedInstructions`),
      declinedInstructions: parseInstructionPathArray(value.declinedInstructions, `${field}.declinedInstructions`),
    };
  });
}

/**
 * Workspace-relative instruction paths. A stored path never names a file
 * outside the folder: absolute paths, backslashes, empty and `.`/`..`
 * segments are rejected, so a hand-edited entry cannot widen trust.
 */
function parseInstructionPathArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigValidationError(field, `expected string[], got ${JSON.stringify(raw)}`);
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || !isRelativeInstructionPath(entry)) {
      throw new ConfigValidationError(`${field}[${i}]`, `expected a workspace-relative path, got ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry)) return;
    seen.add(entry);
    result.push(entry);
  });
  return result;
}

export function isRelativeInstructionPath(path: string): boolean {
  if (!path || path.length > 4096 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
