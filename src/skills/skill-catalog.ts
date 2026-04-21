import type { SkillCatalogEntry } from "../prompt/stable-prefix.js";
import type { SkillRecord } from "./skill-loader.js";

export interface BuildCatalogOptions {
  /** Soft cap for total catalog chars (≈ token budget × 4). Defaults to 2000. */
  maxChars?: number;
}

/**
 * Build the `name: description` catalog that lives in the stable prefix.
 * Entries exceeding the soft cap are dropped with an explicit "[N more
 * skills omitted]" marker so the LLM knows there are more skills available
 * via `skill list` but the prompt stays bounded.
 */
export function buildSkillCatalog(
  records: ReadonlyArray<SkillRecord>,
  options: BuildCatalogOptions = {},
): SkillCatalogEntry[] {
  const maxChars = options.maxChars ?? 2000;
  const entries: SkillCatalogEntry[] = [];
  let used = 0;
  for (const record of records) {
    const entry: SkillCatalogEntry = {
      name: record.manifest.name,
      description: record.manifest.description,
      source: record.source,
    };
    const line = `- ${entry.name}: ${entry.description}\n`;
    if (used + line.length > maxChars && entries.length > 0) break;
    used += line.length;
    entries.push(entry);
  }
  return entries;
}
