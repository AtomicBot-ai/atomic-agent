/**
 * A plain-words next step for a CLI exit the person can fix on their
 * own (ATO-1679): the CLI refused one of our flags, Claude Code on
 * Windows found no git-bash, an npm-installed CLI found no Node.js, or
 * the launcher exited 127 (a command it needs is not on PATH). The
 * patterns are mirrored as the `unknown_option`, `git_bash_missing`,
 * `node_missing` and `command_not_found` words of `cli_reason` in
 * `src/error-reporting/subscription-cli-failure-tag.ts`, which reads the
 * finished message and exit code. `mapCliFailure` matches the same
 * detail text it puts into that message, so the hint and the report word
 * cannot disagree.
 */

/**
 * The CLI refused one of our flags, for example a Claude Code or Codex
 * that does not know `--tools ""`, `--strict-mcp-config` or
 * `--json-schema`. Commander says "unknown option '--x'", clap says
 * "unexpected argument '--x' found" or "error: unrecognized ...".
 */
const UNKNOWN_OPTION_PATTERNS = [
  /\bunknown option\b/i,
  /\bunexpected argument\b/i,
  /\berror: unrecognized\b/i,
];

/**
 * Claude Code on Windows exits 1 without Git for Windows: "Claude Code
 * on Windows requires git-bash ... CLAUDE_CODE_GIT_BASH_PATH".
 */
const GIT_BASH_PATTERNS = [/\brequires git-bash\b/i, /\bCLAUDE_CODE_GIT_BASH_PATH\b/];

/**
 * An npm-installed `claude` or `codex` is a `#!/usr/bin/env node` script
 * (a cmd shim on Windows) and there was no `node` to run it. BSD `env`
 * says "env: node: No such file or directory", GNU `env` in a UTF-8
 * locale quotes the name with curly quotes ("/usr/bin/env: ‘node’: ..."),
 * a shell says "node: not found", cmd says "'node' is not recognized".
 * All of them exit 127 on macOS and Linux (CLI-E4).
 */
export const NODE_MISSING_PATTERNS = [
  /\benv: ['"‘’]?node['"‘’]?: No such file or directory/i,
  /'node' is not recognized as an internal or external command/i,
  /\bnode: (?:command )?not found\b/i,
  /\bcommand not found: node\b/i,
];

/** POSIX shells and `env` exit 127 when the command they were asked to run is not on PATH. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/** `claude` or `codex` from a path such as `C:\...\npm\claude.cmd`, else `null`. */
export function knownCli(binary: string): "claude" | "codex" | null {
  const base = binary.split(/[\\/]/).pop() ?? binary;
  const name = base.replace(/\.(?:cmd|bat|exe|ps1|js|mjs)$/i, "").toLowerCase();
  return name === "claude" || name === "codex" ? name : null;
}

export const CODEX_UPDATE = "`npm install -g @openai/codex@latest` or `brew upgrade codex`";

/**
 * The sentence to append to a failure message, with a leading space, or
 * an empty string when `text` and `exitCode` show none of the cases, so
 * the CLI's own text stays the whole explanation.
 */
export function exitHint(
  binary: string,
  text: string,
  exitCode: number | null = null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (GIT_BASH_PATTERNS.some((re) => re.test(text))) {
    return " Claude Code on Windows needs Git for Windows (git-bash). Install it from https://git-scm.com/downloads/win or set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe, or update Claude Code to 2.1.120 or newer (`claude update`), which no longer needs it. Then restart Atomic Agent.";
  }
  if (NODE_MISSING_PATTERNS.some((re) => re.test(text))) return nodeMissingHint(binary, platform);
  const unknownOption = unknownOptionHint(binary, text);
  if (unknownOption !== "") return unknownOption;
  if (exitCode === EXIT_COMMAND_NOT_FOUND) return commandNotFoundHint(binary, platform);
  return "";
}

/** The native installer for Claude Code, which brings its own runtime. */
function claudeNativeInstall(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "`irm https://claude.ai/install.ps1 | iex` in PowerShell"
    : "`curl -fsSL https://claude.ai/install.sh | bash`";
}

function nodeMissingHint(binary: string, platform: NodeJS.Platform): string {
  const node = "Install Node.js 18 or newer from https://nodejs.org";
  if (knownCli(binary) === "claude") {
    return ` Claude Code was installed with npm and needs Node.js, but Atomic Agent could not find \`node\` on PATH. ${node}, or reinstall Claude Code with its native installer (${claudeNativeInstall(platform)}), which does not need Node.js. Then restart Atomic Agent.`;
  }
  const product = knownCli(binary) === "codex" ? "The Codex CLI" : `"${binary}"`;
  return ` ${product} needs Node.js, but Atomic Agent could not find \`node\` on PATH. ${node}, then restart Atomic Agent. If Node.js is installed, set llm.providers[].subscriptionCli.binPath to the CLI's absolute path in the folder where \`node\` is.`;
}

function commandNotFoundHint(binary: string, platform: NodeJS.Platform): string {
  const cli = knownCli(binary);
  const reinstall =
    cli === "claude"
      ? `Reinstall Claude Code with ${claudeNativeInstall(platform)}`
      : cli === "codex"
        ? "Reinstall the Codex CLI with `npm install -g @openai/codex`"
        : "Reinstall the CLI";
  return ` Exit code 127 means a program the \`${cli ?? binary}\` launcher needs was not found on PATH. ${reinstall}, or set llm.providers[].subscriptionCli.binPath to the CLI's absolute path, then restart Atomic Agent.`;
}

function unknownOptionHint(binary: string, text: string): string {
  if (UNKNOWN_OPTION_PATTERNS.some((re) => re.test(text))) {
    const cli = knownCli(binary);
    if (cli === "claude") {
      return " Your Claude Code may be older than this version of Atomic Agent needs; update it with `claude update` and retry.";
    }
    if (cli === "codex") {
      return ` Your Codex may be older than this version of Atomic Agent needs; update it the way you installed it (for example ${CODEX_UPDATE}) and retry.`;
    }
    return ` Your "${binary}" may be older than this version of Atomic Agent needs; update it the way you installed it (for example \`claude update\` for Claude Code, or ${CODEX_UPDATE} for Codex) and retry.`;
  }
  return "";
}
