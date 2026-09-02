/**
 * Claude Code-specific import domains and their selection logic. Same
 * contract as the Hermes module: the source declares its own importable
 * domains, the shared report layer only aggregates results, and
 * `secrets` never enters a preset — the explicit flag is the single
 * gate for credentials.
 */
export type ClaudeCodeOptionId =
  | "skills"
  | "memory"
  | "mcp"
  | "sessions"
  | "secrets";

export interface ClaudeCodeOptionMeta {
  id: ClaudeCodeOptionId;
  label: string;
  description: string;
}

/** Registry of every importable Claude Code option. */
export const CLAUDE_CODE_IMPORT_OPTIONS: readonly ClaudeCodeOptionMeta[] = [
  {
    id: "skills",
    label: "Skills",
    description: "Skill directories (skills/*/SKILL.md) -> global skills dir",
  },
  {
    id: "memory",
    label: "Memory",
    description: "Auto-memory notes + CLAUDE.md -> memory.sqlite",
  },
  {
    id: "mcp",
    label: "MCP servers",
    description: "mcpServers (~/.claude.json) -> config.mcp.servers",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Transcripts (projects/*/*.jsonl) -> sessions.sqlite",
  },
  {
    id: "secrets",
    label: "Provider key",
    description: "ANTHROPIC_API_KEY (settings.json env) -> <stateDir>/.env",
  },
];

export class ClaudeCodeOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  CLAUDE_CODE_IMPORT_OPTIONS.map((o) => o.id),
);

/** Everything except `secrets`, which only `migrateSecrets` can add. */
const DEFAULT_OPTIONS: readonly ClaudeCodeOptionId[] = [
  "skills",
  "memory",
  "mcp",
  "sessions",
];

export interface ResolveClaudeCodeOptionsInput {
  include?: readonly string[];
  exclude?: readonly string[];
  /** When true, `secrets` is added to the resolved set. */
  migrateSecrets?: boolean;
}

/**
 * Resolve the final option set: the non-secret default, `include` /
 * `exclude` applied, every id validated against the registry, and
 * `secrets` added only through the explicit flag.
 */
export function resolveClaudeCodeOptions(
  input: ResolveClaudeCodeOptionsInput = {},
): ClaudeCodeOptionId[] {
  const selected = new Set<ClaudeCodeOptionId>(DEFAULT_OPTIONS);

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new ClaudeCodeOptionError(`unknown option in --include: ${id}`);
    }
    if (id === "secrets") {
      throw new ClaudeCodeOptionError(
        "secrets cannot be selected via --include; use --migrate-secrets",
      );
    }
    selected.add(id as ClaudeCodeOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new ClaudeCodeOptionError(`unknown option in --exclude: ${id}`);
    }
    selected.delete(id as ClaudeCodeOptionId);
  }

  if (input.migrateSecrets) {
    selected.add("secrets");
  } else {
    selected.delete("secrets");
  }

  // Preserve registry order for deterministic output.
  return CLAUDE_CODE_IMPORT_OPTIONS.map((o) => o.id).filter((id) =>
    selected.has(id),
  );
}
