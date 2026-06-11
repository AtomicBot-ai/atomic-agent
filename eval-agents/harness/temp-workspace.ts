import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GaiaRow } from "./gaia-types.js";
import { resolveAttachmentPath } from "./load-gaia-rows.js";

export interface GaiaWorkspace {
  workingDir: string;
  stateDir: string;
  cleanup: () => void;
}

export function createGaiaWorkspace(
  taskId: string,
  row: GaiaRow,
  split: "validation" | "test" = "validation",
): GaiaWorkspace {
  const base = mkdtempSync(join(tmpdir(), `eval-agents-${taskId}-`));
  const workingDir = join(base, "cwd");
  const stateDir = join(base, "state");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  if (row.fixture_file_text && row.file_name) {
    writeFileSync(join(workingDir, row.file_name), row.fixture_file_text, "utf8");
  } else {
    const attachment = resolveAttachmentPath(row, split);
    if (attachment && row.file_name) {
      copyFileSync(attachment, join(workingDir, row.file_name));
    }
  }

  return {
    workingDir,
    stateDir,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
