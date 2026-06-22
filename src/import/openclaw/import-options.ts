/**
 * OpenClaw-specific import domains and their selection logic. Mirrors the
 * Hermes options module, but OpenClaw v1 imports only `sessions` and
 * `cron` — secrets are intentionally out of scope because OpenClaw keeps
 * provider keys in `openclaw.json` (often as placeholders / env-var
 * names), not in a `.env` file with a clean allowlist.
 */
export type OpenclawOptionId = "sessions" | "cron";

export interface OpenclawOptionMeta {
  id: OpenclawOptionId;
  label: string;
  description: string;
}

/** Registry of every importable OpenClaw option. */
export const OPENCLAW_IMPORT_OPTIONS: readonly OpenclawOptionMeta[] = [
  {
    id: "sessions",
    label: "Sessions",
    description: "Transcript logs (agents/<agent>/sessions/*.jsonl) -> sessions.sqlite",
  },
  {
    id: "cron",
    label: "Cron jobs",
    description: "Scheduled jobs (state/openclaw.sqlite cron_jobs) -> tasks.sqlite",
  },
];

export class OpenclawOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenclawOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  OPENCLAW_IMPORT_OPTIONS.map((o) => o.id),
);

export interface ResolveOpenclawOptionsInput {
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Resolve the final set of selected options. Starts from the full set
 * (`sessions` + `cron`), applies `include` / `exclude`, and validates
 * every id against the registry. Order is deterministic (registry order).
 */
export function resolveOpenclawOptions(
  input: ResolveOpenclawOptionsInput = {},
): OpenclawOptionId[] {
  const selected = new Set<OpenclawOptionId>(
    OPENCLAW_IMPORT_OPTIONS.map((o) => o.id),
  );

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new OpenclawOptionError(`unknown option in include: ${id}`);
    }
    selected.add(id as OpenclawOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new OpenclawOptionError(`unknown option in exclude: ${id}`);
    }
    selected.delete(id as OpenclawOptionId);
  }

  return OPENCLAW_IMPORT_OPTIONS.map((o) => o.id).filter((id) =>
    selected.has(id),
  );
}
