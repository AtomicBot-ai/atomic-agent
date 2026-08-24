#!/usr/bin/env node
import { execSync } from "node:child_process";
import { isSea } from "node:sea";
import { argv, exit } from "node:process";
import { runAgentCommand } from "./run-agent.js";
import { debugReplCommand } from "./debug-repl.js";
import { skillCommand } from "./skill.js";
import { configCommand } from "./config-command.js";
import { serveCommand } from "./serve-command.js";
import { traceCommand } from "./trace-command.js";
import { taskCommand } from "./task-command.js";
import { modelsCommand } from "./models-command.js";
import { importCommand } from "./import-command.js";
import { updateCommand } from "./update-command.js";
import { tuiCommand } from "../tui/index.js";
import { getAppVersion } from "../version.js";

interface CommandDescriptor {
  name: string;
  summary: string;
  /**
   * Resolves to the process exit code:
   *
   *   0  success
   *   1  operational failure — the command was invoked correctly and the
   *      work did not succeed. A lookup miss ("no such skill") is a
   *      failure, not a usage error.
   *   2  usage error — unknown command or subcommand, missing required
   *      argument, argument of the wrong kind. Nothing was attempted.
   *
   * `run`, `skill` and the dispatcher below implement this split. The
   * rest of the table does not, and a caller must not read their codes
   * through it:
   *
   *   - `config`, `serve`, `trace`, `task`, `models`, `import` predate
   *     the split and return `1` for usage errors too, so their `1` does
   *     not mean "the work failed".
   *   - `trace replay` returns `2` for "stable-prefix drift detected", a
   *     diff-style result code rather than a usage error.
   *   - `tui` reports `0` or `1` from its own session, and when it
   *     relaunches itself it passes the child process's status straight
   *     through, so any code is possible (130 on SIGINT, say).
   *   - `repl` is a scaffold and always returns `0`.
   *
   * Widening the split to those commands is a separate change.
   */
  run: (args: string[]) => Promise<number>;
  /**
   * Omit the command from `--help` while keeping it dispatchable when
   * typed. Used for scaffolds that are not ready to be advertised.
   */
  hidden?: boolean;
}

const COMMANDS: CommandDescriptor[] = [
  {
    name: "run",
    summary: "Run a full agent loop against a goal in a working directory",
    run: runAgentCommand,
  },
  {
    name: "skill",
    summary: "Manage installed skills (install|uninstall|list|show)",
    run: skillCommand,
  },
  {
    name: "config",
    summary: "View or replace the user config file (get|set '<json>')",
    run: configCommand,
  },
  {
    name: "repl",
    summary: "Interactive debug REPL: step the agent manually",
    run: debugReplCommand,
    // Still a stub (help/quit only) — dispatchable if typed, but not
    // advertised until the real implementation lands.
    hidden: true,
  },
  {
    name: "tui",
    summary: "Run a full agent loop under an interactive terminal UI (ink)",
    run: tuiCommand,
  },
  {
    name: "serve",
    summary: "Expose an OpenAI-compatible HTTP API plus atomic-agent admin routes",
    run: serveCommand,
  },
  {
    name: "trace",
    summary: "Inspect append-only session traces (list|show|export)",
    run: traceCommand,
  },
  {
    name: "task",
    summary: "Manage durable tasks (list|show|create|cancel|run)",
    run: taskCommand,
  },
  {
    name: "models",
    summary:
      "Manage the local-LLM runtime + GGUF models (list|pull|use|status|...) and search cloud models (search)",
    run: modelsCommand,
  },
  {
    name: "import",
    summary: "Import conversation history + cron jobs from another agent (hermes)",
    run: importCommand,
  },
  {
    name: "update",
    summary: "Self-update the installed binary from GitHub Releases (--check to probe only)",
    run: updateCommand,
  },
];

function printHelp(): void {
  const lines = [
    "atomic-agent — lightweight local operator agent (browser + OS)",
    "",
    "Usage:",
    "  atomic-agent <command> [options]",
    "  atag <command> [options]       (short alias, same binary)",
    "",
    "Commands:",
    ...COMMANDS.filter((c) => !c.hidden).map(
      (c) => `  ${c.name.padEnd(8)} ${c.summary}`,
    ),
    "",
    "User config (edit via `atomic-agent config`):",
    "  <stateDir>/config.json         localModels.url, localModels.mode, log.level, agent.{tokenBudget,maxSteps,toolTimeoutMs,approvalLevel}",
    "",
    "Bootstrap env:",
    "  ATOMIC_AGENT_STATE_DIR         Directory for persistent state + config.json (default ~/.atomic-agent)",
    "  ATOMIC_AGENT_LLAMA_API_KEY     Optional bearer token for the llama-server",
    "  ATOMIC_AGENT_LLAMA_MAX_TOKENS  Max new tokens per completion (n_predict), default 4096, clamped 64..131072",
    "  ATOMIC_AGENT_BROWSER_CHANNEL           Preferred browser family: chrome | msedge | chromium (default chrome)",
    "  ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH   Explicit path to a Chromium-family binary (overrides auto-detect)",
    "  ATOMIC_AGENT_BROWSER_HEADLESS          1 to run headless (default 0)",
    "  ATOMIC_AGENT_BROWSER_NO_SANDBOX        1 to pass --no-sandbox (containers / CI only)",
    "  ATOMIC_AGENT_BROWSER_CDP_URL           Attach to an already-running browser via CDP instead of launching",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function userArgsFromArgv(): string[] {
  if (process.env.ATOMIC_AGENT_DEBUG_ARGV === "1") {
    process.stderr.write(
      `argv=${JSON.stringify(argv)}\nexecPath=${process.execPath}\nisSea=${isSea()}\n`,
    );
  }
  // Node SEA (both CJS and ESM entrypoints) sets argv to
  // `[execPath, execPath-or-invoke-path, ...userArgs]`. The second slot is
  // whatever path the shell used to invoke the binary (e.g. `./atomic-agent`);
  // in CJS SEA this often duplicates `execPath`, in ESM SEA it mirrors
  // the invocation, but either way the real user args start at index 2.
  if (isSea()) {
    return argv.slice(2);
  }
  return argv.slice(2);
}

/**
 * Windows console defaults to CP866 for Cyrillic, which makes Russian input,
 * output and copy/paste turn into mojibake because Node speaks UTF-8. Switch
 * the console code page to UTF-8 (65001) at startup. This only changes the
 * console's code page тАФ it does NOT touch stdout/stderr streams, so ink and
 * readline rendering are unaffected.
 */
function ensureUtf8Console(): void {
  if (process.platform !== "win32") return;
  try {
    execSync("chcp 65001 >nul", { stdio: "ignore" });
  } catch {
    // Non-fatal: some hosts disallow changing the code page.
  }
}

async function main(): Promise<number> {
  ensureUtf8Console();
  const [command, ...rest] = userArgsFromArgv();
  if (command === "-h" || command === "--help") {
    printHelp();
    return 0;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`atomic-agent ${getAppVersion()}\n`);
    return 0;
  }
  // `help <cmd>` reads as naturally as `<cmd> --help`; alias one to the other.
  if (command === "help") {
    const target = rest[0];
    if (!target) {
      printHelp();
      return 0;
    }
    const aliased = COMMANDS.find((c) => c.name === target);
    if (!aliased) {
      process.stderr.write(`unknown command: ${target}\n`);
      printHelp();
      return 2;
    }
    return aliased.run(["--help"]);
  }
  if (!command) {
    return tuiCommand([]);
  }
  const descriptor = COMMANDS.find((c) => c.name === command);
  if (!descriptor) {
    process.stderr.write(`unknown command: ${command}\n`);
    printHelp();
    return 2;
  }
  return descriptor.run(rest);
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`${message}\n`);
    exit(1);
  });
