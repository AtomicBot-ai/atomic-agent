import {
  CLAUDE_CODE_IMPORT_OPTIONS,
  CODEX_IMPORT_OPTIONS,
  IMPORT_OPTIONS,
  OPENCLAW_IMPORT_OPTIONS,
  type DetectedImportAgent,
  type ImportAgentId,
  type ImportReport,
} from "../../import/index.js";

/**
 * The pure model behind the first-run import screens: which agents were
 * detected and picked, which of their domains are toggled on, and how a
 * finished report reads. Everything here is data in and data out — the
 * effects (detection, the importer runs) live with the host, the same
 * split every other step keeps.
 */

/** One row on the agent pick screen. */
export interface OnboardingImportAgentRow {
  id: ImportAgentId;
  label: string;
  /** Resolved state dir, printed under the label. */
  dir: string;
  enabled: boolean;
}

/** One row on the option toggle screen, grouped by agent. */
export interface OnboardingImportOptionRow {
  agent: ImportAgentId;
  agentLabel: string;
  /** Source-specific option id (`skills`, `sessions`, `secrets`, …). */
  option: string;
  label: string;
  description: string;
  /** Credential rows start off and say so — nothing migrates keys silently. */
  secret: boolean;
  enabled: boolean;
}

/** What the host needs to actually run the import. */
export interface OnboardingImportPlan {
  agents: readonly OnboardingImportAgentRow[];
  options: readonly OnboardingImportOptionRow[];
}

export interface ImportOfferInputs {
  /** `tui.onboarding.importOfferedAt` — the offer was already made. */
  alreadyOffered: boolean;
}

/**
 * Whether the closing flow should raise the import step. Once per
 * machine, recorded in config when shown — and that stamp is the ONLY
 * gate: no outcome, shortcut or skip flag may route around this screen.
 * The screen carries its own always-present skip row, so declining costs
 * one keypress there instead.
 */
export function shouldOfferImport(inputs: ImportOfferInputs): boolean {
  return !inputs.alreadyOffered;
}

/**
 * Detected agents as pick rows, all unticked — importing someone's data
 * is opt-in per agent, and the import row only appears once something
 * is ticked.
 */
export function buildImportAgentRows(
  detected: readonly DetectedImportAgent[],
): OnboardingImportAgentRow[] {
  return detected.map((agent) => ({
    id: agent.id,
    label: agent.label,
    dir: agent.dir,
    enabled: false,
  }));
}

/** The always-present last list row: straight to the agent, no import. */
export const IMPORT_SKIP_LABEL = "Skip adding data from other agents";

/** The action row's label, sized to what is ticked. */
export function importActionLabel(picked: number): string {
  return picked === 1 ? "Import from 1 agent" : `Import from ${picked} agents`;
}

/** One navigable row on the redesigned pick screen. */
export type OnboardingImportPickRow =
  | { kind: "agent"; index: number; agent: OnboardingImportAgentRow }
  | { kind: "skip" }
  | { kind: "import"; picked: number };

/**
 * The pick screen's full row list: every detected agent as a tickbox,
 * then the skip row — always there, so leaving is never more than a
 * cursor-down away — and, once at least one agent is ticked, the import
 * action. One derivation shared by the render, the measure and the key
 * handler, so the three cannot disagree about what a cursor index means.
 */
export function buildImportPickRows(
  agents: readonly OnboardingImportAgentRow[],
): OnboardingImportPickRow[] {
  const rows: OnboardingImportPickRow[] = agents.map((agent, index) => ({
    kind: "agent",
    index,
    agent,
  }));
  rows.push({ kind: "skip" });
  const picked = agents.filter((agent) => agent.enabled).length;
  if (picked > 0) rows.push({ kind: "import", picked });
  return rows;
}

/**
 * The option rows for the picked agents, in pick order, each agent
 * contributing its own registry. Non-secret options start on; `secrets`
 * rows start off, mirroring the CLI where only an explicit flag selects
 * them.
 */
export function buildImportOptionRows(
  agents: readonly OnboardingImportAgentRow[],
): OnboardingImportOptionRow[] {
  const rows: OnboardingImportOptionRow[] = [];
  for (const agent of agents) {
    if (!agent.enabled) continue;
    for (const meta of optionRegistryFor(agent.id)) {
      const secret = meta.id === "secrets";
      rows.push({
        agent: agent.id,
        agentLabel: agent.label,
        option: meta.id,
        label: meta.label,
        description: meta.description,
        secret,
        enabled: !secret,
      });
    }
  }
  return rows;
}

interface OptionMetaLike {
  id: string;
  label: string;
  description: string;
}

function optionRegistryFor(id: ImportAgentId): readonly OptionMetaLike[] {
  switch (id) {
    case "hermes":
      return IMPORT_OPTIONS;
    case "openclaw":
      return OPENCLAW_IMPORT_OPTIONS;
    case "claude-code":
      return CLAUDE_CODE_IMPORT_OPTIONS;
    case "codex":
      return CODEX_IMPORT_OPTIONS;
  }
}

/**
 * The preview / result screens' body: one line per domain that has
 * anything to say, plus the summary. Pure formatting over the report so
 * the render and its test read the same lines.
 */
export function summarizeImportReport(report: ImportReport): string[] {
  const byKind = new Map<string, { migrated: number; skipped: number; conflict: number; error: number }>();
  for (const item of report.items) {
    let counts = byKind.get(item.kind);
    if (!counts) {
      counts = { migrated: 0, skipped: 0, conflict: 0, error: 0 };
      byKind.set(item.kind, counts);
    }
    counts[item.status] += 1;
  }
  const lines: string[] = [];
  const migratedLabel = report.executed ? "migrated" : "to migrate";
  for (const [kind, counts] of byKind) {
    const parts: string[] = [];
    if (counts.migrated > 0) parts.push(`${counts.migrated} ${migratedLabel}`);
    if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
    if (counts.conflict > 0) parts.push(`${counts.conflict} in conflict`);
    if (counts.error > 0) parts.push(`${counts.error} failed`);
    if (parts.length === 0) continue;
    lines.push(`${kind}: ${parts.join(", ")}`);
  }
  return lines;
}
