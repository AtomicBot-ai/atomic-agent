import { copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GAIA_FIXTURES_DIR = resolve(HERE, "..", "fixtures", "gaia");

/**
 * Copy a pre-built GAIA-style fixture (PDF / XLSX / DOCX) from
 * `eval/fixtures/gaia/` into the per-case workspace. Fixtures are
 * generated once by `eval/fixtures/gaia/build-fixtures.mjs` and
 * checked into git so eval runs do not depend on a fixture build
 * step.
 *
 * Usage from an EvalCase setup:
 *
 *     setup: ({ workingDir }) => {
 *       copyGaiaFixture(workingDir, "quarterly-report.pdf");
 *     }
 */
export function copyGaiaFixture(workingDir: string, fileName: string): void {
  copyFileSync(
    join(GAIA_FIXTURES_DIR, fileName),
    join(workingDir, fileName),
  );
}
