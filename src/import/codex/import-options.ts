/**
 * Codex-specific import domains and their selection logic. Same contract
 * as the other sources' option modules; `secrets` never enters the
 * default set — the explicit flag is the single gate for credentials.
 */
export type CodexOptionId = "skills" | "memory" | "sessions" | "secrets";

export interface CodexOptionMeta {
  id: CodexOptionId;
  label: string;
  description: string;
}

/** Registry of every importable Codex option. */
export const CODEX_IMPORT_OPTIONS: readonly CodexOptionMeta[] = [
  {
    id: "skills",
    label: "Skills",
    description: "Skill directories (skills/*/SKILL.md) -> global skills dir",
  },
  {
    id: "memory",
    label: "Instructions",
    description: "AGENTS.md -> memory.sqlite",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Rollouts (sessions/**/*.jsonl) -> sessions.sqlite",
  },
  {
    id: "secrets",
    label: "Provider key",
    description: "OPENAI_API_KEY (auth.json) -> <stateDir>/.env",
  },
];

export class CodexOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  CODEX_IMPORT_OPTIONS.map((o) => o.id),
);

/** Everything except `secrets`, which only `migrateSecrets` can add. */
const DEFAULT_OPTIONS: readonly CodexOptionId[] = [
  "skills",
  "memory",
  "sessions",
];

export interface ResolveCodexOptionsInput {
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
export function resolveCodexOptions(
  input: ResolveCodexOptionsInput = {},
): CodexOptionId[] {
  const selected = new Set<CodexOptionId>(DEFAULT_OPTIONS);

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new CodexOptionError(`unknown option in --include: ${id}`);
    }
    if (id === "secrets") {
      throw new CodexOptionError(
        "secrets cannot be selected via --include; use --migrate-secrets",
      );
    }
    selected.add(id as CodexOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new CodexOptionError(`unknown option in --exclude: ${id}`);
    }
    selected.delete(id as CodexOptionId);
  }

  if (input.migrateSecrets) {
    selected.add("secrets");
  } else {
    selected.delete("secrets");
  }

  // Preserve registry order for deterministic output.
  return CODEX_IMPORT_OPTIONS.map((o) => o.id).filter((id) =>
    selected.has(id),
  );
}
