/**
 * Command line surface for `atomic-agent mcp-server` (ATO-549): the
 * flags, the help text and the parse. The command itself lives in
 * `mcp-server-command.ts`.
 */

import { resolve } from "node:path";

export interface McpServerArgs {
  /** Folder the exposed tools treat as the working directory. */
  workingDir: string;
  /** Also expose the memory write tools (`memory.notes.store`, `memory.profile.set`). */
  allowWrite: boolean;
  /** Also expose `os.shell.run`, still behind the approval gate. */
  allowExec: boolean;
  /**
   * Narrow the exposed set to these tools (wire or dotted names). Empty
   * means every tool the other flags allow.
   */
  tools: string[];
}

export const MCP_SERVER_HELP =
  [
    "atomic-agent mcp-server — serve the agent's memory and skills to other MCP clients over stdio",
    "",
    "Usage:",
    "  atomic-agent mcp-server [options]",
    "  atag mcp-server [options]",
    "",
    "Claude Code, Codex, Cursor or any MCP client starts this command and talks to",
    "it over stdin/stdout. By default every tool is read-only:",
    "  memory_notes_recall        search or fetch your saved notes",
    "  memory_lessons_recall      search learned lessons (when memory.lessons is on)",
    "  memory_procedures_recall   search saved procedures (when memory.procedures is on)",
    "  memory_profile_list        list profile facts",
    "  skills_list                list installed, enabled skills",
    "  skill_view                 read one skill's SKILL.md",
    "",
    "Options:",
    "  --allow-write      Also expose memory_notes_store and memory_profile_set",
    "  --allow-exec       Also expose os_shell_run. Every command still goes through",
    "                     the approval gate; the MCP client cannot show an approval",
    "                     prompt, so a command that would ask is refused. Only your",
    "                     approval level and saved allow rules can let one run",
    "  --tool <name>      Expose only this tool (repeatable; wire or dotted name)",
    "  --cwd <dir>        Working directory for the tools (default: current directory)",
    "  -h, --help         Show this help",
    "",
    "Example (Claude Code):",
    "  claude mcp add atomic-agent -- atag mcp-server",
  ].join("\n") + "\n";

export class McpServerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerUsageError";
  }
}

/** `null` means help was asked for. Throws `McpServerUsageError` on a bad flag. */
export function parseMcpServerArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): McpServerArgs | null {
  const parsed: McpServerArgs = {
    workingDir: cwd,
    allowWrite: false,
    allowExec: false,
    tools: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return null;
      case "--allow-write":
        parsed.allowWrite = true;
        break;
      case "--allow-exec":
        parsed.allowExec = true;
        break;
      case "--tool":
        parsed.tools.push(valueOf(args, ++i, arg));
        break;
      case "--cwd":
        parsed.workingDir = resolve(cwd, valueOf(args, ++i, arg));
        break;
      default:
        throw new McpServerUsageError(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function valueOf(args: readonly string[], i: number, flag: string): string {
  const value = args[i];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new McpServerUsageError(`${flag} needs a value`);
  }
  return value;
}
