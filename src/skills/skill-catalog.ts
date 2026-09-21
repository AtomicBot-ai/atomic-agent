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
 * The line that stands in for the skills the budget left out, rendered
 * as the last row of `### skills`. Mirrors `clipProfileSection`'s
 * marker: a count and the knob that raises it, so the truncation is
 * visible to the model and actionable for the operator. Without it a
 * short catalog reads as the complete one and the model denies having
 * skills that are installed (issue #466).
 */
export function formatSkillCatalogOmittedLine(count: number): string {
  const noun = count === 1 ? "skill" : "skills";
  return `… [truncated] ${count} more installed ${noun} not shown (skills.catalogTokenBudget)`;
}

/**
 * The catalog plus what it cost: `dropped` is how many installed skills
 * the char budget left out, and it is what makes `### skills` render
 * {@link formatSkillCatalogOmittedLine}. Counts only — no names — so it
 * is safe to log.
 */
export interface SkillCatalogSection {
  entries: SkillCatalogEntry[];
  /** `0` when every record fit. */
  dropped: number;
}

/**
 * Build the skill catalog that lives in the stable prefix.
 * Entries exceeding the soft cap are dropped so the prompt stays bounded.
 * Char budget matches rendered lines (`[global]` / `[project]` tags +
 * newlines between entries).
 *
 * Thin wrapper over {@link buildSkillCatalogSection} for callers that
 * only want the entries.
 */
export function buildSkillCatalog(
  records: ReadonlyArray<SkillRecord>,
  options: BuildCatalogOptions = {},
): SkillCatalogEntry[] {
  return buildSkillCatalogSection(records, options).entries;
}

/**
 * {@link buildSkillCatalog} plus the dropped count the renderer needs.
 *
 * Packed twice when anything overflows: the first pass answers "does the
 * marker line have to exist at all", the second re-packs against a
 * budget reduced by that line, so the marker never pushes the section
 * past `maxChars`. A catalog that fits takes the first pass only and is
 * byte-identical to the pre-marker output (KV-cache safe).
 */
export function buildSkillCatalogSection(
  records: ReadonlyArray<SkillRecord>,
  options: BuildCatalogOptions = {},
): SkillCatalogSection {
  const maxChars =
    options.maxChars ??
    (options.tokenBudget !== undefined
      ? options.tokenBudget * SKILL_CATALOG_CHARS_PER_TOKEN
      : DEFAULT_CATALOG_MAX_CHARS);
  const rows = records.map((record) => {
    const entry: SkillCatalogEntry = {
      name: record.manifest.name,
      description: record.manifest.description,
      source: record.source,
    };
    return { entry, line: formatSkillCatalogLine(entry) };
  });
  const whole = packCatalog(rows, maxChars, 0);
  if (whole.dropped === 0) return whole;
  // Room for the marker at its longest: the count it prints can only be
  // smaller than the record count, so the reserve is never short. The
  // `+ 1` is the newline joining it to the last entry.
  const reserve = formatSkillCatalogOmittedLine(rows.length).length + 1;
  return packCatalog(rows, maxChars, reserve);
}

/**
 * Fill the budget in record order, stopping at the first line that does
 * not fit — the same first-overflow cut the catalog has always made.
 * One entry is always kept, so a single oversized line still overflows
 * the cap exactly as it did before `reserve` existed.
 */
function packCatalog(
  rows: ReadonlyArray<{ entry: SkillCatalogEntry; line: string }>,
  maxChars: number,
  reserve: number,
): SkillCatalogSection {
  const entries: SkillCatalogEntry[] = [];
  let used = 0;
  for (const row of rows) {
    const sep = entries.length > 0 ? 1 : 0;
    if (
      used + sep + row.line.length + reserve > maxChars &&
      entries.length > 0
    ) {
      break;
    }
    used += sep + row.line.length;
    entries.push(row.entry);
  }
  return { entries, dropped: rows.length - entries.length };
}
