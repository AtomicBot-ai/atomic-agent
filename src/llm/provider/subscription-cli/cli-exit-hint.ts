/**
 * A plain-words next step for a CLI exit the person can fix on their
 * own (ATO-1679): the CLI refused one of our flags, or Claude Code on
 * Windows found no git-bash. Both patterns are mirrored as the
 * `unknown_option` and `git_bash_missing` words of `cli_reason` in
 * `src/error-reporting/subscription-cli-failure-tag.ts`, which reads the
 * finished message. `mapCliFailure` matches the same detail text it puts
 * into that message, so the hint and the report word cannot disagree.
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

/** `claude` or `codex` from a path such as `C:\...\npm\claude.cmd`, else `null`. */
export function knownCli(binary: string): "claude" | "codex" | null {
  const base = binary.split(/[\\/]/).pop() ?? binary;
  const name = base.replace(/\.(?:cmd|bat|exe|ps1|js|mjs)$/i, "").toLowerCase();
  return name === "claude" || name === "codex" ? name : null;
}

const CODEX_UPDATE = "`npm install -g @openai/codex@latest` or `brew upgrade codex`";

/**
 * The sentence to append to a failure message, with a leading space, or
 * an empty string when `text` shows neither case, so the CLI's own text
 * stays the whole explanation.
 */
export function exitHint(binary: string, text: string): string {
  if (GIT_BASH_PATTERNS.some((re) => re.test(text))) {
    return " Claude Code on Windows needs Git for Windows (git-bash). Install it from https://git-scm.com/downloads/win or set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe, then restart Atomic Agent.";
  }
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
