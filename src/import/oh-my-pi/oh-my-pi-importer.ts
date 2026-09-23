import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { importSkillDirs } from "../import-skill-dirs.js";
import { reconcileImportedSession } from "../reconcile-session.js";
import type { OhMyPiOptionId } from "./import-options.js";
import { mapOhMyPiMcpServer } from "./map-mcp.js";
import { mapOhMyPiSession } from "./map-session.js";
import type { OhMyPiSource } from "./oh-my-pi-source.js";

export interface OhMyPiImporterDeps {
  source: OhMyPiSource;
  sessionStore: SessionStore;
  /** `<stateDir>/config.json`, where imported MCP servers are appended. */
  userConfigFile: string;
  /** Root the imported skills are installed under. */
  globalSkillsDir: string;
  /** Working dir applied to sessions whose transcript recorded no cwd. */
  workingDirFallback: string;
}

export interface OhMyPiRunOptions {
  /** Resolved option set (already gated by `resolveOhMyPiOptions`). */
  options: readonly OhMyPiOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed (newest first). */
  limit?: number;
}

/**
 * Orchestrates a one-shot Oh-My-Pi -> atomic-agent import: options are
 * processed independently into one `ImportReport`, re-runs skip on
 * match, and differing destinations require `overwrite`. Async because
 * `installSkill` copies skill directories through a promise API.
 */
export class OhMyPiImporter {
  constructor(private readonly deps: OhMyPiImporterDeps) {}

  async run(options: OhMyPiRunOptions): Promise<ImportReport<OhMyPiOptionId>> {
    const items: ImportItemResult<OhMyPiOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("skills")) {
      await this.importSkills(items, options);
    }
    if (selected.has("mcp")) {
      this.importMcp(items, options);
    }
    if (selected.has("sessions")) {
      this.importSessions(items, options);
    }

    return buildReport(items, options.execute);
  }

  private async importSkills(
    items: ImportItemResult<OhMyPiOptionId>[],
    options: OhMyPiRunOptions,
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

  private importMcp(
    items: ImportItemResult<OhMyPiOptionId>[],
    options: OhMyPiRunOptions,
  ): void {
    let servers;
    try {
      servers = this.deps.source.readMcpServers();
    } catch (err) {
      items.push({ kind: "mcp", status: "error", reason: errorMessage(err) });
      return;
    }
    if (servers.length === 0) {
      items.push({
        kind: "mcp",
        status: "skipped",
        reason: `no mcpServers found in ${this.deps.source.mcpConfigPath()}`,
      });
      return;
    }
    const path = this.deps.userConfigFile;
    const prev = ensureUserConfigFileSync(path);
    const existingNames = new Set(prev.mcp.servers.map((s) => s.name));
    const toAppend: McpServerConfig[] = [];
    for (const entry of servers) {
      const base: ImportItemResult<OhMyPiOptionId> = {
        kind: "mcp",
        source: entry.name,
        destination: entry.name,
        status: "migrated",
      };
      const mapped = mapOhMyPiMcpServer(entry);
      if (mapped.kind === "skip") {
        items.push({ ...base, status: "skipped", reason: mapped.reason });
        continue;
      }
      if (existingNames.has(mapped.server.name)) {
        // Name collisions never overwrite, even with the flag: the
        // existing entry may carry the operator's own edits, and MCP
        // servers are cheap to re-add by hand next to a renamed twin.
        items.push({
          ...base,
          status: "skipped",
          reason: "server with this name already configured",
        });
        continue;
      }
      toAppend.push(mapped.server);
      items.push({
        ...base,
        ...(entry.disabled ? { reason: "disabled in mcp.json" } : {}),
      });
    }
    if (!options.execute || toAppend.length === 0) return;
    try {
      const nextMcp = {
        ...prev.mcp,
        servers: [...prev.mcp.servers, ...toAppend],
      };
      const validated = parseUserConfigFile({ ...prev, mcp: nextMcp });
      writeUserConfigFileSync(path, validated);
      resetConfigCache();
    } catch (err) {
      const reason =
        err instanceof ConfigValidationError
          ? `${err.field}: ${err.message}`
          : errorMessage(err);
      // The single write failed: every "migrated" mcp item above is a
      // claim the file does not back. Downgrade them all to errors.
      for (const item of items) {
        if (item.kind === "mcp" && item.status === "migrated") {
          item.status = "error";
          item.reason = `config write failed: ${reason}`;
        }
      }
    }
  }

  private importSessions(
    items: ImportItemResult<OhMyPiOptionId>[],
    options: OhMyPiRunOptions,
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
          // Header-only transcripts: listed so the report's counts
          // still add up to what the listing found.
          items.push({
            kind: "sessions",
            source: meta.id,
            status: "skipped",
            reason: "no messages",
          });
          continue;
        }
        mapped = mapOhMyPiSession(session, this.deps.workingDirFallback);
      } catch (err) {
        items.push({
          kind: "sessions",
          source: meta.id,
          status: "error",
          reason: errorMessage(err),
        });
        continue;
      }
      const base: ImportItemResult<OhMyPiOptionId> = {
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
