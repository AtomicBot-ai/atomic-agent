/**
 * Pi-specific import domains and their selection logic. Same contract
 * as the other sources: the source declares its own importable domains
 * and the shared report layer only aggregates results. Pi has no
 * `secrets` domain — upstream Pi keeps provider credentials in
 * `auth.json`, whose per-provider shapes this importer does not read.
 */
export type PiOptionId = "skills" | "sessions";

export interface PiOptionMeta {
  id: PiOptionId;
  label: string;
  description: string;
}

/** Registry of every importable Pi option. */
export const PI_IMPORT_OPTIONS: readonly PiOptionMeta[] = [
  {
    id: "skills",
    label: "Skills",
    description: "Skill directories (skills/**/SKILL.md) -> global skills dir",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Transcripts (sessions/*/*.jsonl) -> sessions.sqlite",
  },
];

export class PiOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  PI_IMPORT_OPTIONS.map((o) => o.id),
);

export interface ResolvePiOptionsInput {
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Resolve the final option set: every domain on by default, `include` /
 * `exclude` applied, every id validated against the registry.
 */
export function resolvePiOptions(
  input: ResolvePiOptionsInput = {},
): PiOptionId[] {
  const selected = new Set<PiOptionId>(PI_IMPORT_OPTIONS.map((o) => o.id));

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new PiOptionError(`unknown option in --include: ${id}`);
    }
    selected.add(id as PiOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new PiOptionError(`unknown option in --exclude: ${id}`);
    }
    selected.delete(id as PiOptionId);
  }

  // Preserve registry order for deterministic output.
  return PI_IMPORT_OPTIONS.map((o) => o.id).filter((id) => selected.has(id));
}
