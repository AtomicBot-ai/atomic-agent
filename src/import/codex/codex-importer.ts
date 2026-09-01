import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setDotenvKey } from "../../config/dotenv-writer.js";
import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import { installSkill } from "../../skills/skill-installer.js";
import { parseSkillFile } from "../../skills/skill-manifest.js";
import { MEMORY_CONTENT_MAX_LENGTH } from "../../memory/index.js";
import type { ImportMemoryTarget } from "../claude-code/claude-code-importer.js";
import { readDotenvValue } from "../dotenv-read.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { splitMemoryNote } from "../split-note.js";
import type { CodexSource } from "./codex-source.js";
import type { CodexOptionId } from "./import-options.js";
import { mapCodexSession } from "./map-session.js";

/** The only key ever read from Codex's `auth.json` or written to `.env`. */
export const CODEX_SECRET_ALLOWLIST = ["OPENAI_API_KEY"] as const;

/** Tag stamped on the imported AGENTS.md note, for later retrieval/cleanup. */
export const CODEX_MEMORY_TAG = "imported:codex";

export interface CodexImporterDeps {
  source: CodexSource;
  sessionStore: SessionStore;
  memoryStore: ImportMemoryTarget;
  /** State dir whose `.env` receives the migrated provider key. */
  stateDir: string;
  /** Root the imported skills are installed under. */
  globalSkillsDir: string;
  /** Working dir applied to sessions whose rollout recorded no cwd. */
  workingDirFallback: string;
}

export interface CodexRunOptions {
  /** Resolved option set (already gated by `resolveCodexOptions`). */
  options: readonly CodexOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed (newest first). */
  limit?: number;
}

/**
 * Orchestrates a one-shot Codex -> atomic-agent import. Same contract as
 * the other importers: each option contributes independently, unchanged
 * destinations skip on re-run, differing ones require `overwrite`.
 */
export class CodexImporter {
  constructor(private readonly deps: CodexImporterDeps) {}

  async run(options: CodexRunOptions): Promise<ImportReport<CodexOptionId>> {
    const items: ImportItemResult<CodexOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("skills")) {
      await this.importSkills(items, options);
    }
    if (selected.has("memory")) {
      this.importMemory(items, options);
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
    items: ImportItemResult<CodexOptionId>[],
    options: CodexRunOptions,
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
      const base: ImportItemResult<CodexOptionId> = {
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
    items: ImportItemResult<CodexOptionId>[],
    options: CodexRunOptions,
  ): void {
    const content = this.deps.source.readAgentsMd();
    if (content === null) {
      items.push({
        kind: "memory",
        status: "skipped",
        reason: `no AGENTS.md at ${this.deps.source.agentsMdPath()}`,
      });
      return;
    }
    const base: ImportItemResult<CodexOptionId> = {
      kind: "memory",
      source: "AGENTS.md",
      status: "migrated",
    };
    const existing = new Set(
      this.deps.memoryStore
        .list({ scope: "all", limit: 100_000 })
        .map((entry) => entry.content),
    );
    // Longer than the store's cap arrives as several notes, not an error.
    const chunks = splitMemoryNote(content, MEMORY_CONTENT_MAX_LENGTH);
    const missing = chunks.filter((chunk) => !existing.has(chunk));
    if (missing.length === 0) {
      items.push({ ...base, status: "skipped", reason: "already imported" });
      return;
    }
    if (options.execute) {
      try {
        for (const chunk of missing) {
          this.deps.memoryStore.store({
            content: chunk,
            tags: [CODEX_MEMORY_TAG],
            source: "user",
          });
        }
      } catch (err) {
        items.push({ ...base, status: "error", reason: errorMessage(err) });
        return;
      }
    }
    items.push({
      ...base,
      ...(chunks.length > 1
        ? { reason: `split into ${chunks.length} notes` }
        : {}),
    });
  }

  private importSessions(
    items: ImportItemResult<CodexOptionId>[],
    options: CodexRunOptions,
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
          // Meta-only rollout (no conversation): nothing to keep.
          continue;
        }
        mapped = mapCodexSession(session, this.deps.workingDirFallback);
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
    options: CodexRunOptions,
  ): ImportItemResult<CodexOptionId> {
    const base: ImportItemResult<CodexOptionId> = {
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
    items: ImportItemResult<CodexOptionId>[],
    options: CodexRunOptions,
  ): void {
    const authMap = this.deps.source.readAuthKeys(CODEX_SECRET_ALLOWLIST);
    if (authMap.size === 0) {
      items.push({
        kind: "secrets",
        status: "skipped",
        reason:
          "no migratable provider key found in Codex auth.json (ChatGPT logins carry none)",
      });
      return;
    }
    const targetEnvPath = join(this.deps.stateDir, ".env");
    for (const key of CODEX_SECRET_ALLOWLIST) {
      const value = authMap.get(key);
      if (value === undefined) continue;
      const current = readDotenvValue(targetEnvPath, key);
      const base: ImportItemResult<CodexOptionId> = {
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
