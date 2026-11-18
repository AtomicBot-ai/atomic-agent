import { isValidSkillName, parseSkillFile, SKILL_SPEC_LIMITS, SkillManifestError } from "../skill-manifest.js";

/**
 * The gate every self-learned SKILL.md passes before it is written
 * (ATO-67). The same checks the loader would make (a frontmatter it can
 * parse, a kebab-case name equal to the folder), plus the ones a skill the
 * agent writes for itself needs and a hand-written one does not: a size
 * cap, no secret-looking strings, no scripts, and no name taken by another
 * skill. Hermes runs a linter like this on `skill_manager` writes; OpenClaw
 * keeps learned skills small and secret-free by rule.
 */

export type LearnedSkillMode = "create" | "patch";

export interface LintLearnedSkillInput {
  /** The full SKILL.md text about to be written. */
  content: string;
  /** The folder it goes into: `<skillsDir>/<folderName>/SKILL.md`. */
  folderName: string;
  mode: LearnedSkillMode;
  /**
   * Every skill name already in use, whatever its source (starter, hub,
   * plugin, shared, project, an archived learned skill). A new skill may
   * not reuse one of them; a patch keeps its own name.
   */
  takenNames: ReadonlySet<string>;
}

export interface LintLearnedSkillResult {
  ok: boolean;
  issues: string[];
}

/** Caps for a learned skill; generous for a procedure, small for the prompt. */
export const LEARNED_SKILL_LIMITS = {
  /** Bytes of the whole SKILL.md. */
  maxBytes: 16_384,
  /** Characters of body below which a skill says nothing worth loading. */
  minBodyChars: 40,
  /** Characters of description, the line the catalog shows. */
  maxDescriptionChars: 300,
} as const;

/**
 * Strings that look like credentials. A learned skill is written from a
 * transcript, and a transcript can hold a key the operator pasted; such a
 * skill is refused rather than "cleaned", since a redaction can miss.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "OpenAI/Anthropic-style key", re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/ },
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { label: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  {
    label: "inline secret assignment",
    re: /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\b["']?\s*[:=]\s*["']?(?![<$({])[A-Za-z0-9_\-./+=]{16,}/i,
  },
];

/** Labels of the secret patterns `text` matches; empty when none. */
export function findSecretLikeStrings(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
}

export function lintLearnedSkill(input: LintLearnedSkillInput): LintLearnedSkillResult {
  const issues: string[] = [];
  const { content, folderName, mode } = input;

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LEARNED_SKILL_LIMITS.maxBytes) {
    issues.push(`SKILL.md is ${bytes} bytes; a learned skill may be at most ${LEARNED_SKILL_LIMITS.maxBytes}`);
  }
  if (!isValidSkillName(folderName)) {
    issues.push(`folder name ${JSON.stringify(folderName)} is not a kebab-case skill name`);
  }
  if (mode === "create" && input.takenNames.has(folderName)) {
    issues.push(`a skill named ${folderName} already exists; a new skill needs a name of its own`);
  }
  if (mode === "patch" && !input.takenNames.has(folderName)) {
    issues.push(`there is no skill named ${folderName} to patch`);
  }

  try {
    const parsed = parseSkillFile(content);
    const { manifest, body } = parsed;
    if (manifest.name !== folderName) {
      issues.push(`frontmatter name ${JSON.stringify(manifest.name)} must equal the folder name ${JSON.stringify(folderName)}`);
    }
    if (/[\r\n]/.test(manifest.description)) issues.push("description must be one line");
    if (manifest.description.length > LEARNED_SKILL_LIMITS.maxDescriptionChars) {
      issues.push(`description is ${manifest.description.length} characters; at most ${LEARNED_SKILL_LIMITS.maxDescriptionChars}`);
    }
    if (body.trim().length < LEARNED_SKILL_LIMITS.minBodyChars) {
      issues.push("the body is empty or too short to teach anything");
    }
    if (body.split("\n").length > SKILL_SPEC_LIMITS.bodyLines) {
      issues.push(`the body is longer than ${SKILL_SPEC_LIMITS.bodyLines} lines`);
    }
    // Only SKILL.md is written: a declared script would not exist, and
    // `dangerous` widens what the skill asks to run.
    if (manifest.requiresScripts.length > 0) issues.push("a learned skill may not declare requires_scripts");
    if (manifest.dangerous) issues.push("a learned skill may not be marked dangerous");
    if (manifest.envKeys && manifest.envKeys.length > 0) issues.push("a learned skill may not declare env_keys");
  } catch (err) {
    if (err instanceof SkillManifestError) {
      issues.push(...(err.issues.length > 0 ? err.issues : [err.message]));
    } else {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (const label of findSecretLikeStrings(content)) {
    issues.push(`looks like it contains a secret (${label})`);
  }
  return { ok: issues.length === 0, issues };
}
