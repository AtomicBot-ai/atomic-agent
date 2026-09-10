import {
  IMPORT_AGENT_LABELS,
  importAgentDir,
  type ImportAgentId,
} from "../../import/index.js";

/**
 * What the Import tab knows about each source, in one place: the cycle
 * order of the source-type row, which option toggles a source supports,
 * and the default dir the form starts on. The importers themselves own
 * the option semantics (`import-options.ts` per source); this registry
 * only says which rows to draw.
 */
export type ImportSourceId = ImportAgentId;

/** Cycle order of the source-type row (←/→ / space / Enter). */
export const IMPORT_SOURCE_IDS: readonly ImportSourceId[] = [
  "hermes",
  "openclaw",
  "claude-code",
  "codex",
];

/** Per-source option toggles, in the row order the form draws them. */
export type ImportOptionToggle =
  "skills" | "memory" | "mcp" | "sessions" | "cron" | "secrets";

export interface ImportToggleMeta {
  id: ImportOptionToggle;
  /** Short muted hint drawn after the checkbox, when there is one. */
  hint?: string;
}

const SOURCE_TOGGLES: Record<ImportSourceId, readonly ImportToggleMeta[]> = {
  hermes: [
    { id: "sessions" },
    { id: "cron" },
    { id: "secrets", hint: "OPENROUTER_API_KEY / AIMLAPI_API_KEY" },
  ],
  openclaw: [{ id: "sessions" }, { id: "cron" }],
  "claude-code": [
    { id: "skills" },
    { id: "memory", hint: "CLAUDE.md + auto-memory notes" },
    { id: "mcp", hint: "servers from ~/.claude.json" },
    { id: "sessions" },
    { id: "secrets", hint: "ANTHROPIC_API_KEY" },
  ],
  codex: [
    { id: "skills" },
    { id: "memory", hint: "AGENTS.md" },
    { id: "sessions" },
    { id: "secrets", hint: "OPENAI_API_KEY" },
  ],
};

/** The toggles a source's form shows, in row order. */
export function importSourceToggles(
  source: ImportSourceId,
): readonly ImportToggleMeta[] {
  return SOURCE_TOGGLES[source];
}

export function importSourceSupports(
  source: ImportSourceId,
  toggle: ImportOptionToggle,
): boolean {
  return SOURCE_TOGGLES[source].some((meta) => meta.id === toggle);
}

/** Human label, shared with the first-run pick list. */
export function importSourceLabel(source: ImportSourceId): string {
  return IMPORT_AGENT_LABELS[source];
}

/** Resolve the default state dir for a source, mirroring the CLI defaults. */
export function defaultSourceDir(source: ImportSourceId): string {
  return importAgentDir(source);
}

/** The placeholder drawn when the source-dir field is empty. */
export function importSourcePlaceholder(source: ImportSourceId): string {
  switch (source) {
    case "hermes":
      return "~/.hermes";
    case "openclaw":
      return "~/.openclaw";
    case "claude-code":
      return "~/.claude";
    case "codex":
      return "~/.codex";
  }
}

/** The source `delta` steps along the cycle, wrapping at both ends. */
export function nextImportSource(
  current: ImportSourceId,
  delta: 1 | -1,
): ImportSourceId {
  const idx = IMPORT_SOURCE_IDS.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next =
    (safe + delta + IMPORT_SOURCE_IDS.length) % IMPORT_SOURCE_IDS.length;
  return IMPORT_SOURCE_IDS[next] ?? "hermes";
}
