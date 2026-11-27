import type { SecurityFinding } from "../../../approval/approval-ledger.js";
import type { GuardVerdict } from "../shell-command-guard/index.js";
import { sensitiveWriteReason, sensitiveWriteTargets } from "../fs/sensitive-write-targets.js";

/**
 * What the argument checks say about one shell call (ATO-2505), for the
 * approval request: the guard's own finding (a credential read, an
 * encoded command) with its confidence, and a write by the command into
 * a shell startup file, the SSH folder or a credential file in home
 * (`sensitive-write-targets.ts`, the same list `os.fs.write` uses).
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

export function shellSecurityCheck(
  verdict: GuardVerdict,
  targetPaths: readonly string[],
  cwd: string,
): ShellSecurityCheck {
  const sensitive = sensitiveWriteTargets(targetPaths, cwd);
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
