import type { SkillCatalogEntry } from "../prompt/stable-prefix.js";
import type { SkillRecord } from "./skill-loader.js";

/**
 * One catalog line as rendered in `buildStablePrefix` `### skills` (must
 * stay byte-identical to `formatSkillEntry` there for budget accounting).
 */
export function formatSkillCatalogLine(entry: SkillCatalogEntry): string {
  const tag = entry.source === "project" ? "[project]" : "[global]";
  return `- ${tag} ${entry.name}: ${entry.description}`;
}

/**
 * Chars of rendered catalog text budgeted per `skills.catalogTokenBudget`
 * token. Deliberately NOT `estimateTokens`'s ~3.6 chars/token: the knob
 * shipped with a default of 512 while the catalog was hard-capped at
 * 4096 chars, so 8 chars/token is the one factor that makes the default
 * config reproduce the historical cap byte-for-byte. Change it and every
 * user who never touched the key gets a different `### skills` section
 * (and a KV-cache invalidation) on upgrade.
 */
export const SKILL_CATALOG_CHARS_PER_TOKEN = 8;

/**
 * Historical hard cap, kept as the fallback when a caller passes neither
 * `maxChars` nor `tokenBudget`. Equals the default `tokenBudget` of 512
 * times {@link SKILL_CATALOG_CHARS_PER_TOKEN}.
 */
export const DEFAULT_CATALOG_MAX_CHARS = 4096;

export interface BuildCatalogOptions {
  /** Soft cap for total `### skills` chars (join with `\n`). Defaults to 4096. */
  maxChars?: number;
  /**
   * `skills.catalogTokenBudget` from config (env
   * `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET`). Converted to a char cap at
   * {@link SKILL_CATALOG_CHARS_PER_TOKEN} chars/token; ignored when
   * `maxChars` is given explicitly. The shipped default of 512 maps to
   * the historical 4096-char cap.
   */
  tokenBudget?: number;
}

/**
 * Build the skill catalog that lives in the stable prefix.
 * Entries exceeding the soft cap are dropped so the prompt stays bounded.
 * Char budget matches rendered lines (`[global]` / `[project]` tags +
 * newlines between entries).
 */
export function buildSkillCatalog(
  records: ReadonlyArray<SkillRecord>,
  options: BuildCatalogOptions = {},
): SkillCatalogEntry[] {
  const maxChars =
    options.maxChars ??
    (options.tokenBudget !== undefined
      ? options.tokenBudget * SKILL_CATALOG_CHARS_PER_TOKEN
      : DEFAULT_CATALOG_MAX_CHARS);
  const entries: SkillCatalogEntry[] = [];
  let used = 0;
  for (const record of records) {
    const entry: SkillCatalogEntry = {
      name: record.manifest.name,
      description: record.manifest.description,
      source: record.source,
    };
    const line = formatSkillCatalogLine(entry);
    const sep = entries.length > 0 ? 1 : 0;
    if (used + sep + line.length > maxChars && entries.length > 0) break;
    used += sep + line.length;
    entries.push(entry);
  }
  return entries;
}
