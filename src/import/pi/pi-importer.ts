import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { importSkillDirs } from "../import-skill-dirs.js";
import { reconcileImportedSession } from "../reconcile-session.js";
import type { PiOptionId } from "./import-options.js";
import { mapPiSession } from "./map-session.js";
import type { PiSource } from "./pi-source.js";

export interface PiImporterDeps {
  source: PiSource;
  sessionStore: SessionStore;
  /** Root the imported skills are installed under. */
  globalSkillsDir: string;
  /** Working dir applied to sessions whose transcript recorded no cwd. */
  workingDirFallback: string;
}

export interface PiRunOptions {
  /** Resolved option set (already gated by `resolvePiOptions`). */
  options: readonly PiOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed (newest first). */
  limit?: number;
}

/**
 * Orchestrates a one-shot Pi -> atomic-agent import. Each option is
 * processed independently and contributes `ImportItemResult`s to a
 * single `ImportReport`. Safe to re-run: unchanged destinations skip on
 * match, differing ones require `overwrite`. Async because skill
 * installation copies directories through `installSkill`'s promise API.
 */
export class PiImporter {
  constructor(private readonly deps: PiImporterDeps) {}

  async run(options: PiRunOptions): Promise<ImportReport<PiOptionId>> {
    const items: ImportItemResult<PiOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("skills")) {
      await this.importSkills(items, options);
    }
    if (selected.has("sessions")) {
      this.importSessions(items, options);
    }

    return buildReport(items, options.execute);
  }

  private async importSkills(
    items: ImportItemResult<PiOptionId>[],
    options: PiRunOptions,
  ): Promise<void> {
    await importSkillDirs({
      kind: "skills",
      skills: this.deps.source.listSkills(),
      skillsDir: this.deps.source.skillsDir(),
      globalSkillsDir: this.deps.globalSkillsDir,
      execute: options.execute,
      overwrite: options.overwrite,
      items,
    });
  }

  private importSessions(
    items: ImportItemResult<PiOptionId>[],
    options: PiRunOptions,
  ): void {
    if (!this.deps.source.hasSessions()) {
      items.push({
        kind: "sessions",
        status: "skipped",
        reason: `no sessions dir at ${this.deps.source.sessionsDir()}`,
      });
      return;
    }
    let metas = this.deps.source.listSessions();
    if (options.limit !== undefined && options.limit >= 0) {
      metas = metas.slice(0, options.limit);
    }
    for (const meta of metas) {
      let mapped: SessionState;
      try {
        const session = this.deps.source.readSession(meta);
        if (session.messages.length === 0) {
          // Header-only transcript files: nothing to keep, but the
          // report still lists them so its counts add up to what the
          // listing found.
          items.push({
            kind: "sessions",
            source: meta.id,
            status: "skipped",
            reason: "no messages",
          });
          continue;
        }
        mapped = mapPiSession(session, this.deps.workingDirFallback);
      } catch (err) {
        items.push({
          kind: "sessions",
          source: meta.id,
          status: "error",
          reason: errorMessage(err),
        });
        continue;
      }
      const base: ImportItemResult<PiOptionId> = {
        kind: "sessions",
        source: meta.id,
        destination: mapped.id,
        status: "migrated",
      };
      const outcome = reconcileImportedSession({
        existing: this.deps.sessionStore.load(mapped.id),
        mapped,
        execute: options.execute,
        overwrite: options.overwrite,
        save: (state) => this.deps.sessionStore.save(state),
      });
      items.push({
        ...base,
        status: outcome.status,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
