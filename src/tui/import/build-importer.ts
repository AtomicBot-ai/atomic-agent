import {
  ClaudeCodeImporter,
  ClaudeCodeSource,
  CodexImporter,
  CodexSource,
  HermesImporter,
  HermesSource,
  OpenclawImporter,
  OpenclawSource,
  OPENCLAW_DEFAULT_AGENT,
  type ClaudeCodeOptionId,
  type CodexOptionId,
  type ImportAgentId,
  type ImportOptionId,
  type ImportReport,
  type OpenclawOptionId,
} from "../../import/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

export interface ImportRunnerInput {
  /** Option ids already scoped to the source (the form or the plan built them). */
  options: readonly string[];
  execute: boolean;
  overwrite: boolean;
  /** Newest-N cap on sessions; unset imports every session. */
  limit?: number;
}

/**
 * One importer behind a source-agnostic face, so the Import tab and the
 * first-run flow share a single construction site instead of each
 * repeating the four `new XImporter({...})` blocks.
 */
export interface ImportRunner {
  run(input: ImportRunnerInput): Promise<ImportReport>;
  /** Release the read-only source handle (SQLite for Hermes / OpenClaw). */
  close(): void;
}

/**
 * Build the importer for `id` over the runtime's already-open stores —
 * `sessionStore` / `taskStore` / `notesStore` belong to the runtime and
 * are never closed here; only the per-run source is, through `close()`.
 * OpenClaw takes every agent found under `agents/`: the CLI's `--agent`
 * narrowing has no counterpart in the TUI, where the operator expects
 * "import OpenClaw" to mean all of it.
 */
export function buildImportRunner(
  runtime: AgentRuntime,
  id: ImportAgentId,
  dir: string,
): ImportRunner {
  const config = runtime.config;
  const workingDirFallback = process.cwd();
  switch (id) {
    case "hermes": {
      const source = new HermesSource(dir);
      const importer = new HermesImporter({
        source,
        sessionStore: runtime.sessionStore,
        taskStore: runtime.taskStore,
        stateDir: config.paths.stateDir,
        maxAttempts: config.tasks.maxAttempts,
        workingDirFallback,
      });
      return {
        run: async (input) =>
          importer.run({
            ...input,
            options: input.options.filter(isHermesOption),
          }),
        close: () => source.close(),
      };
    }
    case "openclaw": {
      const source = new OpenclawSource(dir, OPENCLAW_DEFAULT_AGENT);
      const importer = new OpenclawImporter({
        source,
        sessionStore: runtime.sessionStore,
        taskStore: runtime.taskStore,
        maxAttempts: config.tasks.maxAttempts,
        workingDirFallback,
      });
      return {
        run: async (input) =>
          importer.run({
            ...input,
            options: input.options.filter(isOpenclawOption),
            agents: source.listAgents(),
          }),
        close: () => source.close(),
      };
    }
    case "claude-code": {
      const importer = new ClaudeCodeImporter({
        source: new ClaudeCodeSource(dir),
        sessionStore: runtime.sessionStore,
        memoryStore: runtime.notesStore,
        stateDir: config.paths.stateDir,
        userConfigFile: config.paths.userConfigFile,
        globalSkillsDir: config.paths.globalSkillsDir,
        workingDirFallback,
      });
      return {
        run: (input) =>
          importer.run({
            ...input,
            options: input.options.filter(isClaudeCodeOption),
          }),
        close: () => {},
      };
    }
    case "codex": {
      const importer = new CodexImporter({
        source: new CodexSource(dir),
        sessionStore: runtime.sessionStore,
        memoryStore: runtime.notesStore,
        stateDir: config.paths.stateDir,
        globalSkillsDir: config.paths.globalSkillsDir,
        workingDirFallback,
      });
      return {
        run: (input) =>
          importer.run({
            ...input,
            options: input.options.filter(isCodexOption),
          }),
        close: () => {},
      };
    }
  }
}

// The option ids are already source-scoped by construction (each row
// was built from that source's registry); the guards restate that for
// the type system at the seam where the unions meet.
function isHermesOption(id: string): id is ImportOptionId {
  return id === "sessions" || id === "cron" || id === "secrets";
}

function isOpenclawOption(id: string): id is OpenclawOptionId {
  return id === "sessions" || id === "cron";
}

function isClaudeCodeOption(id: string): id is ClaudeCodeOptionId {
  return (
    id === "skills" ||
    id === "memory" ||
    id === "mcp" ||
    id === "sessions" ||
    id === "secrets"
  );
}

function isCodexOption(id: string): id is CodexOptionId {
  return (
    id === "skills" || id === "memory" || id === "sessions" || id === "secrets"
  );
}
