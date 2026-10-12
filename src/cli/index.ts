#!/usr/bin/env node
// Must stay first: it defaults NODE_ENV to production before `ink`
// pulls in react-reconciler, which picks its build at require time.
// See src/cli/node-env-bootstrap.ts.
import "./node-env-bootstrap.js";
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
import { memoryCommand } from "./memory-command.js";
import { modelsCommand } from "./models-command.js";
import { importCommand } from "./import-command.js";
import { uninstallCommand } from "./uninstall-command.js";
import { updateCommand } from "./update-command.js";
import { tuiCommand } from "../tui/index.js";
import { installTransportDeadlines } from "../llm/transport-deadlines.js";
import { getAppVersion } from "../version.js";
import { USER_CONFIG_DEFAULTS } from "../config/index.js";

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
   * `run`, `skill`, `memory` and the dispatcher below implement this
   * split. The rest of the table does not, and a caller must not read
   * their codes through it:
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
    summary: "Serve the HTTP API and run the enabled Telegram/Discord channels",
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
    name: "memory",
    summary: "Inspect + export the cross-session memory store (export)",
    run: memoryCommand,
  },
  {
    name: "models",
    summary:
      "Manage the local-LLM runtime + GGUF models (list|pull|use|status|...) and search cloud models (search)",
    run: modelsCommand,
  },
  {
    name: "import",
    summary:
      "Import skills, sessions + more from another agent (import --help lists sources)",
    run: importCommand,
  },
  {
    name: "update",
    summary:
      "Self-update the installed binary from GitHub Releases (--check to probe only)",
    run: updateCommand,
  },
  {
    // Last, and last on purpose: the help listing is read top to bottom,
    // and the one entry that destroys data belongs at the bottom of it
    // rather than next to `update`, which it otherwise rhymes with.
    name: "uninstall",
    summary:
      "Remove atomic-agent and all of its data from this machine (--dry-run to preview)",
    run: uninstallCommand,
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
      (c) => `  ${c.name.padEnd(9)} ${c.summary}`,
    ),
    "",
    "User config (edit via `atomic-agent config`):",
    "  <stateDir>/config.json         localModels.url, localModels.mode, log.level, agent.{tokenBudget,maxSteps,task.*,toolTimeoutMs,approvalLevel}",
    "",
    "Bootstrap env:",
    "  ATOMIC_AGENT_STATE_DIR         Directory for persistent state + config.json (default ~/.atomic-agent)",
    "  ATOMIC_AGENT_LLAMA_API_KEY     Bearer token for the llama-server (managed mode: the daemon runs with it; unset = a generated key in <models dir>/llama-server.key)",
    "  ATOMIC_AGENT_SERVE_NO_PARENT_EXIT  1 to keep `serve` running after its parent exits (same as --no-parent-exit)",
    `  ATOMIC_AGENT_LLAMA_MAX_TOKENS  Max new tokens per completion (n_predict / max_tokens), default ${USER_CONFIG_DEFAULTS.localModels.completionMaxTokens}, clamped 64..131072`,
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

// Before any command can issue a request: undici applies a 300 s deadline
// of its own beneath every AbortSignal this process arms, and a request
// that hits it fails as a bare `fetch failed` naming nothing. Installed
// here without a config — `getConfig()` writes a config file on first
// use, which an install or `--help` must not do — so this is the floor
// off the shipped defaults; `createAgentRuntime` widens it from the real
// config when a command actually builds a runtime. See
// `installTransportDeadlines`.
installTransportDeadlines();

/**
 * Windows consoles default to an OEM code page (CP866 on Russian Windows),
 * while Node speaks UTF-8, so Cyrillic input, output and copy/paste turn
 * into mojibake. Switch the console to UTF-8 (65001) for the lifetime of
 * the process and put the original page back on exit, because chcp changes
 * the whole console session, not just this process. Only the console code
 * page changes here; stdout/stderr streams are not touched, so ink and
 * readline rendering are unaffected.
 */
function ensureUtf8Console(): void {
  if (process.platform !== "win32") return;
  let previous: string;
  try {
    // The chcp output text is localized ("Active code page" and friends);
    // the trailing number is the only part worth reading.
    previous = /\d+/.exec(execSync("chcp", { encoding: "utf8" }))?.[0] ?? "";
    execSync("chcp 65001 >nul", { stdio: "ignore" });
  } catch {
    // Non-fatal: some hosts disallow reading or changing the code page.
    return;
  }
  if (!previous || previous === "65001") return;
  process.on("exit", () => {
    try {
      execSync(`chcp ${previous} >nul`, { stdio: "ignore" });
    } catch {
      // Best effort: the console may already be closing.
    }
  });
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
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${message}\n`);
    exit(1);
  });
