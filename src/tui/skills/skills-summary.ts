import type { SkillRecord } from "../../skills/skill-loader.js";
import type { SkillSummaryRow } from "./skills-panel-state.js";

/**
 * Compact `SkillRecord + disabled` to `SkillSummaryRow`. Strips the
 * description to a single collapsed line so a long multi-line one in
 * the manifest never wraps the table.
 */
export function toSkillSummaryRow(
  record: SkillRecord,
  disabled: boolean,
): SkillSummaryRow {
  return {
    name: record.manifest.name,
    description: condenseDescription(record.manifest.description),
    version: record.manifest.version,
    source: record.source,
    disabled,
  };
}

/**
 * Convenience for the orchestrator — maps the unfiltered registry view
 * (`SkillRegistry.listAll()`) directly into UI rows in one pass.
 */
export function toSkillSummaryRows(
  entries: ReadonlyArray<{ record: SkillRecord; disabled: boolean }>,
): SkillSummaryRow[] {
  return entries.map(({ record, disabled }) =>
    toSkillSummaryRow(record, disabled),
  );
}

/** Hard cap on the description preview rendered in the list view. */
export const SKILL_SUMMARY_DESCRIPTION_MAX_CHARS = 80;

function condenseDescription(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SKILL_SUMMARY_DESCRIPTION_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SKILL_SUMMARY_DESCRIPTION_MAX_CHARS - 1)}…`;
}
