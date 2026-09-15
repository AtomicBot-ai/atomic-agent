// Shared import framework (source-agnostic report aggregation).
export { buildReport, emptySummary } from "./import-report.js";
export type {
  ImportItemResult,
  ImportItemStatus,
  ImportReport,
} from "./import-report.js";
export { importSkillDirs } from "./import-skill-dirs.js";
export type { ImportSkillDirsInput } from "./import-skill-dirs.js";
export { reconcileImportedSession } from "./reconcile-session.js";
export type {
  ReconcileImportedSessionArgs,
  ReconcileImportedSessionResult,
} from "./reconcile-session.js";

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
  openclawSessionId,
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

// Pi source.
export {
  listPiFormatSessions,
  listSkillDirs,
  mapPiFormatSession,
  mapPiSession,
  PI_IMPORT_OPTIONS,
  PI_SESSION_ID_PREFIX,
  PiImporter,
  PiOptionError,
  PiSource,
  PiSourceError,
  readPiFormatSession,
  resolvePiOptions,
} from "./pi/index.js";
export type {
  PiBlock,
  PiImporterDeps,
  PiMessage,
  PiOptionId,
  PiOptionMeta,
  PiRunOptions,
  PiSessionData,
  PiSessionMeta,
  PiSessionOrigin,
  PiSkill,
  ResolvePiOptionsInput,
} from "./pi/index.js";

// Oh-My-Pi source.
export {
  mapOhMyPiMcpServer,
  mapOhMyPiSession,
  OH_MY_PI_IMPORT_OPTIONS,
  OH_MY_PI_SESSION_ID_PREFIX,
  OhMyPiImporter,
  OhMyPiOptionError,
  OhMyPiSource,
  OhMyPiSourceError,
  resolveOhMyPiOptions,
} from "./oh-my-pi/index.js";
export type {
  OhMyPiImporterDeps,
  OhMyPiMcpServer,
  OhMyPiOptionId,
  OhMyPiOptionMeta,
  OhMyPiRunOptions,
  ResolveOhMyPiOptionsInput,
} from "./oh-my-pi/index.js";

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
