/**
 * Oh-My-Pi-specific import domains and their selection logic. Same
 * contract as the other sources: the source declares its own importable
 * domains and the shared report layer only aggregates results. No
 * `secrets` domain — Oh-My-Pi keeps credentials in `auth.json`, whose
 * per-provider shapes this importer does not read.
 */
export type OhMyPiOptionId = "skills" | "mcp" | "sessions";

export interface OhMyPiOptionMeta {
  id: OhMyPiOptionId;
  label: string;
  description: string;
}

/** Registry of every importable Oh-My-Pi option. */
export const OH_MY_PI_IMPORT_OPTIONS: readonly OhMyPiOptionMeta[] = [
  {
    id: "skills",
    label: "Skills",
    description: "Skill directories (skills/*/SKILL.md) -> global skills dir",
  },
  {
    id: "mcp",
    label: "MCP servers",
    description: "mcpServers (mcp.json) -> config.mcp.servers",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Transcripts (sessions/*/*.jsonl) -> sessions.sqlite",
  },
];

export class OhMyPiOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OhMyPiOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  OH_MY_PI_IMPORT_OPTIONS.map((o) => o.id),
);

export interface ResolveOhMyPiOptionsInput {
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Resolve the final option set: every domain on by default, `include` /
 * `exclude` applied, every id validated against the registry.
 */
export function resolveOhMyPiOptions(
  input: ResolveOhMyPiOptionsInput = {},
): OhMyPiOptionId[] {
  const selected = new Set<OhMyPiOptionId>(
    OH_MY_PI_IMPORT_OPTIONS.map((o) => o.id),
  );

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new OhMyPiOptionError(`unknown option in --include: ${id}`);
    }
    selected.add(id as OhMyPiOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new OhMyPiOptionError(`unknown option in --exclude: ${id}`);
    }
    selected.delete(id as OhMyPiOptionId);
  }

  // Preserve registry order for deterministic output.
  return OH_MY_PI_IMPORT_OPTIONS.map((o) => o.id).filter((id) =>
    selected.has(id),
  );
}
