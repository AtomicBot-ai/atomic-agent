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

export interface BuildCatalogOptions {
  /** Soft cap for total `### skills` chars (join with `\n`). Defaults to 4096. */
  maxChars?: number;
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
  const maxChars = options.maxChars ?? 4096;
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
