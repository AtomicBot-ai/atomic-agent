/**
 * Syntax checkers for languages whose own toolchain ships a parse-only
 * mode: Go, Ruby, PHP, Lua and zsh. Each one runs a binary that is
 * already on the machine, one file per invocation, and never executes
 * or rewrites the file:
 *
 * - Go: `gofmt -l -e` parses and lists, it does not write back.
 * - Ruby: `ruby -c` compiles only, it does not run the program.
 * - PHP: `php -l` lints only.
 * - Lua: `luac -p` parses only and writes no `luac.out`.
 * - zsh: `zsh -n` reads commands without executing them.
 *
 * Nothing here is installed or downloaded: a missing toolchain is a
 * result ("unchecked"), never a pass, matching the rest of
 * `verify.syntax`.
 */
import { runChecker } from "./check-script-syntax.js";
import { type SyntaxFileResult, tailOfOutput } from "./syntax-check-types.js";

interface LanguageChecker {
  /** Name used in "<tool> not found". */
  readonly tool: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const CHECKERS: Readonly<Record<string, LanguageChecker>> = {
  ".go": { tool: "gofmt", cmd: "gofmt", args: ["-l", "-e"] },
  ".rb": { tool: "ruby", cmd: "ruby", args: ["-c"] },
  ".php": { tool: "php", cmd: "php", args: ["-l"] },
  ".lua": { tool: "luac", cmd: "luac", args: ["-p"] },
  ".zsh": { tool: "zsh", cmd: "zsh", args: ["-n"] },
};

/** Extensions this module can check (lower case, with the dot). */
export const LANGUAGE_SYNTAX_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(CHECKERS),
);

/**
 * Check one file with its language's parse-only mode. `ext` is the
 * lower-case extension; call only for one in `LANGUAGE_SYNTAX_EXTENSIONS`.
 * `cmd` overrides the binary (tests).
 */
export async function checkLanguageFile(
  file: string,
  ext: string,
  options: { cmd?: string } = {},
): Promise<SyntaxFileResult> {
  const spec = CHECKERS[ext];
  if (spec === undefined) {
    return { file, ok: null, checker: "none", error: `no checker for ${ext}` };
  }
  const cmd = options.cmd ?? spec.cmd;
  const run = await runChecker(cmd, [...spec.args, file]);
  const checker = `${spec.cmd} ${spec.args.join(" ")}`;
  if (run.missing) {
    return { file, ok: null, checker: "none", error: `${spec.tool} not found` };
  }
  if (run.timedOut) return { file, ok: null, checker, error: "timed out" };
  if (run.exitCode === 0) return { file, ok: true, checker };
  return {
    file,
    ok: false,
    checker,
    // php -l reports on stdout, the others on stderr.
    error: tailOfOutput(`${run.stdout}\n${run.stderr}`, 4) || `exit ${run.exitCode}`,
  };
}
