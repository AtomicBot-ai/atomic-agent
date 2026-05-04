import {
  ensureUserConfigFileSync,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
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
        skills: { disabled: nextDisabled },
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
}

async function readManifestBody(manifestPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { parseSkillFile } = await import("../../skills/skill-manifest.js");
  const content = await readFile(manifestPath, "utf8");
  return parseSkillFile(content).body;
}
