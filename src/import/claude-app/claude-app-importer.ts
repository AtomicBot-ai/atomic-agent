import { MEMORY_CONTENT_MAX_LENGTH } from "../../memory/index.js";
import type { SessionStore } from "../../session/index.js";
import type { ImportMemoryTarget } from "../claude-code/claude-code-importer.js";
import { namedGroupHint, withGroupHint, type ImportGroupHint } from "../grouping.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import {
  reconcileImportedSession,
  type ReconcileImportedSessionResult,
} from "../reconcile-session.js";
import { splitMemoryNote } from "../split-note.js";
import type {
  ClaudeAppExport,
  ClaudeAppProject,
  ClaudeAppSource,
} from "./claude-app-source.js";
import { mapClaudeAppConversation } from "./map-session.js";

/** Tag stamped on every imported memory note. */
export const CLAUDE_APP_MEMORY_TAG = "imported:claude-app";

export type ClaudeAppOptionId = "sessions" | "memory";

export interface ClaudeAppOptionMeta {
  id: ClaudeAppOptionId;
  label: string;
  description: string;
}

export const CLAUDE_APP_IMPORT_OPTIONS: readonly ClaudeAppOptionMeta[] = [
  {
    id: "sessions",
    label: "Chats",
    description: "Your conversations, kept in their projects",
  },
  {
    id: "memory",
    label: "Project instructions",
    description: "Each project's instructions and files, as notes the agent remembers",
  },
];

export class ClaudeAppOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAppOptionError";
  }
}

/** Both options by default; `exclude` removes, unknown ids are refused. */
export function resolveClaudeAppOptions(
  input: { include?: readonly string[]; exclude?: readonly string[] } = {},
): ClaudeAppOptionId[] {
  const known = new Set(CLAUDE_APP_IMPORT_OPTIONS.map((o) => o.id as string));
  const selected = new Set<string>(known);
  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (!id) continue;
    if (!known.has(id)) throw new ClaudeAppOptionError(`unknown option in --include: ${id}`);
    selected.add(id);
  }
  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (!id) continue;
    if (!known.has(id)) throw new ClaudeAppOptionError(`unknown option in --exclude: ${id}`);
    selected.delete(id);
  }
  return CLAUDE_APP_IMPORT_OPTIONS.map((o) => o.id).filter((id) => selected.has(id));
}

export interface ClaudeAppImporterDeps {
  source: ClaudeAppSource;
  sessionStore: SessionStore;
  memoryStore: ImportMemoryTarget;
  /** The Claude app has no working folder; imported chats open here. */
  workingDir: string;
}

export interface ClaudeAppRunOptions {
  options: readonly ClaudeAppOptionId[];
  execute: boolean;
  overwrite: boolean;
  /** Cap on conversations processed, newest first. */
  limit?: number;
}

/** The group key a Claude app project is kept under (grouping.ts). */
export function claudeAppProjectKey(uuid: string): string {
  return `claude-app:project:${uuid}`;
}

/**
 * Claude app export → Atomic Agent. Conversations become chats (same
 * re-import rule as every importer, reconcile-session.ts). A project
 * comes in as a chat Folder of its name (a Claude project is not a folder
 * on disk, so it cannot be a desktop Project): its chats go into it when
 * the export says which they are, and its instructions and files become
 * memory notes, since a chat folder carries no instructions of its own.
 */
export class ClaudeAppImporter {
  constructor(private readonly deps: ClaudeAppImporterDeps) {}

  async run(options: ClaudeAppRunOptions): Promise<ImportReport<string>> {
    const items: ImportItemResult<string>[] = [];
    const selected = new Set(options.options);
    let data: ClaudeAppExport;
    try {
      data = await this.deps.source.load();
    } catch (err) {
      items.push({ kind: "sessions", status: "error", reason: errorMessage(err) });
      return buildReport(items, options.execute);
    }
    const hints: ImportGroupHint[] = [];
    const byUuid = new Map(data.projects.map((p) => [p.uuid, p]));
    for (const p of data.projects) {
      const hint = namedGroupHint(claudeAppProjectKey(p.uuid), p.name);
      if (hint) hints.push(hint);
    }
    if (selected.has("sessions")) {
      this.importConversations(items, data, byUuid, options);
      if (data.projects.length > 0 && !data.linksProjects) {
        items.push({
          kind: "folders",
          status: "skipped",
          reason:
            "this Claude export does not say which project each chat was in: the projects come in as folders, the chats stay outside them",
        });
      }
    }
    if (selected.has("memory")) this.importProjectNotes(items, data.projects, options);
    const report = buildReport(items, options.execute);
    return selected.has("sessions") && hints.length > 0
      ? { ...report, groupHints: hints }
      : report;
  }

  private importConversations(
    items: ImportItemResult<string>[],
    data: ClaudeAppExport,
    projects: Map<string, ClaudeAppProject>,
    options: ClaudeAppRunOptions,
  ): void {
    let list = [...data.conversations].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || (a.uuid < b.uuid ? -1 : 1),
    );
    if (list.length === 0) {
      items.push({ kind: "sessions", status: "skipped", reason: "no conversations in the export" });
      return;
    }
    if (options.limit !== undefined && options.limit >= 0) list = list.slice(0, options.limit);
    for (const c of list) {
      const mapped = mapClaudeAppConversation(c, this.deps.workingDir);
      if (mapped.turns.length === 0) {
        items.push({ kind: "sessions", source: c.uuid, status: "skipped", reason: "no messages" });
        continue;
      }
      const base: ImportItemResult<string> = {
        kind: "sessions",
        source: c.uuid,
        destination: mapped.id,
        status: "migrated",
      };
      let outcome: ReconcileImportedSessionResult;
      try {
        outcome = reconcileImportedSession({
          existing: this.deps.sessionStore.load(mapped.id),
          mapped,
          execute: options.execute,
          overwrite: options.overwrite,
          save: (state) => this.deps.sessionStore.save(state),
        });
      } catch (err) {
        items.push({ ...base, status: "error", reason: errorMessage(err) });
        continue;
      }
      const project = c.projectUuid !== null ? projects.get(c.projectUuid) : undefined;
      const hint =
        c.projectUuid !== null
          ? namedGroupHint(
              claudeAppProjectKey(c.projectUuid),
              project?.name ?? c.projectName ?? "Claude project",
            )
          : undefined;
      items.push(
        withGroupHint(
          {
            ...base,
            status: outcome.status,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          },
          hint,
        ),
      );
    }
  }

  private importProjectNotes(
    items: ImportItemResult<string>[],
    projects: readonly ClaudeAppProject[],
    options: ClaudeAppRunOptions,
  ): void {
    const notes: Array<{ source: string; content: string }> = [];
    for (const p of projects) {
      const head = `Claude project "${p.name}"`;
      const about = [p.description.trim(), p.promptTemplate.trim()].filter(Boolean);
      if (about.length > 0) {
        notes.push({
          source: `${p.name}: instructions`,
          content: `${head} instructions:\n\n${about.join("\n\n")}`,
        });
      }
      for (const doc of p.docs) {
        notes.push({
          source: `${p.name}: ${doc.filename}`,
          content: `${head} file ${doc.filename}:\n\n${doc.content.trim()}`,
        });
      }
    }
    if (notes.length === 0) {
      items.push({ kind: "memory", status: "skipped", reason: "no project instructions or files in the export" });
      return;
    }
    const existing = new Set(
      this.deps.memoryStore.list({ scope: "all", limit: 100_000 }).map((n) => n.content),
    );
    for (const note of notes) {
      const base: ImportItemResult<string> = { kind: "memory", source: note.source, status: "migrated" };
      const chunks = splitMemoryNote(note.content, MEMORY_CONTENT_MAX_LENGTH);
      const missing = chunks.filter((chunk) => !existing.has(chunk));
      if (missing.length === 0) {
        items.push({ ...base, status: "skipped", reason: "already imported" });
        continue;
      }
      if (options.execute) {
        try {
          for (const chunk of missing) {
            this.deps.memoryStore.store({ content: chunk, tags: [CLAUDE_APP_MEMORY_TAG], source: "user" });
            existing.add(chunk);
          }
        } catch (err) {
          items.push({ ...base, status: "error", reason: errorMessage(err) });
          continue;
        }
      }
      items.push({ ...base, ...(chunks.length > 1 ? { reason: `split into ${chunks.length} notes` } : {}) });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
