import { parse as parseYaml } from "yaml";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  requiresTools: string[];
  requiresScripts: string[];
  dangerous: boolean;
}

export interface ParsedSkillFile {
  manifest: SkillManifest;
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export class SkillManifestError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "SkillManifestError";
  }
}

/**
 * Parse a full SKILL.md file. The expected shape is:
 *
 *   ---
 *   name: my-skill
 *   description: "..."
 *   version: 0.1.0
 *   requires_tools: [browser.navigate]
 *   requires_scripts: [fetch.sh]
 *   dangerous: true
 *   ---
 *   # markdown body
 *
 * The manifest is validated strictly. The body is returned verbatim so it
 * can be streamed into the prompt when the agent calls `skill.view`.
 */
export function parseSkillFile(content: string): ParsedSkillFile {
  const normalised = content.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) {
    throw new SkillManifestError(
      "SKILL.md must start with a YAML frontmatter delimited by ---",
    );
  }
  const closingIndex = normalised.indexOf("\n---", 4);
  if (closingIndex === -1) {
    throw new SkillManifestError("SKILL.md frontmatter is not closed with ---");
  }
  const yaml = normalised.slice(4, closingIndex);
  const bodyStart = closingIndex + "\n---".length;
  const body = normalised.slice(bodyStart).replace(/^\n+/, "");
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    throw new SkillManifestError(
      `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const manifest = validateManifest(raw);
  return { manifest, body };
}

function validateManifest(raw: unknown): SkillManifest {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SkillManifestError("frontmatter must be a YAML mapping");
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) issues.push("`name` is required and must be a non-empty string");
  else if (!NAME_RE.test(name))
    issues.push(
      "`name` must be kebab-case (a-z, 0-9, '-'), 2-64 chars, not start/end with '-'",
    );

  const description =
    typeof obj.description === "string" ? obj.description.trim() : "";
  if (!description)
    issues.push("`description` is required and must be a non-empty string");

  const version = typeof obj.version === "string" ? obj.version.trim() : "";
  if (!version)
    issues.push("`version` is required and must be a non-empty string");

  const requiresTools = normaliseStringList(obj.requires_tools, issues, "requires_tools");
  const requiresScripts = normaliseStringList(
    obj.requires_scripts,
    issues,
    "requires_scripts",
  );

  const dangerous =
    typeof obj.dangerous === "boolean" ? obj.dangerous : false;

  if (issues.length > 0) {
    throw new SkillManifestError(
      `invalid SKILL.md frontmatter: ${issues.join("; ")}`,
      issues,
    );
  }

  return {
    name,
    description,
    version,
    requiresTools,
    requiresScripts,
    dangerous,
  };
}

function normaliseStringList(
  value: unknown,
  issues: string[],
  field: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`\`${field}\` must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(`\`${field}\` entries must be non-empty strings`);
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}
