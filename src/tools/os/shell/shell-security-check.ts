import type { SecurityFinding } from "../../../approval/approval-ledger.js";
import type { GuardVerdict } from "../shell-command-guard/index.js";
import { sensitiveWriteReason, sensitiveWriteTargets } from "../fs/sensitive-write-targets.js";
import type { ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import { basenameCommand } from "../shell-command-guard/normalise.js";
import { sensitiveExecWrites, sensitiveLineWrites } from "./shell-line-sensitive-writes.js";

/**
 * What the argument checks say about one shell call (ATO-2505), for the
 * approval request: the guard's own finding (a credential read, an
 * encoded command) with its confidence, and a write by the command into
 * a shell startup file, the SSH folder or a credential file in home
 * (`sensitive-write-targets.ts`, the same list `os.fs.write` uses).
 *
 * The check fails closed (review rounds 1 and 2): a write target only
 * known when the line runs that could be one of those files counts
 * (`shell-line-sensitive-writes.ts`), and so does a line that cannot be
 * read at all and names one (with its own reason, not a write claim).
 * A plainly read-only line (`ls ~/.ssh/id_*`, `cat ~/.ssh/*.pub`) is not
 * a write; a credential read is the guard's finding.
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

/** The rule of a line that cannot be read and names a sensitive home entry. */
export const UNREADABLE_SENSITIVE_RULE = "dangerous.sensitive_line_unreadable";
const UNREADABLE_REASON =
  "names a startup, SSH or credential file in your home folder in a form that cannot be read before it runs; asks in every mode";

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
 * script of `bash -c`, `execShellScript`); `exec` is a direct exec of
 * anything else (`{cmd:"tar", args:["xf","p.tar","-C","~"]}`).
 */
export function shellSecurityCheck(
  verdict: GuardVerdict,
  targetPaths: readonly string[],
  cwd: string,
  commandLine?: string,
  dialect: ShellDialect = process.platform === "win32" ? "cmd" : "posix",
  exec?: { cmd: string; args: readonly string[] },
): ShellSecurityCheck {
  const sensitive = sensitiveWriteTargets(targetPaths, cwd);
  let unreadable = false;
  if (commandLine !== undefined) {
    const line = sensitiveLineWrites(commandLine, cwd, dialect);
    sensitive.push(...line.writes.filter((write) => !sensitive.includes(write)));
    unreadable = line.unreadable;
  } else if (exec !== undefined) {
    sensitive.push(...sensitiveExecWrites(exec.cmd, exec.args, cwd).filter((write) => !sensitive.includes(write)));
  }
  // The guard's own sure finding (a credential read) names it better.
  const guardAsks = FINDING_RULES.has(verdict.rule) && verdict.askEveryLevel === true;
  if (sensitive.length === 0 && unreadable && !guardAsks) {
    return {
      forcesGate: true,
      askEveryLevel: true,
      finding: { rule: UNREADABLE_SENSITIVE_RULE, reason: UNREADABLE_REASON, confidence: 1 },
    };
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
