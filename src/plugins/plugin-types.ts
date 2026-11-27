/**
 * Shared shapes for plugin bundles (Claude / Codex / Cursor / Agent Plugins
 * packages). A bundle is data only: reading or installing one never runs
 * code. Hooks and stdio MCP servers do run commands later, which is why the
 * bundle reports them separately (see `runsCode` in plugin-bundle.ts).
 */

/** Which manifest convention identified the folder as a plugin. */
export type PluginFormat =
  | "claude" // .claude-plugin/plugin.json
  | "codex" // .codex-plugin/plugin.json
  | "cursor" // .cursor-plugin/plugin.json
  | "agent-plugins" // plugin.json at the root (Agent Plugins 1.0)
  | "conventional"; // no manifest, Claude folder layout (skills/, commands/, ...)

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/**
 * The fields we read from a plugin manifest. Path overrides are relative to
 * the plugin root, already checked to stay inside it. Inline `hooks` /
 * `mcpServers` objects are kept as raw JSON for their own readers.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  skillPaths: string[];
  commandPaths: string[];
  agentPaths: string[];
  hooksPath?: string;
  hooksInline?: Record<string, unknown>;
  mcpPath?: string;
  mcpInline?: Record<string, unknown>;
  /** `experimental.monitors` (or a top-level `monitors`) as a path inside the plugin. */
  monitorsPath?: string;
  /** The same key as an inline array, kept raw for `readMonitorEntries`. */
  monitorsInline?: unknown[];
  /** Manifest keys we recognise but do not support yet (outputStyles, lspServers, ...). */
  unsupportedKeys: string[];
}

export interface PluginSkillEntry {
  /** Folder name, used as the skill name inside the plugin namespace. */
  name: string;
  /** Absolute path of the skill folder (contains SKILL.md). */
  dir: string;
  /** Whether the folder ships executable scripts (scripts/ or *.sh, *.py, ...). */
  hasScripts: boolean;
}

export interface PluginCommandEntry {
  /** Command name: file path under commands/ without .md, `/` joined by `:`. */
  name: string;
  file: string;
}

export interface PluginAgentEntry {
  name: string;
  file: string;
}

/**
 * A background command the plugin declares (`monitors/monitors.json`,
 * Claude Code's plugin monitors, ATO-2438). It starts with a session's
 * first turn, as a kept job of that session, and each matching line it
 * prints reaches the agent as a monitor notice.
 */
export interface PluginMonitorEntry {
  /** Unique within the plugin; the part id is `monitor:<name>`. */
  name: string;
  /** Shell command line as declared; `${CLAUDE_PLUGIN_ROOT}` is expanded when it starts. */
  command: string;
  /** Short summary, shown in the notice and in the plugin views. */
  description: string;
  /** Case-insensitive line pattern (our addition); absent means every non-blank line. */
  until?: string;
}

export interface PluginBundle {
  name: string;
  root: string;
  format: PluginFormat;
  manifest: PluginManifest;
  skills: PluginSkillEntry[];
  commands: PluginCommandEntry[];
  agents: PluginAgentEntry[];
  /** Absolute path of hooks.json, when the plugin ships one. */
  hooksFile?: string;
  /** Raw `mcpServers` map (name -> Claude-style entry), merged from file and manifest. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** Monitors that start with a session (`when: "always"`); skipped entries are in `notes`. */
  monitors: PluginMonitorEntry[];
  /** Absolute path of the monitors file, when the plugin ships one. */
  monitorsFile?: string;
  /** Plain-language notes about what we skip, shown to the user. */
  notes: string[];
}
