/**
 * Hermes-specific import domains and their selection logic. Each import
 * source declares its own importable domains; the shared report layer
 * (`../import-report.ts`) only aggregates the results.
 *
 * `secrets` is gated behind the explicit `--migrate-secrets` flag and
 * `plugins` behind at least one explicit `--trust-plugin <name>`; neither
 * ever enters a preset (see `resolveSelectedOptions`).
 */
export type ImportOptionId = "sessions" | "cron" | "secrets" | "plugins";

/** Preset names exposed via `--preset`. */
export type ImportPresetId = "default" | "full";

export interface ImportOptionMeta {
  id: ImportOptionId;
  label: string;
  description: string;
}

/** Registry of every importable Hermes option. */
export const IMPORT_OPTIONS: readonly ImportOptionMeta[] = [
  {
    id: "sessions",
    label: "Sessions",
    description: "Conversation history (state.db) -> sessions.sqlite",
  },
  {
    id: "cron",
    label: "Cron jobs",
    description: "Scheduled jobs (cron/jobs.json) -> tasks.sqlite",
  },
  {
    id: "secrets",
    label: "Provider key",
    description:
      "OPENROUTER_API_KEY / AIMLAPI_API_KEY (.env) -> <stateDir>/.env",
  },
];
// `plugins` is deliberately absent from the registry: the onboarding and
// TUI import screens render one toggle per registry row, and plugins run
// local Python, so the only way in is the CLI's per-plugin trust list.

/**
 * Presets only ever contain non-secret options. `secrets` is opt-in via
 * `--migrate-secrets` and is intentionally absent from `full` so a broad
 * preset never silently copies credentials.
 */
export const IMPORT_PRESETS: Record<ImportPresetId, readonly ImportOptionId[]> =
  {
    default: ["sessions", "cron"],
    full: ["sessions", "cron"],
  };

export class ImportOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportOptionError";
  }
}

const KNOWN_OPTION_IDS: ReadonlySet<string> = new Set(
  IMPORT_OPTIONS.map((o) => o.id),
);

export interface ResolveOptionsInput {
  preset?: ImportPresetId;
  include?: readonly string[];
  exclude?: readonly string[];
  /** When true, `secrets` is added to the resolved set. */
  migrateSecrets?: boolean;
  /**
   * Plugins the user explicitly trusted (`--trust-plugin`). Non-empty adds
   * `plugins`; plugins run local code, so there is no other way in.
   */
  trustedPlugins?: readonly string[];
}

/**
 * Resolve the final set of selected options. Starts from the preset
 * (default `default`), applies `include`/`exclude`, validates every id
 * against the registry, then conditionally adds `secrets` only when
 * `migrateSecrets` is true. `secrets` cannot be selected through the
 * preset / include path alone — the flag is the single gate.
 */
export function resolveSelectedOptions(
  input: ResolveOptionsInput = {},
): ImportOptionId[] {
  const presetId = input.preset ?? "default";
  if (!(presetId in IMPORT_PRESETS)) {
    throw new ImportOptionError(`unknown preset: ${presetId}`);
  }
  const selected = new Set<ImportOptionId>(IMPORT_PRESETS[presetId]);

  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new ImportOptionError(`unknown option in --include: ${id}`);
    }
    if (id === "secrets") {
      throw new ImportOptionError(
        "secrets cannot be selected via --include; use --migrate-secrets",
      );
    }
    selected.add(id as ImportOptionId);
  }

  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (!KNOWN_OPTION_IDS.has(id)) {
      throw new ImportOptionError(`unknown option in --exclude: ${id}`);
    }
    selected.delete(id as ImportOptionId);
  }

  if (input.migrateSecrets) {
    selected.add("secrets");
  } else {
    selected.delete("secrets");
  }

  // Preserve registry order for deterministic output.
  const out = IMPORT_OPTIONS.map((o) => o.id).filter((id) => selected.has(id));
  if ((input.trustedPlugins ?? []).some((t) => t.trim().length > 0)) {
    out.push("plugins");
  }
  return out;
}
