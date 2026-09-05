import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which other agents' state this machine actually holds, answered from
 * the filesystem alone. Shared by the first-run flow (which only offers
 * an import when there is something to import) and by anything else that
 * wants to name the sources without hard-coding their layouts.
 *
 * Detection is deliberately shallow — "does the state dir hold at least
 * one artefact this importer knows how to read" — because the price of a
 * false positive is one preview that reports nothing to migrate, while
 * the price of a probe that opens databases is paying the full read on
 * every launch that reaches the check.
 */
export type ImportAgentId = "hermes" | "openclaw" | "claude-code" | "codex";

export interface DetectedImportAgent {
  id: ImportAgentId;
  /** Human name, as the pick list prints it. */
  label: string;
  /** Resolved state dir the importer would read. */
  dir: string;
}

export interface DetectImportAgentsOptions {
  /** Home dir the default state dirs hang off. Injectable for tests. */
  home?: string;
  /** Env map consulted for the `*_STATE_DIR` overrides. */
  env?: Record<string, string | undefined>;
}

/** Display names, in the order the pick list shows them. */
export const IMPORT_AGENT_LABELS: Record<ImportAgentId, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** Resolve the state dir an agent would be imported from. */
export function importAgentDir(
  id: ImportAgentId,
  options: DetectImportAgentsOptions = {},
): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  switch (id) {
    case "hermes":
      return env.HERMES_STATE_DIR ?? join(home, ".hermes");
    case "openclaw":
      return env.OPENCLAW_STATE_DIR ?? join(home, ".openclaw");
    case "claude-code":
      return env.CLAUDE_CODE_STATE_DIR ?? join(home, ".claude");
    case "codex":
      return env.CODEX_STATE_DIR ?? join(home, ".codex");
  }
}

/**
 * Scan for known agents with importable state, in pick-list order. An
 * agent is detected when its state dir holds at least one artefact the
 * matching importer reads — a bare empty dir does not count, so an
 * uninstalled tool whose installer only made the folder is not offered.
 */
export function detectImportAgents(
  options: DetectImportAgentsOptions = {},
): DetectedImportAgent[] {
  const detected: DetectedImportAgent[] = [];
  for (const id of Object.keys(IMPORT_AGENT_LABELS) as ImportAgentId[]) {
    const dir = importAgentDir(id, options);
    if (!hasImportableState(id, dir)) continue;
    detected.push({ id, label: IMPORT_AGENT_LABELS[id], dir });
  }
  return detected;
}

function hasImportableState(id: ImportAgentId, dir: string): boolean {
  switch (id) {
    case "hermes":
      return (
        existsSync(join(dir, "state.db")) ||
        existsSync(join(dir, "cron", "jobs.json"))
      );
    case "openclaw":
      return (
        existsSync(join(dir, "agents")) ||
        existsSync(join(dir, "state", "openclaw.sqlite"))
      );
    case "claude-code":
      return (
        existsSync(join(dir, "projects")) ||
        existsSync(join(dir, "skills")) ||
        existsSync(join(dir, "settings.json"))
      );
    case "codex":
      return (
        existsSync(join(dir, "sessions")) ||
        existsSync(join(dir, "skills")) ||
        existsSync(join(dir, "auth.json")) ||
        existsSync(join(dir, "AGENTS.md"))
      );
  }
}
