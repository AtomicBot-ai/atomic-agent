import type { SecurityFinding } from "../../../approval/approval-ledger.js";
import type { GuardVerdict } from "../shell-command-guard/index.js";
import {
  mentionsSensitiveHomeEntry,
  sensitiveWriteReason,
  sensitiveWriteTargets,
} from "../fs/sensitive-write-targets.js";
import { lexShellLine, type ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import { basenameCommand } from "../shell-command-guard/normalise.js";

/**
 * What the argument checks say about one shell call (ATO-2505), for the
 * approval request: the guard's own finding (a credential read, an
 * encoded command) with its confidence, and a write by the command into
 * a shell startup file, the SSH folder or a credential file in home
 * (`sensitive-write-targets.ts`, the same list `os.fs.write` uses).
 *
 * A line whose targets cannot be read and that names one of those files
 * counts as such a write: the check fails closed.
 *
 * Such a write sends the call to the gate even when the guard deems the
 * command safe (`echo key >> ~/.ssh/authorized_keys`), withholds grants
 * and fan-out scopes, and asks at every level, bypass included.
 */
export interface ShellSecurityCheck {
  /** The call must reach the gate whatever the guard's verdict. */
  forcesGate: boolean;
  /** Ask at every approval level, bypass included. */
  askEveryLevel: boolean;
  /** What the card shows and the ledger keeps; absent when nothing was found. */
  finding?: SecurityFinding;
}

const FINDING_RULES: ReadonlySet<string> = new Set([
  "dangerous.read_credentials",
  "dangerous.encoded_exec",
]);

/**
 * Whether `shellWriteTargets` may have missed a target of `line`: the
 * lexer cannot read it (`$(…)`, backticks, `${…}`, an open quote), or a
 * word is only known when it runs (`$USER`, `%APPDATA%`, a glob).
 */
function targetsUnreadable(line: string, dialect: ShellDialect): boolean {
  const tokens = lexShellLine(line, dialect);
  return tokens === null || tokens.some((token) => token.kind === "word" && token.dynamic);
}

const POSIX_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);

/**
 * The script of a direct exec of a shell (`{cmd:"bash", args:["-c",
 * "<line>"]}`): the line that shell runs, so it gets the same reading as
 * a subshell line. `undefined` for any other direct exec.
 */
export function execShellScript(cmd: string, args: readonly string[]): string | undefined {
  if (!POSIX_SHELLS.has(basenameCommand(cmd))) return undefined;
  const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
  return flag === -1 ? undefined : args[flag + 1];
}

/**
 * `commandLine` is the line the OS shell runs (for a direct exec, the
 * script of `bash -c`, `execShellScript`). When its targets cannot
 * be read and it names a sensitive home entry, that counts as a
 * sensitive write (review round 1 of ATO-2505): `echo k >>
 * ~/.ssh/authorized_keys; : $(true)` named no target at all, so the
 * check failed open.
 */
export function shellSecurityCheck(
  verdict: GuardVerdict,
  targetPaths: readonly string[],
  cwd: string,
  commandLine?: string,
  dialect: ShellDialect = process.platform === "win32" ? "cmd" : "posix",
): ShellSecurityCheck {
  const sensitive = sensitiveWriteTargets(targetPaths, cwd);
  if (
    sensitive.length === 0 &&
    commandLine !== undefined &&
    mentionsSensitiveHomeEntry(commandLine) &&
    targetsUnreadable(commandLine, dialect)
  ) {
    sensitive.push("a home file the command line builds when it runs");
  }
  if (sensitive.length > 0) {
    return {
      forcesGate: true,
      askEveryLevel: true,
      finding: {
        rule: "dangerous.write_startup_file",
        reason: sensitiveWriteReason(sensitive),
        confidence: 1,
      },
    };
  }
  if (FINDING_RULES.has(verdict.rule)) {
    return {
      forcesGate: false,
      askEveryLevel: verdict.askEveryLevel === true,
      finding: { rule: verdict.rule, reason: verdict.reason, confidence: verdict.confidence ?? 1 },
    };
  }
  return { forcesGate: false, askEveryLevel: verdict.askEveryLevel === true };
}
