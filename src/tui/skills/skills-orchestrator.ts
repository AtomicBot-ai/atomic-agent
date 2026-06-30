import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../../config/index.js";
import {
  browseClawHub,
  browseHub,
  ClawHubClient,
  commitStagedInstall,
  discardStagedInstall,
  filterHubEntries,
  GithubSkillClient,
  listStarterSkillNames,
  parseClawHubIdentifier,
  searchClawHub,
  stageSkill,
  uninstallSkill,
  type HubSkillEntry,
  type SkillSourceKind,
  type SkillTap,
  type StagedSkillInstall,
} from "../../skills/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import type { HubSkillRow } from "./skills-panel-state.js";
import { toSkillSummaryRows } from "./skills-summary.js";

export interface SkillsOrchestratorOptions {
  /** Refresh cadence for the skills list. Defaults to 5_000 ms. */
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;

/**
 * Bridge between the Skills tab state slice and `runtime.skillRegistry`
 * + the user `config.json` denylist. The reducer never touches either
 * directly; every side-effecting operation enters here first and emits
 * actions on the bus so the reducer (and therefore the UI) stays
 * consistent.
 *
 * Responsibilities:
 *
 *  - Periodic refresh of `state.skillsPanel.rows` from
 *    `SkillRegistry.listAll()` (auto-refresh loop, opt-in by tab entry).
 *  - Loading the SKILL.md body for the detail view via
 *    `SkillRegistry.readBody`. Disabled skills cannot read body via the
 *    filtered `get()` path, so `openDetail` re-resolves the manifest
 *    path through `listAll()` instead.
 *  - Toggling skills on/off: write the new `skills.disabled` array into
 *    `config.json`, hot-apply it to `SkillRegistry` via
 *    `setDisabledNames`, and call `runtime.refreshSkills()` so the
 *    catalog/stable-prefix subscribers update.
 */
export class SkillsOrchestrator {
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;
  /** Staged hub installs awaiting confirmation, keyed by identifier. */
  private readonly staged = new Map<string, StagedSkillInstall>();
  /**
   * Cached GitHub-tap catalog for the session. Populated on the first
   * browse and reused by every subsequent search so typing a query
   * filters locally (zero GitHub API calls). Cleared by an explicit
   * refresh (`r`). This is the primary guard against GitHub's
   * 60-req/hour unauthenticated rate limit. ClawHub (the primary source)
   * has generous limits and is queried live on every browse/search.
   */
  private githubCatalog: {
    entries: HubSkillEntry[];
    errors: Array<{ repo: string; error: string }>;
  } | null = null;
  /** Memoised ClawHub client, rebuilt when the configured apiBase changes. */
  private clawHub: { client: ClawHubClient; apiBase: string } | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    options: SkillsOrchestratorOptions = {},
  ) {
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /** Start the periodic refresh loop. Idempotent. */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refresh();
    this.refreshTimer = setInterval(
      () => this.refresh(),
      this.refreshIntervalMs,
    );
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Drop any temp dirs from staged-but-uncommitted installs.
    for (const staged of this.staged.values()) {
      void discardStagedInstall(staged);
    }
    this.staged.clear();
    this.githubCatalog = null;
    this.clawHub = null;
  }

  /** One-off refresh — dispatched on keypress `r` and after mutations. */
  refresh(): void {
    try {
      this.bus.emit({ type: "skills_refresh_started" });
      const rows = toSkillSummaryRows(this.runtime.skillRegistry.listAll());
      this.bus.emit({ type: "skills_refreshed", rows, at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "skills_refresh_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `skills refresh failed: ${msg}`,
      });
    }
  }

  /**
   * Open the detail view for `name`. Reads the manifest body even for
   * disabled skills — the filtered `get()` path would throw, so we go
   * through `listAll()` and `readFile` directly.
   */
  async openDetail(name: string): Promise<void> {
    try {
      const all = this.runtime.skillRegistry.listAll();
      const entry = all.find((e) => e.record.manifest.name === name);
      if (!entry) {
        this.bus.emit({
          type: "runtime_info",
          line: `skill ${name} not found`,
        });
        return;
      }
      const body = await readManifestBody(entry.record.manifestPath);
      this.bus.emit({ type: "skills_detail_opened", name, body });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "runtime_info",
        line: `failed to open ${name}: ${msg}`,
      });
    }
  }

  /** Disable `name` if currently enabled, enable it otherwise. */
  async toggleSkill(name: string): Promise<void> {
    const isDisabled = this.runtime.skillRegistry.isDisabled(name);
    await this.setSkillDisabled(name, !isDisabled);
  }

  /**
   * Persist the `disabled` flag for `name` to `config.json`, hot-apply
   * it to the registry, and trigger `runtime.refreshSkills` so the
   * stable prefix subscribers rebuild.
   */
  async setSkillDisabled(name: string, disabled: boolean): Promise<void> {
    try {
      const path = this.runtime.config.paths.userConfigFile;
      const file = ensureUserConfigFileSync(path);
      const current = new Set(file.skills.disabled);
      const wasDisabled = current.has(name);
      if (disabled && wasDisabled) return;
      if (!disabled && !wasDisabled) return;
      if (disabled) current.add(name);
      else current.delete(name);
      const nextDisabled = Array.from(current).sort();
      const updated: UserConfigFile = {
        ...file,
        skills: { ...file.skills, disabled: nextDisabled },
      };
      writeUserConfigFileSync(path, updated);
      resetConfigCache();
      this.runtime.skillRegistry.setDisabledNames(nextDisabled);
      this.bus.emit({ type: "skills_toggle_settled", name, disabled });
      this.bus.emit({
        type: "runtime_info",
        line: disabled ? `skill disabled: ${name}` : `skill enabled: ${name}`,
      });
      // Rebuild the catalog + stable prefix consumers so the LLM no
      // longer sees the disabled skill (or starts seeing it again).
      await this.runtime.refreshSkills();
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "skills_error_set", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `toggle ${name} failed: ${msg}`,
      });
    }
  }

  /**
   * Open the uninstall confirmation for `name`. Removal is scoped to the
   * global skills dir (project-local skills are managed in the repo), so
   * a project-only skill is rejected with a hint instead of opening the
   * modal. Flags bundled starters so the modal can warn that they re-seed
   * on the next boot.
   */
  async requestRemove(name: string): Promise<void> {
    const entry = this.runtime.skillRegistry
      .listAll()
      .find((e) => e.record.manifest.name === name);
    if (!entry) {
      this.bus.emit({ type: "runtime_info", line: `skill ${name} not found` });
      return;
    }
    if (entry.record.source !== "global") {
      this.bus.emit({
        type: "runtime_info",
        line: `${name} is a project-local skill — remove it from .atomic-agent/skills instead`,
      });
      return;
    }
    let isStarter = false;
    try {
      isStarter = (await listStarterSkillNames()).has(name);
    } catch {
      // Treat an unresolved starter tree as "not a starter" — the warning
      // is advisory, never load-bearing.
    }
    this.bus.emit({
      type: "skills_remove_confirm_opened",
      confirm: {
        name,
        source: entry.record.source,
        isStarter,
        submitting: false,
        error: null,
      },
    });
  }

  /**
   * Delete the global skill directory for `name`, drop any stale entry
   * from `skills.disabled`, then rebuild the registry + stable-prefix
   * consumers. On failure the modal stays open with the error so the
   * operator can retry or cancel.
   */
  async confirmRemove(name: string): Promise<void> {
    this.bus.emit({ type: "skills_remove_submitting" });
    try {
      const globalDir = this.runtime.config.paths.globalSkillsDir;
      const result = await uninstallSkill(globalDir, name);
      if (!result.removed) {
        this.bus.emit({
          type: "skills_remove_failed",
          error: `not installed globally: ${name}`,
        });
        return;
      }
      this.pruneDisabledEntry(name);
      this.bus.emit({ type: "skills_remove_confirm_closed" });
      this.bus.emit({ type: "runtime_info", line: `skill removed: ${name}` });
      await this.runtime.refreshSkills();
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "skills_remove_failed", error: msg });
    }
  }

  /**
   * Remove `name` from `config.json` `skills.disabled` (if present) and
   * hot-apply the new denylist to the registry. A no-op when the skill
   * was not disabled. Keeps the config from accumulating dangling entries
   * for skills that no longer exist on disk.
   */
  private pruneDisabledEntry(name: string): void {
    const path = this.runtime.config.paths.userConfigFile;
    const file = ensureUserConfigFileSync(path);
    if (!file.skills.disabled.includes(name)) return;
    const nextDisabled = file.skills.disabled.filter((n) => n !== name);
    const updated: UserConfigFile = {
      ...file,
      skills: { ...file.skills, disabled: nextDisabled },
    };
    writeUserConfigFileSync(path, updated);
    resetConfigCache();
    this.runtime.skillRegistry.setDisabledNames(nextDisabled);
  }

  /** Open the hub view and browse the configured taps (uses the cache). */
  async openHub(): Promise<void> {
    this.bus.emit({ type: "skills_hub_opened" });
    await this.runBrowse(null, { force: false });
  }

  /** Re-browse the configured taps from GitHub, bypassing the cache. */
  async refreshHub(): Promise<void> {
    await this.runBrowse(null, { force: true });
  }

  /**
   * Search the configured taps for `query`. Filters the cached catalog
   * locally — only the first load (or an explicit refresh) hits GitHub.
   */
  async searchHub(query: string): Promise<void> {
    this.bus.emit({ type: "skills_hub_opened" });
    if (query.length > 0) {
      this.bus.emit({ type: "skills_hub_query_changed", query });
    }
    await this.runBrowse(query, { force: false });
  }

  /**
   * Browse/search both sources and merge. ClawHub (the primary registry)
   * leads the list; GitHub-tap matches (curated official repos) follow.
   * Each source is fetched independently so one failing does not blank
   * the other — partial results plus a combined error note are emitted.
   */
  private async runBrowse(
    query: string | null,
    opts: { force: boolean },
  ): Promise<void> {
    this.bus.emit({ type: "skills_hub_loading", loading: true });
    const trimmed = query?.trim() ?? "";
    const errors: string[] = [];

    const clawEntries = await this.loadClawHub(trimmed).catch((err) => {
      errors.push(`clawhub: ${err instanceof Error ? err.message : String(err)}`);
      return [] as HubSkillEntry[];
    });

    let githubEntries: HubSkillEntry[] = [];
    try {
      const { entries, errors: tapErrors } = await this.loadGithubCatalog(
        opts.force,
      );
      githubEntries =
        trimmed.length > 0 ? filterHubEntries(entries, trimmed) : entries;
      const tapErr = formatTapErrors(tapErrors);
      if (tapErr) errors.push(tapErr);
    } catch (err) {
      errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
    }

    const merged = [...clawEntries, ...githubEntries];
    if (merged.length === 0 && errors.length > 0) {
      this.bus.emit({
        type: "skills_hub_results",
        rows: [],
        error: errors.join("; "),
      });
      this.bus.emit({
        type: "runtime_info",
        line: `skill hub failed: ${errors.join("; ")}`,
      });
      return;
    }
    this.bus.emit({
      type: "skills_hub_results",
      rows: merged.map(toHubRow),
      error: errors.length > 0 ? errors.join("; ") : null,
    });
  }

  /**
   * ClawHub portion of a browse/search. With a query, run a server-side
   * relevance search; otherwise list the popular catalog page. Returns an
   * empty list (no API call) when ClawHub is disabled in config.
   */
  private async loadClawHub(query: string): Promise<HubSkillEntry[]> {
    const cfg = getConfig().skills.clawhub;
    if (!cfg.enabled) return [];
    const client = this.getClawHubClient(cfg.apiBase);
    if (query.length > 0) {
      return searchClawHub(client, query, {
        limit: cfg.browseLimit,
        nonSuspiciousOnly: cfg.nonSuspiciousOnly,
      });
    }
    return browseClawHub(client, {
      limit: cfg.browseLimit,
      sort: "recommended",
      nonSuspiciousOnly: cfg.nonSuspiciousOnly,
    });
  }

  private getClawHubClient(apiBase: string): ClawHubClient {
    if (this.clawHub && this.clawHub.apiBase === apiBase) {
      return this.clawHub.client;
    }
    const client = new ClawHubClient({ apiBase });
    this.clawHub = { client, apiBase };
    return client;
  }

  /**
   * Return the GitHub-tap catalog, fetching only when the cache is empty
   * or `force` is set. A cache hit makes search/filter instant and free
   * of API calls (GitHub's unauthenticated limit is 60/hour).
   */
  private async loadGithubCatalog(force: boolean): Promise<{
    entries: HubSkillEntry[];
    errors: Array<{ repo: string; error: string }>;
  }> {
    const taps = this.configuredTaps();
    if (taps.length === 0) return { entries: [], errors: [] };
    if (!force && this.githubCatalog) return this.githubCatalog;
    const client = new GithubSkillClient();
    const result = await browseHub(client, taps);
    this.githubCatalog = result;
    return result;
  }

  /**
   * Open the pre-install card for a hub row. For ClawHub rows it fetches
   * the full SKILL.md from the registry detail endpoint (no ZIP download
   * yet) so the operator can review the skill before committing. GitHub
   * rows have no such endpoint, so the card shows catalog metadata only
   * and notes that the body is fetched at install time.
   */
  async openHubCard(row: HubSkillRow): Promise<void> {
    if (row.source !== "clawhub") {
      this.bus.emit({
        type: "skills_hub_card_opened",
        card: {
          identifier: row.identifier,
          source: row.source,
          name: row.name,
          repo: row.repo,
          description: row.description,
          version: row.version,
          downloads: row.downloads,
          body: null,
          bodyError: "preview unavailable for GitHub taps (SKILL.md is pulled at install)",
        },
      });
      return;
    }
    this.bus.emit({ type: "skills_hub_card_loading", loading: true });
    const cfg = getConfig().skills.clawhub;
    const client = this.getClawHubClient(cfg.apiBase);
    let body: string | null = null;
    let bodyError: string | null = null;
    try {
      const ref = parseClawHubIdentifier(row.identifier);
      const detail = await client.getSkillDetail({
        slug: ref.slug,
        owner: ref.owner,
      });
      body = detail.skillMd.length > 0 ? detail.skillMd : null;
      if (body === null) bodyError = "no SKILL.md published for this skill";
    } catch (err) {
      bodyError = err instanceof Error ? err.message : String(err);
    }
    this.bus.emit({
      type: "skills_hub_card_opened",
      card: {
        identifier: row.identifier,
        source: row.source,
        name: row.name,
        repo: row.repo,
        description: row.description,
        version: row.version,
        downloads: row.downloads,
        body,
        bodyError,
      },
    });
  }

  /**
   * Stage the skill at `identifier`. On a clean scan the install commits
   * immediately; otherwise a confirmation modal is opened and the staged
   * handle is held until the operator confirms or cancels.
   */
  async installFromHub(
    identifier: string,
    source?: SkillSourceKind,
  ): Promise<void> {
    this.bus.emit({ type: "skills_install_loading", loading: true });
    try {
      const cfg = getConfig().skills.clawhub;
      const staged = await stageSkill({
        identifier,
        source,
        clawHubClient: this.getClawHubClient(cfg.apiBase),
      });
      if (staged.scan.verdict === "ok") {
        await this.commitStaged(staged);
        return;
      }
      this.staged.set(identifier, staged);
      this.bus.emit({
        type: "skills_install_confirm_opened",
        confirm: {
          identifier,
          verdict: staged.scan.verdict,
          findings: staged.scan.findings,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "skills_install_loading", loading: false });
      this.bus.emit({
        type: "runtime_info",
        line: `install ${identifier} failed: ${msg}`,
      });
    }
  }

  /** Commit a staged install awaiting confirmation. */
  async confirmInstall(identifier: string): Promise<void> {
    const staged = this.staged.get(identifier);
    if (!staged) {
      this.bus.emit({ type: "skills_install_confirm_closed" });
      return;
    }
    this.staged.delete(identifier);
    this.bus.emit({ type: "skills_install_loading", loading: true });
    try {
      await this.commitStaged(staged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "skills_install_confirm_closed" });
      this.bus.emit({
        type: "runtime_info",
        line: `install ${identifier} failed: ${msg}`,
      });
    }
  }

  /** Discard a staged install awaiting confirmation. */
  async cancelInstall(identifier: string): Promise<void> {
    const staged = this.staged.get(identifier);
    if (staged) {
      this.staged.delete(identifier);
      await discardStagedInstall(staged);
    }
    this.bus.emit({ type: "skills_install_confirm_closed" });
    this.bus.emit({
      type: "runtime_info",
      line: `install cancelled: ${identifier}`,
    });
  }

  private async commitStaged(staged: StagedSkillInstall): Promise<void> {
    const result = await commitStagedInstall(staged, {
      targetRoot: this.runtime.config.paths.globalSkillsDir,
      force: true,
    });
    this.bus.emit({ type: "skills_install_confirm_closed" });
    this.bus.emit({ type: "skills_hub_closed" });
    this.bus.emit({
      type: "runtime_info",
      line: `installed ${result.manifest.name} (v${result.manifest.version}) from ${staged.identifier}`,
    });
    await this.runtime.refreshSkills();
    this.refresh();
  }

  private configuredTaps(): SkillTap[] {
    return getConfig().skills.taps.map((repo) => ({ repo, path: "" }));
  }
}

function toHubRow(entry: HubSkillEntry): HubSkillRow {
  return {
    identifier: entry.identifier,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    repo: entry.repo,
    source: entry.source,
    downloads: entry.downloads,
  };
}

function formatTapErrors(
  errors: ReadonlyArray<{ repo: string; error: string }>,
): string | null {
  if (errors.length === 0) return null;
  return errors.map((e) => `${e.repo}: ${e.error}`).join("; ");
}

async function readManifestBody(manifestPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { parseSkillFile } = await import("../../skills/skill-manifest.js");
  const content = await readFile(manifestPath, "utf8");
  return parseSkillFile(content).body;
}
