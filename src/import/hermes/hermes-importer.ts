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
import { TaskStore } from "../../tasks/index.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { groupHintFromCwd, withGroupHint } from "../grouping.js";
import { reconcileImportedSession } from "../reconcile-session.js";
import {
  buildHermesPluginMcpServer,
  discoverHermesPlugins,
  hermesPluginsDir,
  hermesShimInstallPath,
  installHermesShim,
  isTrustedPlugin,
} from "./hermes-plugins.js";
import type { HermesSource } from "./hermes-source.js";
import type { ImportOptionId } from "./import-options.js";
import { mapHermesCronJob } from "./map-cron.js";
import { mapHermesSession } from "./map-session.js";
import { SECRET_ALLOWLIST, selectSecrets } from "./map-secrets.js";

export interface HermesImporterDeps {
  source: HermesSource;
  sessionStore: SessionStore;
  taskStore: TaskStore;
  /** State dir whose `.env` receives migrated provider keys. */
  stateDir: string;
  /** Retry budget for created tasks (config.tasks.maxAttempts). */
  maxAttempts: number;
  /** Working dir applied to sessions whose Hermes `cwd` is null. */
  workingDirFallback: string;
  /** Injectable clock for deterministic past-detection. */
  now?: () => number;
  /**
   * `plugins` option (ATO-953): Hermes home holding `plugins/`, the config
   * file that receives the bridged MCP entries, and the plugins the user
   * trusted by key or manifest name. Untrusted plugins are only reported.
   */
  sourceDir?: string;
  userConfigFile?: string;
  trustedPlugins?: readonly string[];
  /** Python interpreter for the bridge (default python3 / python). */
  pythonCommand?: string;
  /** Copies the shim into the state dir; injectable for tests. */
  installShim?: (stateDir: string) => string;
}

export interface ImportRunOptions {
  /** Resolved option set (already gated by `resolveSelectedOptions`). */
  options: readonly ImportOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed (newest first). */
  limit?: number;
}

/**
 * Orchestrates a one-shot Hermes -> atomic-agent import. Each option is
 * processed independently and contributes `ImportItemResult`s to a single
 * `ImportReport`. Safe to re-run: unchanged destinations skip on match,
 * differing ones require `overwrite`.
 */
export class HermesImporter {
  constructor(private readonly deps: HermesImporterDeps) {}

  run(options: ImportRunOptions): ImportReport<ImportOptionId> {
    const items: ImportItemResult<ImportOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("sessions")) {
      this.importSessions(items, options);
    }
    if (selected.has("cron")) {
      this.importCron(items, options);
    }
    if (selected.has("secrets")) {
      this.importSecrets(items, options);
    }
    if (selected.has("plugins")) {
      this.importPlugins(items, options);
    }

    return buildReport(items, options.execute);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private importSessions(
    items: ImportItemResult<ImportOptionId>[],
    options: ImportRunOptions,
  ): void {
    if (!this.deps.source.hasStateDb()) {
      items.push({
        kind: "sessions",
        status: "skipped",
        reason: `no state.db at ${this.deps.source.stateDbPath()}`,
      });
      return;
    }
    let sessions = this.deps.source.readSessions();
    if (options.limit !== undefined && options.limit >= 0) {
      sessions = sessions.slice(0, options.limit);
    }
    for (const session of sessions) {
      const messages = this.deps.source.readMessages(session.id);
      if (messages.length === 0) {
        items.push({
          kind: "sessions",
          source: session.id,
          status: "skipped",
          reason: "no messages",
        });
        continue;
      }
      const mapped = mapHermesSession(
        session,
        messages,
        this.deps.workingDirFallback,
      );
      items.push(
        withGroupHint(
          this.reconcileSession(mapped, session.id, options),
          groupHintFromCwd(session.cwd),
        ),
      );
    }
  }

  private reconcileSession(
    mapped: SessionState,
    hermesId: string,
    options: ImportRunOptions,
  ): ImportItemResult<ImportOptionId> {
    const base: ImportItemResult<ImportOptionId> = {
      kind: "sessions",
      source: hermesId,
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
    return {
      ...base,
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  }

  private importCron(
    items: ImportItemResult<ImportOptionId>[],
    options: ImportRunOptions,
  ): void {
    if (!this.deps.source.hasCronJobs()) {
      items.push({
        kind: "cron",
        status: "skipped",
        reason: `no cron/jobs.json at ${this.deps.source.cronJobsPath()}`,
      });
      return;
    }
    const jobs = this.deps.source.readCronJobs();
    const existingTasks = this.deps.taskStore.list({ limit: 10_000 });
    const now = this.now();

    for (const job of jobs) {
      const result = mapHermesCronJob(job, {
        maxAttempts: this.deps.maxAttempts,
        now,
      });
      if (result.kind === "skip") {
        items.push({
          kind: "cron",
          source: job.id,
          status: "skipped",
          reason: result.reason,
        });
        continue;
      }
      const duplicate = existingTasks.some(
        (task) =>
          task.userMessage === result.input.userMessage &&
          task.schedule?.kind === result.input.schedule?.kind,
      );
      if (duplicate && !options.overwrite) {
        items.push({
          kind: "cron",
          source: job.id,
          status: "skipped",
          reason: "task already exists",
        });
        continue;
      }
      let destination: string | undefined;
      if (options.execute) {
        const created = this.deps.taskStore.create(result.input, now);
        destination = created.id;
      }
      items.push({
        kind: "cron",
        source: job.id,
        ...(destination !== undefined ? { destination } : {}),
        status: "migrated",
        ...(duplicate ? { reason: "duplicate re-created (overwrite)" } : {}),
      });
    }
  }

  private importSecrets(
    items: ImportItemResult<ImportOptionId>[],
    options: ImportRunOptions,
  ): void {
    const envMap = this.deps.source.readEnvKeys(SECRET_ALLOWLIST);
    const secrets = selectSecrets(envMap);
    if (secrets.length === 0) {
      items.push({
        kind: "secrets",
        status: "skipped",
        reason: "no migratable provider key found in Hermes .env",
      });
      return;
    }
    const targetEnvPath = join(this.deps.stateDir, ".env");
    for (const secret of secrets) {
      const current = readDotenvValue(targetEnvPath, secret.key);
      const base: ImportItemResult<ImportOptionId> = {
        kind: "secrets",
        source: secret.key,
        destination: secret.key,
        status: "migrated",
      };
      if (current === undefined) {
        if (options.execute) {
          setDotenvKey(this.deps.stateDir, secret.key, secret.value);
        }
        items.push(base);
        continue;
      }
      if (current === secret.value) {
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
      if (options.execute) {
        setDotenvKey(this.deps.stateDir, secret.key, secret.value);
      }
      items.push({ ...base, reason: "overwritten" });
    }
  }

  /**
   * Register each trusted Hermes Python plugin as a stdio MCP server that
   * runs the bundled shim. Name collisions never overwrite (same rule as
   * the Claude Code MCP import); one config write for the whole batch.
   */
  private importPlugins(
    items: ImportItemResult<ImportOptionId>[],
    options: ImportRunOptions,
  ): void {
    const { sourceDir, userConfigFile } = this.deps;
    const trusted = (this.deps.trustedPlugins ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (!sourceDir || !userConfigFile) {
      items.push({
        kind: "plugins",
        status: "error",
        reason: "plugin bridge not configured for this import",
      });
      return;
    }
    const plugins = discoverHermesPlugins(sourceDir);
    for (const name of trusted) {
      if (!plugins.some((p) => isTrustedPlugin(p, [name]))) {
        items.push({
          kind: "plugins",
          source: name,
          status: "skipped",
          reason: `no Python plugin named ${JSON.stringify(name)} in ${hermesPluginsDir(sourceDir)}`,
        });
      }
    }
    if (plugins.length === 0) {
      items.push({
        kind: "plugins",
        status: "skipped",
        reason: `no Python plugins in ${hermesPluginsDir(sourceDir)}`,
      });
      return;
    }

    const prev = ensureUserConfigFileSync(userConfigFile);
    const existingNames = new Set(prev.mcp.servers.map((s) => s.name));
    const shimPath = hermesShimInstallPath(this.deps.stateDir);
    const toAppend: McpServerConfig[] = [];
    for (const plugin of plugins) {
      const base: ImportItemResult<ImportOptionId> = {
        kind: "plugins",
        source: plugin.key,
        status: "migrated",
      };
      if (!isTrustedPlugin(plugin, trusted)) {
        items.push({
          ...base,
          status: "skipped",
          reason: `not trusted; runs local Python, re-run with --trust-plugin ${plugin.key}`,
        });
        continue;
      }
      const built = buildHermesPluginMcpServer(plugin, {
        shimPath,
        hermesHome: sourceDir,
        ...(this.deps.pythonCommand
          ? { pythonCommand: this.deps.pythonCommand }
          : {}),
      });
      if (built.kind === "skip") {
        items.push({ ...base, status: "skipped", reason: built.reason });
        continue;
      }
      const destination = built.server.name;
      if (
        existingNames.has(destination) ||
        toAppend.some((s) => s.name === destination)
      ) {
        items.push({
          ...base,
          destination,
          status: "skipped",
          reason: "server with this name already configured",
        });
        continue;
      }
      toAppend.push(built.server);
      items.push({ ...base, destination });
    }
    if (!options.execute || toAppend.length === 0) return;
    try {
      (this.deps.installShim ?? installHermesShim)(this.deps.stateDir);
      const nextMcp = {
        ...prev.mcp,
        servers: [...prev.mcp.servers, ...toAppend],
      };
      const validated = parseUserConfigFile({ ...prev, mcp: nextMcp });
      writeUserConfigFileSync(userConfigFile, validated);
      resetConfigCache();
    } catch (err) {
      const reason =
        err instanceof ConfigValidationError
          ? `${err.field}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      for (const item of items) {
        if (item.kind === "plugins" && item.status === "migrated") {
          item.status = "error";
          item.reason = `plugin bridge setup failed: ${reason}`;
        }
      }
    }
  }
}

/**
 * Read a single key's value from a dotenv file without mutating it.
 * Mirrors the `loadDotenvFromStateDir` parse (trim, strip one surrounding
 * quote pair, ignore comments). Returns `undefined` when absent.
 */
function readDotenvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return stripQuotes(trimmed.slice(eq + 1).trim());
  }
  return undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
