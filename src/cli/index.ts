#!/usr/bin/env node
import { argv, exit } from "node:process";
import { runAgentCommand } from "./run-agent.js";
import { debugReplCommand } from "./debug-repl.js";
import { skillCommand } from "./skill.js";
import { configCommand } from "./config-command.js";
import { serveCommand } from "./serve-command.js";
import { tuiCommand } from "../tui/index.js";

interface CommandDescriptor {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
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
];

function printHelp(): void {
  const lines = [
    "atomic-agent — lightweight local operator agent (browser + OS)",
    "",
    "Usage:",
    "  atomic-agent <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`),
    "",
    "User config (edit via `atomic-agent config`):",
    "  <stateDir>/config.json         llama.url, log.level, agent.{tokenBudget,maxSteps,toolTimeoutMs,approvalRequired}",
    "",
    "Bootstrap env:",
    "  ATOMIC_AGENT_STATE_DIR         Directory for persistent state + config.json (default ~/.atomic-agent)",
    "  ATOMIC_AGENT_LLAMA_API_KEY     Optional bearer token for the llama-server",
    "  ATOMIC_AGENT_BROWSER_CHANNEL           Preferred browser family: chrome | msedge | chromium (default chrome)",
    "  ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH   Explicit path to a Chromium-family binary (overrides auto-detect)",
    "  ATOMIC_AGENT_BROWSER_HEADLESS          1 to run headless (default 0)",
    "  ATOMIC_AGENT_BROWSER_NO_SANDBOX        1 to pass --no-sandbox (containers / CI only)",
    "  ATOMIC_AGENT_BROWSER_CDP_URL           Attach to an already-running browser via CDP instead of launching",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<number> {
  const [, , command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return 0;
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
