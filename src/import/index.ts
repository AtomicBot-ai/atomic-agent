// Shared import framework (source-agnostic report aggregation).
export { buildReport, emptySummary } from "./import-report.js";
export type {
  ImportItemResult,
  ImportItemStatus,
  ImportReport,
} from "./import-report.js";

// Hermes source.
export {
  HermesImporter,
  HermesSource,
  HermesSourceError,
  IMPORT_OPTIONS,
  IMPORT_PRESETS,
  ImportOptionError,
  resolveSelectedOptions,
  mapHermesSession,
  HERMES_SESSION_ID_PREFIX,
  mapHermesCronJob,
  SECRET_ALLOWLIST,
  selectSecrets,
} from "./hermes/index.js";
export type {
  HermesCronJob,
  HermesImporterDeps,
  HermesMessage,
  HermesSchedule,
  HermesSession,
  ImportOptionId,
  ImportOptionMeta,
  ImportPresetId,
  ImportRunOptions,
  MapCronOptions,
  MapCronResult,
  ResolveOptionsInput,
  SecretKey,
  SelectedSecret,
} from "./hermes/index.js";

// OpenClaw source.
export {
  OpenclawImporter,
  OpenclawSource,
  OpenclawSourceError,
  OpenclawOptionError,
  OPENCLAW_DEFAULT_AGENT,
  OPENCLAW_IMPORT_OPTIONS,
  OPENCLAW_SESSION_ID_PREFIX,
  resolveOpenclawOptions,
  mapOpenclawSession,
  mapOpenclawCronJob,
} from "./openclaw/index.js";
export type {
  OpenclawBlock,
  OpenclawCronJob,
  OpenclawImporterDeps,
  OpenclawMessage,
  OpenclawOptionId,
  OpenclawOptionMeta,
  OpenclawRunOptions,
  OpenclawSessionMeta,
  ResolveOpenclawOptionsInput,
} from "./openclaw/index.js";

// Claude Code source.
export {
  CLAUDE_CODE_IMPORT_OPTIONS,
  CLAUDE_CODE_MEMORY_TAG,
  CLAUDE_CODE_SECRET_ALLOWLIST,
  CLAUDE_CODE_SESSION_ID_PREFIX,
  ClaudeCodeImporter,
  ClaudeCodeOptionError,
  ClaudeCodeSource,
  ClaudeCodeSourceError,
  mapClaudeCodeMcpServer,
  mapClaudeCodeSession,
  ONBOARDING_SESSION_LIMIT,
  resolveClaudeCodeOptions,
} from "./claude-code/index.js";
export type {
  ClaudeCodeImporterDeps,
  ClaudeCodeOptionId,
  ClaudeCodeOptionMeta,
  ClaudeCodeRunOptions,
  ImportMemoryTarget,
  MapMcpResult,
  ResolveClaudeCodeOptionsInput,
} from "./claude-code/index.js";

// Codex source.
export {
  CODEX_IMPORT_OPTIONS,
  CODEX_MEMORY_TAG,
  CODEX_SECRET_ALLOWLIST,
  CODEX_SESSION_ID_PREFIX,
  CodexImporter,
  CodexOptionError,
  CodexSource,
  CodexSourceError,
  mapCodexSession,
  resolveCodexOptions,
} from "./codex/index.js";
export type {
  CodexImporterDeps,
  CodexOptionId,
  CodexOptionMeta,
  CodexRunOptions,
  ResolveCodexOptionsInput,
} from "./codex/index.js";

// Source detection (shared by the first-run flow and anything that
// wants to name the sources without hard-coding their layouts).
export {
  detectImportAgents,
  IMPORT_AGENT_LABELS,
  importAgentDir,
} from "./detect-import-agents.js";
export type {
  DetectedImportAgent,
  DetectImportAgentsOptions,
  ImportAgentId,
} from "./detect-import-agents.js";
