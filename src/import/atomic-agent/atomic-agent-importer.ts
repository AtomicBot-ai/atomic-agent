import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import { setDotenvKey } from "../../config/dotenv-writer.js";
import { readLlmBlockOrDefault } from "../../config/llm-provider-commands.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import {
  checkAtomicDesktopSource,
  importAtomicDesktop,
  type AtomicDesktopImportTargets,
} from "../atomic-desktop/atomic-desktop-importer.js";
import { readDotenvValue, stripDotenvQuotes } from "../dotenv-read.js";
import {
  coerceFoldersFile,
  coerceProjectsFile,
  emptyFoldersFile,
  emptyProjectsFile,
  foldersFilePath,
  mergeGroupingFrom,
  outcomeItem,
  projectsFilePath,
  readFoldersFile,
  readProjectsFile,
  writeGroupingFile,
} from "../grouping.js";
import { importSkillDirs } from "../import-skill-dirs.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";

/**
 * "Atomic Agent" as an import source: another Atomic Agent data folder
 * (default `~/.atomic-agent`, when this app runs on a different
 * ATOMIC_AGENT_STATE_DIR, or any folder the person picks), the way a
 * browser imports from another profile. The source is only read: its
 * databases through private snapshots (atomic-desktop-importer.ts), its
 * files with plain reads.
 *
 *  - sessions   chats by id (an id already here stays as it is), with the
 *               projects and chat folders they were in (mergeGroupingFrom).
 *  - memory     notes and profile facts.
 *  - skills     `<source>/skills/<name>/SKILL.md`.
 *  - mcp        `config.json` `mcp.servers`, added by name.
 *  - providers  `config.json` `llm.providers`, added by id; the active
 *               provider here is not changed. Inline keys only with secrets.
 *  - cron       `tasks.sqlite`, scheduled jobs included. Off by default.
 *  - secrets    `<source>/.env` keys missing here. Off by default.
 */
export type AtomicAgentOptionId =
  "sessions" | "memory" | "skills" | "mcp" | "providers" | "cron" | "secrets";

export interface AtomicAgentOptionMeta {
  id: AtomicAgentOptionId;
  label: string;
  description: string;
}

export const ATOMIC_AGENT_IMPORT_OPTIONS: readonly AtomicAgentOptionMeta[] = [
  { id: "sessions", label: "Chats", description: "Your chats, in the projects and folders they were in" },
  { id: "memory", label: "Memory", description: "Notes and facts the agent remembers" },
  { id: "skills", label: "Skills", description: "Your skills" },
  { id: "mcp", label: "Connected tools", description: "MCP servers" },
  { id: "providers", label: "Cloud models", description: "Cloud model providers you set up" },
  { id: "cron", label: "Scheduled jobs", description: "Tasks and cron jobs" },
  { id: "secrets", label: "API keys", description: "API keys, stored only on this computer" },
];

const DEFAULT_OPTIONS: readonly AtomicAgentOptionId[] = ["sessions", "memory", "skills", "mcp", "providers"];

export class AtomicAgentOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicAgentOptionError";
  }
}

/** Default set, `include` / `exclude` applied; `secrets` only through `migrateSecrets`. */
export function resolveAtomicAgentOptions(
  input: { include?: readonly string[]; exclude?: readonly string[]; migrateSecrets?: boolean } = {},
): AtomicAgentOptionId[] {
  const known = new Set<string>(ATOMIC_AGENT_IMPORT_OPTIONS.map((o) => o.id));
  const selected = new Set<string>(DEFAULT_OPTIONS);
  for (const raw of input.include ?? []) {
    const id = raw.trim();
    if (!id) continue;
    if (!known.has(id)) throw new AtomicAgentOptionError(`unknown option in --include: ${id}`);
    if (id === "secrets") {
      throw new AtomicAgentOptionError("secrets cannot be selected via --include; use --migrate-secrets");
    }
    selected.add(id);
  }
  for (const raw of input.exclude ?? []) {
    const id = raw.trim();
    if (!id) continue;
    if (!known.has(id)) throw new AtomicAgentOptionError(`unknown option in --exclude: ${id}`);
    selected.delete(id);
  }
  if (input.migrateSecrets) selected.add("secrets");
  else selected.delete("secrets");
  return ATOMIC_AGENT_IMPORT_OPTIONS.map((o) => o.id).filter((id) => selected.has(id));
}

export interface AtomicAgentImporterDeps {
  sourceDir: string;
  /** This app's state dir; refused as a source. */
  stateDir: string;
  userConfigFile: string;
  globalSkillsDir: string;
  targets: AtomicDesktopImportTargets;
}

export interface AtomicAgentRunOptions {
  options: readonly AtomicAgentOptionId[];
  execute: boolean;
  overwrite: boolean;
}

export class AtomicAgentImporter {
  constructor(private readonly deps: AtomicAgentImporterDeps) {}

  async run(options: AtomicAgentRunOptions): Promise<ImportReport<string>> {
    const items: ImportItemResult<string>[] = [];
    const selected = new Set(options.options);
    const problem = checkAtomicDesktopSource(this.deps.sourceDir, this.deps.stateDir);
    if (problem !== null) {
      items.push({ kind: "sessions", status: "error", reason: problem });
      return buildReport(items, options.execute);
    }
    if (selected.has("sessions") || selected.has("memory") || selected.has("cron")) {
      await this.importDatabases(items, selected, options);
    }
    if (selected.has("skills")) {
      const root = join(this.deps.sourceDir, "skills");
      await importSkillDirs<string>({
        kind: "skills",
        skills: listSkillDirs(root),
        skillsDir: root,
        globalSkillsDir: this.deps.globalSkillsDir,
        execute: options.execute,
        overwrite: options.overwrite,
        items,
      });
    }
    if (selected.has("mcp") || selected.has("providers")) {
      this.importConfig(items, selected, options);
    }
    if (selected.has("secrets")) this.importSecrets(items, options);
    return buildReport(items, options.execute);
  }

  private async importDatabases(
    items: ImportItemResult<string>[],
    selected: ReadonlySet<AtomicAgentOptionId>,
    options: AtomicAgentRunOptions,
  ): Promise<void> {
    const sessionIds = new Set<string>();
    const result = await importAtomicDesktop({
      sourceDir: this.deps.sourceDir,
      targetStateDir: this.deps.stateDir,
      targets: this.deps.targets,
      parts: {
        sessions: selected.has("sessions"),
        tasks: selected.has("cron"),
        memory: selected.has("memory"),
      },
      dryRun: !options.execute,
      onItem: (part, id, imported) => {
        if (part === "sessions") sessionIds.add(id);
        items.push({
          kind: part === "sessions" ? "sessions" : "cron",
          source: id,
          destination: id,
          status: imported ? "migrated" : "skipped",
          ...(imported ? {} : { reason: "already here" }),
        });
      },
    });
    if (selected.has("memory")) {
      const n = result.notes;
      const f = result.profileFacts;
      items.push({
        kind: "memory",
        source: `${n.imported + n.skipped} notes, ${f.imported + f.skipped} facts`,
        status: n.imported + f.imported > 0 ? "migrated" : "skipped",
        reason: `${n.imported} notes and ${f.imported} facts new here`,
      });
    }
    for (const error of result.errors) items.push({ kind: "sessions", status: "error", reason: error });
    if (selected.has("sessions") && sessionIds.size > 0) {
      this.importGrouping(items, sessionIds, options);
    }
  }

  /** The source's projects and folders, as they were (grouping.ts mergeGroupingFrom). */
  private importGrouping(
    items: ImportItemResult<string>[],
    sessionIds: ReadonlySet<string>,
    options: AtomicAgentRunOptions,
  ): void {
    try {
      const plan = mergeGroupingFrom({
        source: {
          projects: readSourceJson(projectsFilePath(this.deps.sourceDir), coerceProjectsFile, emptyProjectsFile),
          folders: readSourceJson(foldersFilePath(this.deps.sourceDir), coerceFoldersFile, emptyFoldersFile),
        },
        target: {
          projects: readProjectsFile(this.deps.stateDir),
          folders: readFoldersFile(this.deps.stateDir),
        },
        sessionIds,
      });
      let writeError: string | null = null;
      if (options.execute) {
        try {
          if (plan.projectsChanged) writeGroupingFile(projectsFilePath(this.deps.stateDir), plan.projects);
          if (plan.foldersChanged) writeGroupingFile(foldersFilePath(this.deps.stateDir), plan.folders);
        } catch (err) {
          writeError = errorMessage(err);
        }
      }
      for (const o of plan.outcomes) items.push(outcomeItem(o, writeError));
    } catch (err) {
      items.push({ kind: "folders", status: "error", reason: errorMessage(err) });
    }
  }

  private importConfig(
    items: ImportItemResult<string>[],
    selected: ReadonlySet<AtomicAgentOptionId>,
    options: AtomicAgentRunOptions,
  ): void {
    const sourcePath = join(this.deps.sourceDir, "config.json");
    let raw: Record<string, unknown> = {};
    if (existsSync(sourcePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        }
      } catch (err) {
        items.push({ kind: "mcp", status: "error", reason: `cannot parse ${sourcePath}: ${errorMessage(err)}` });
        return;
      }
    }
    const prev = ensureUserConfigFileSync(this.deps.userConfigFile);
    const servers: McpServerConfig[] = [];
    const providers: Array<Record<string, unknown>> = [];
    const mine: ImportItemResult<string>[] = [];

    if (selected.has("mcp")) {
      const list = objectAt(raw, "mcp")?.servers;
      const have = new Set(prev.mcp.servers.map((s) => s.name));
      const entries = Array.isArray(list) ? list : [];
      if (entries.length === 0) {
        items.push({ kind: "mcp", status: "skipped", reason: `no MCP servers in ${sourcePath}` });
      }
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const name = (entry as { name?: unknown }).name;
        if (typeof name !== "string" || !name) continue;
        if (have.has(name)) {
          items.push({ kind: "mcp", source: name, destination: name, status: "skipped", reason: "already set up here" });
          continue;
        }
        have.add(name);
        servers.push(entry as McpServerConfig);
        mine.push({ kind: "mcp", source: name, destination: name, status: "migrated" });
      }
    }
    if (selected.has("providers")) {
      const list = objectAt(raw, "llm")?.providers;
      // A config with no `llm` block still has the built-in `local-llama`.
      const have = new Set(readLlmBlockOrDefault(prev).providers.map((p) => p.id));
      const entries = Array.isArray(list) ? list : [];
      if (entries.length === 0) {
        items.push({ kind: "providers", status: "skipped", reason: `no cloud providers in ${sourcePath}` });
      }
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const p = { ...(entry as Record<string, unknown>) };
        const id = p.id;
        if (typeof id !== "string" || !id) continue;
        if (have.has(id)) {
          items.push({ kind: "providers", source: id, destination: id, status: "skipped", reason: "already set up here" });
          continue;
        }
        have.add(id);
        // A key saved inline in the source's config is a secret: only with the secrets option.
        // So is a key sent as a header (`Authorization`, the entry's `apiKeyHeader`).
        let keyless = false;
        if (!selected.has("secrets")) {
          if ("apiKey" in p) {
            delete p.apiKey;
            keyless = true;
          }
          const headers = objectAt(p, "headers");
          if (headers) {
            const keyHeader = typeof p.apiKeyHeader === "string" ? p.apiKeyHeader.toLowerCase() : "";
            const kept: Record<string, unknown> = {};
            for (const [name, value] of Object.entries(headers)) {
              if (name.toLowerCase() === keyHeader || SECRET_HEADER_RE.test(name)) keyless = true;
              else kept[name] = value;
            }
            if (Object.keys(kept).length > 0) p.headers = kept;
            else delete p.headers;
          }
        }
        providers.push(p);
        mine.push({
          kind: "providers",
          source: id,
          destination: id,
          status: "migrated",
          ...(keyless ? { reason: "without its API key (secrets off)" } : {}),
        });
      }
    }
    items.push(...mine);
    if (!options.execute || (servers.length === 0 && providers.length === 0)) return;
    try {
      const next: Record<string, unknown> = { ...prev };
      if (servers.length > 0) next.mcp = { ...prev.mcp, servers: [...prev.mcp.servers, ...servers] };
      if (providers.length > 0) {
        // A fresh config has no `llm` block: start from the implicit one, or the
        // added providers would replace `local-llama`, which the default
        // `activeTextProvider` names, and the whole write would be refused.
        const llm = readLlmBlockOrDefault(prev);
        next.llm = { ...llm, providers: [...llm.providers, ...providers] };
      }
      const validated = parseUserConfigFile(next);
      writeUserConfigFileSync(this.deps.userConfigFile, validated);
      resetConfigCache();
    } catch (err) {
      const reason = err instanceof ConfigValidationError ? `${err.field}: ${err.message}` : errorMessage(err);
      for (const item of mine) {
        item.status = "error";
        item.reason = `config write failed: ${reason}`;
      }
    }
  }

  private importSecrets(items: ImportItemResult<string>[], options: AtomicAgentRunOptions): void {
    const sourceEnv = join(this.deps.sourceDir, ".env");
    const keys = listDotenvKeys(sourceEnv);
    if (keys.length === 0) {
      items.push({ kind: "secrets", status: "skipped", reason: `no keys in ${sourceEnv}` });
      return;
    }
    const targetEnv = join(this.deps.stateDir, ".env");
    for (const key of keys) {
      const value = readDotenvValue(sourceEnv, key);
      if (value === undefined || value === "") continue;
      const current = readDotenvValue(targetEnv, key);
      const base: ImportItemResult<string> = { kind: "secrets", source: key, destination: key, status: "migrated" };
      if (current === value) {
        items.push({ ...base, status: "skipped", reason: "already set" });
        continue;
      }
      if (current !== undefined && !options.overwrite) {
        items.push({ ...base, status: "conflict", reason: "key exists with a different value; use --overwrite" });
        continue;
      }
      try {
        if (options.execute) setDotenvKey(this.deps.stateDir, key, value);
      } catch (err) {
        items.push({ ...base, status: "error", reason: errorMessage(err) });
        continue;
      }
      items.push({ ...base, ...(current !== undefined ? { reason: "overwritten" } : {}) });
    }
  }
}

function listSkillDirs(root: string): Array<{ name: string; dir: string }> {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }
  return entries
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .map((name) => ({ name, dir: join(root, name) }));
}

/** The variable names in a dotenv file, in file order. */
export function listDotenvKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  const keys: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && stripDotenvQuotes(trimmed.slice(eq + 1).trim()) && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function readSourceJson<T>(path: string, coerce: (raw: unknown) => T, empty: () => T): T {
  if (!existsSync(path)) return empty();
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // The source's broken file is its own business: nothing comes over from it.
    return empty();
  }
}

/** Header names that carry a credential (`Authorization`, `x-api-key`, `X-Auth-Token`, …). */
const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|password|cookie/i;

function objectAt(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = raw[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
