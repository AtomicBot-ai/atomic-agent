import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import { setDotenvKey } from "../../config/dotenv-writer.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import { installSkill } from "../../skills/skill-installer.js";
import { parseSkillFile } from "../../skills/skill-manifest.js";
import { MEMORY_CONTENT_MAX_LENGTH } from "../../memory/index.js";
import { readDotenvValue } from "../dotenv-read.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { splitMemoryNote } from "../split-note.js";
import type { ClaudeCodeSource } from "./claude-code-source.js";
import type { ClaudeCodeOptionId } from "./import-options.js";
import { mapClaudeCodeMcpServer } from "./map-mcp.js";
import { mapClaudeCodeSession } from "./map-session.js";

/** The only key ever read from Claude Code's settings or written to `.env`. */
export const CLAUDE_CODE_SECRET_ALLOWLIST = ["ANTHROPIC_API_KEY"] as const;

/** Tag stamped on every imported memory note, for later retrieval/cleanup. */
export const CLAUDE_CODE_MEMORY_TAG = "imported:claude-code";

/**
 * The slice of `MemoryStore` the importer needs. Narrow on purpose: the
 * runtime hands its live `notesStore`, the CLI opens its own handle, and
 * tests stub two methods instead of building a real SQLite store.
 */
export interface ImportMemoryTarget {
  list(opts: { scope: "all"; limit: number }): Array<{ content: string }>;
  store(input: { content: string; tags?: string[]; source?: "user" }): unknown;
}

/**
 * Why the sessions cap exists at all: `~/.claude/projects` grows to
 * gigabytes, and the first-run flow must not spend minutes previewing
 * transcripts nobody asked to keep. The CLI leaves `limit` unset
 * (import everything) unless `--limit` says otherwise; the onboarding
 * step imports this many newest sessions instead.
 */
export const ONBOARDING_SESSION_LIMIT = 100;

export interface ClaudeCodeImporterDeps {
  source: ClaudeCodeSource;
  sessionStore: SessionStore;
  memoryStore: ImportMemoryTarget;
  /** State dir whose `.env` receives the migrated provider key. */
  stateDir: string;
  /** `<stateDir>/config.json`, where imported MCP servers are appended. */
  userConfigFile: string;
  /** Root the imported skills are installed under. */
  globalSkillsDir: string;
  /** Working dir applied to sessions whose transcript recorded no cwd. */
  workingDirFallback: string;
}

export interface ClaudeCodeRunOptions {
  /** Resolved option set (already gated by `resolveClaudeCodeOptions`). */
  options: readonly ClaudeCodeOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed (newest first). */
  limit?: number;
}

/**
 * Orchestrates a one-shot Claude Code -> atomic-agent import. Each option
 * is processed independently and contributes `ImportItemResult`s to a
 * single `ImportReport`. Safe to re-run: unchanged destinations skip on
 * match, differing ones require `overwrite`.
 *
 * Async where the Hermes importer is sync because skill installation
 * copies directories through `installSkill`'s promise API.
 */
export class ClaudeCodeImporter {
  constructor(private readonly deps: ClaudeCodeImporterDeps) {}

  async run(options: ClaudeCodeRunOptions): Promise<ImportReport<ClaudeCodeOptionId>> {
    const items: ImportItemResult<ClaudeCodeOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("skills")) {
      await this.importSkills(items, options);
    }
    if (selected.has("memory")) {
      this.importMemory(items, options);
    }
    if (selected.has("mcp")) {
      this.importMcp(items, options);
    }
    if (selected.has("sessions")) {
      this.importSessions(items, options);
    }
    if (selected.has("secrets")) {
      this.importSecrets(items, options);
    }

    return buildReport(items, options.execute);
  }

  private async importSkills(
    items: ImportItemResult<ClaudeCodeOptionId>[],
    options: ClaudeCodeRunOptions,
  ): Promise<void> {
    const skills = this.deps.source.listSkills();
    if (skills.length === 0) {
      items.push({
        kind: "skills",
        status: "skipped",
        reason: `no skills found in ${this.deps.source.skillsDir()}`,
      });
      return;
    }
    for (const skill of skills) {
      const base: ImportItemResult<ClaudeCodeOptionId> = {
        kind: "skills",
        source: skill.name,
        status: "migrated",
      };
      let manifestName: string;
      try {
        const manifestRaw = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
        manifestName = parseSkillFile(manifestRaw).manifest.name;
      } catch (err) {
        items.push({
          ...base,
          status: "error",
          reason: `invalid SKILL.md: ${errorMessage(err)}`,
        });
        continue;
      }
      const destination = join(this.deps.globalSkillsDir, manifestName);
      const exists = existsSync(destination);
      if (exists) {
        if (manifestsMatch(skill.dir, destination)) {
          items.push({
            ...base,
            destination: manifestName,
            status: "skipped",
            reason: "already installed",
          });
          continue;
        }
        if (!options.overwrite) {
          items.push({
            ...base,
            destination: manifestName,
            status: "conflict",
            reason: "skill exists with a different SKILL.md; use --overwrite",
          });
          continue;
        }
      }
      if (options.execute) {
        try {
          await installSkill({
            sourceDir: skill.dir,
            targetRoot: this.deps.globalSkillsDir,
            force: exists,
          });
        } catch (err) {
          items.push({ ...base, status: "error", reason: errorMessage(err) });
          continue;
        }
      }
      items.push({
        ...base,
        destination: manifestName,
        ...(exists ? { reason: "overwritten" } : {}),
      });
    }
  }

  private importMemory(
    items: ImportItemResult<ClaudeCodeOptionId>[],
    options: ClaudeCodeRunOptions,
  ): void {
    let files;
    try {
      files = this.deps.source.listMemoryFiles();
    } catch (err) {
      items.push({ kind: "memory", status: "error", reason: errorMessage(err) });
      return;
    }
    if (files.length === 0) {
      items.push({
        kind: "memory",
        status: "skipped",
        reason: "no memory notes or CLAUDE.md found",
      });
      return;
    }
    // Exact-content dedup against what the store already holds, so a
    // re-run skips instead of doubling every note.
    const existing = new Set(
      this.deps.memoryStore
        .list({ scope: "all", limit: 100_000 })
        .map((entry) => entry.content),
    );
    for (const file of files) {
      const base: ImportItemResult<ClaudeCodeOptionId> = {
        kind: "memory",
        source: file.relPath,
        status: "migrated",
      };
      // A note longer than the store's cap arrives as several notes
      // rather than an error — losing the biggest notes would invert
      // what an import is for.
      const chunks = splitMemoryNote(file.content, MEMORY_CONTENT_MAX_LENGTH);
      const missing = chunks.filter((chunk) => !existing.has(chunk));
      if (missing.length === 0) {
        items.push({ ...base, status: "skipped", reason: "already imported" });
        continue;
      }
      if (options.execute) {
        try {
          for (const chunk of missing) {
            this.deps.memoryStore.store({
              content: chunk,
              tags: [CLAUDE_CODE_MEMORY_TAG],
              source: "user",
            });
          }
        } catch (err) {
          items.push({ ...base, status: "error", reason: errorMessage(err) });
          continue;
        }
      }
      items.push({
        ...base,
        ...(chunks.length > 1
          ? { reason: `split into ${chunks.length} notes` }
          : {}),
      });
    }
  }

  private importMcp(
    items: ImportItemResult<ClaudeCodeOptionId>[],
    options: ClaudeCodeRunOptions,
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
      const base: ImportItemResult<ClaudeCodeOptionId> = {
        kind: "mcp",
        source: entry.name,
        destination: entry.name,
        status: "migrated",
      };
      const mapped = mapClaudeCodeMcpServer(entry);
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
      items.push(base);
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
    items: ImportItemResult<ClaudeCodeOptionId>[],
    options: ClaudeCodeRunOptions,
  ): void {
    if (!this.deps.source.hasProjects()) {
      items.push({
        kind: "sessions",
        status: "skipped",
        reason: `no projects dir at ${this.deps.source.projectsDir()}`,
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
          // Warm-up / title-only transcript files: nothing to keep.
          continue;
        }
        mapped = mapClaudeCodeSession(session, this.deps.workingDirFallback);
      } catch (err) {
        items.push({
          kind: "sessions",
          source: meta.id,
          status: "error",
          reason: errorMessage(err),
        });
        continue;
      }
      items.push(this.reconcileSession(mapped, meta.id, options));
    }
  }

  private reconcileSession(
    mapped: SessionState,
    sourceId: string,
    options: ClaudeCodeRunOptions,
  ): ImportItemResult<ClaudeCodeOptionId> {
    const base: ImportItemResult<ClaudeCodeOptionId> = {
      kind: "sessions",
      source: sourceId,
      destination: mapped.id,
      status: "migrated",
    };
    const existing = this.deps.sessionStore.load(mapped.id);
    if (!existing) {
      if (options.execute) this.deps.sessionStore.save(mapped);
      return base;
    }
    if (sessionsMatch(existing, mapped)) {
      return { ...base, status: "skipped", reason: "already matches" };
    }
    if (!options.overwrite) {
      return {
        ...base,
        status: "conflict",
        reason: "destination differs; use --overwrite",
      };
    }
    if (options.execute) this.deps.sessionStore.save(mapped);
    return { ...base, status: "migrated", reason: "overwritten" };
  }

  private importSecrets(
    items: ImportItemResult<ClaudeCodeOptionId>[],
    options: ClaudeCodeRunOptions,
  ): void {
    const envMap = this.deps.source.readEnvKeys(CLAUDE_CODE_SECRET_ALLOWLIST);
    if (envMap.size === 0) {
      items.push({
        kind: "secrets",
        status: "skipped",
        reason: "no migratable provider key found in Claude Code settings",
      });
      return;
    }
    const targetEnvPath = join(this.deps.stateDir, ".env");
    for (const key of CLAUDE_CODE_SECRET_ALLOWLIST) {
      const value = envMap.get(key);
      if (value === undefined) continue;
      const current = readDotenvValue(targetEnvPath, key);
      const base: ImportItemResult<ClaudeCodeOptionId> = {
        kind: "secrets",
        source: key,
        destination: key,
        status: "migrated",
      };
      if (current === undefined) {
        if (options.execute) setDotenvKey(this.deps.stateDir, key, value);
        items.push(base);
        continue;
      }
      if (current === value) {
        items.push({ ...base, status: "skipped", reason: "already set" });
        continue;
      }
      if (!options.overwrite) {
        items.push({
          ...base,
          status: "conflict",
          reason: "key exists with a different value; use --overwrite",
        });
        continue;
      }
      if (options.execute) setDotenvKey(this.deps.stateDir, key, value);
      items.push({ ...base, reason: "overwritten" });
    }
  }
}

/** Whether two skill dirs carry byte-identical `SKILL.md` manifests. */
function manifestsMatch(sourceDir: string, targetDir: string): boolean {
  try {
    return (
      readFileSync(join(sourceDir, "SKILL.md"), "utf8") ===
      readFileSync(join(targetDir, "SKILL.md"), "utf8")
    );
  } catch {
    return false;
  }
}

/** Structural equality of two sessions' transcripts. */
function sessionsMatch(a: SessionState, b: SessionState): boolean {
  if (a.turns.length !== b.turns.length) return false;
  return JSON.stringify(a.turns) === JSON.stringify(b.turns);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
