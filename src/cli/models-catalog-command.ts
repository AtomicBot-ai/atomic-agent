/**
 * `atomic-agent models catalog [--refresh] [--json]` (ATO-27).
 *
 * Lists the rows an opt-in external catalog adds to the local model
 * list, each with its compatibility mark for this machine, and the
 * entries that were dropped with the reason. `--refresh` fetches the
 * URL named in `ATOMIC_AGENT_MODEL_CATALOG_URL` (environment or
 * `<stateDir>/.env`) into the cache first. No URL is built in: which
 * catalog to offer by default is not decided yet.
 */

import { getConfig, resetConfigCache } from "../config/index.js";
import {
  catalogCompatibility,
  EXTERNAL_CATALOG_FILENAME,
  EXTERNAL_CATALOG_URL_ENV,
  externalCatalogUrl,
  loadExternalCatalog,
  refreshExternalCatalog,
  type CatalogCompatibility,
  type ExternalCatalog,
} from "../local-llm/catalog/external-catalog.js";
import type { MachineForModels } from "../local-llm/catalog/model-upgrade.js";
import type { LocalModelDef } from "../local-llm/catalog/models-catalog.js";
import { probeConfiguredMachine } from "../local-llm/model-upgrade-runner.js";

export interface CatalogCommandDeps {
  probe?: () => Promise<MachineForModels>;
  refresh?: typeof refreshExternalCatalog;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface CatalogRow {
  def: LocalModelDef;
  compatibility: CatalogCompatibility | null;
}

/** The table `models catalog` prints. Pure, for the tests. */
export function formatCatalogRows(rows: readonly CatalogRow[]): string {
  if (rows.length === 0) return "";
  const lines = ["ID                                  | SIZE    | FIT        | SPEED"];
  for (const { def, compatibility } of rows) {
    const fit = compatibility?.fit.label ?? "unknown";
    const speed = compatibility?.speed?.label ?? "-";
    lines.push(`${def.id.padEnd(35)} | ${def.sizeLabel.padEnd(7)} | ${fit.padEnd(10)} | ${speed}`);
  }
  return lines.join("\n") + "\n";
}

export async function runModelsCatalog(
  args: readonly string[],
  deps: CatalogCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const stateDir = getConfig().paths.stateDir;
  let refreshError: string | null = null;

  if (args.includes("--refresh")) {
    const url = externalCatalogUrl(deps.env ?? process.env);
    if (!url) {
      write(
        `no catalog URL: set ${EXTERNAL_CATALOG_URL_ENV} to an https URL ` +
          `(environment or <stateDir>/.env) to use --refresh\n`,
      );
      return 1;
    }
    const result = await (deps.refresh ?? refreshExternalCatalog)({ url, stateDir });
    refreshError = result.error;
    // The rows the rest of this process resolves come from config load.
    resetConfigCache();
    getConfig();
  }

  const catalog: ExternalCatalog = loadExternalCatalog(stateDir);
  const machine = await (deps.probe ?? (() => probeConfiguredMachine()))().catch(() => null);
  const rows: CatalogRow[] = catalog.entries.map((def) => ({
    def,
    compatibility: machine ? catalogCompatibility(def, machine) : null,
  }));

  if (args.includes("--json")) {
    write(
      JSON.stringify({
        version: 1,
        models: rows.map(({ def, compatibility }) => ({
          id: def.id,
          name: def.name,
          sizeLabel: def.sizeLabel,
          fileSizeGb: def.fileSizeGb,
          minRamGb: def.minRamGb,
          recommendedRamGb: def.recommendedRamGb,
          vramGb: def.vramGb ?? null,
          fit: compatibility?.fit.tier ?? null,
          fitLabel: compatibility?.fit.label ?? null,
          speed: compatibility?.speed?.label ?? null,
          why: compatibility?.why ?? null,
        })),
        rejected: catalog.rejected,
        refreshError,
      }) + "\n",
    );
    return refreshError ? 1 : 0;
  }

  if (refreshError) write(`refresh failed, kept the previous catalog: ${refreshError}\n`);
  if (rows.length === 0) {
    write(
      `no external catalog models. Put a ${EXTERNAL_CATALOG_FILENAME} in ${stateDir}, ` +
        `or set ${EXTERNAL_CATALOG_URL_ENV} and run \`models catalog --refresh\`.\n`,
    );
  } else {
    write(formatCatalogRows(rows));
    write("Pull one with `atomic-agent models pull <id>`. Speeds are estimates.\n");
  }
  for (const line of catalog.rejected) write(`skipped: ${line}\n`);
  return refreshError ? 1 : 0;
}
