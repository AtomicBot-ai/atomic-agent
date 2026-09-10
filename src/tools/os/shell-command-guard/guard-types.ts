export type GuardAction = "allow" | "approval_required" | "block";

export interface GuardVerdict {
  action: GuardAction;
  rule: string;
  reason: string;
}

export interface GuardInput {
  cmd: string;
  rawArgs: readonly string[];
  cwd: string;
}

export interface NormalisedCommand {
  cmd: string;
  cmdOriginal: string;
  args: readonly string[];
  joined: string;
  joinedLower: string;
}

/**
 * Rule layers, in evaluation order. `policy` sits between the hardline
 * and dangerous layers: it carries operator-configured refusals (today
 * the git remote-sync switch) that block regardless of the approval
 * level, exactly like hardline rules, but are only present when the
 * runtime injects a `ShellGuardPolicy`.
 */
export type GuardLayer =
  | "hardline"
  | "policy"
  | "dangerous"
  | "trusted"
  | "safe-allow";

/**
 * Operator policy the bootstrap injects into the shell guard. Kept as
 * predicates so the guard never reads config itself and a live toggle
 * (the Integrations hub flips `git.remoteSync` without a restart) is
 * honoured on the very next command.
 */
export interface ShellGuardPolicy {
  /** `false` refuses every network git verb through the shell. */
  isGitRemoteSyncEnabled: () => boolean;
}

export interface Rule {
  id: string;
  layer: GuardLayer;
  match(input: NormalisedCommand, raw: GuardInput): GuardVerdict | null;
}

export class ShellGuardBlockError extends Error {
  constructor(
    public readonly rule: string,
    public readonly reason: string,
  ) {
    super(`shell guard blocked: ${rule} - ${reason}`);
    this.name = "ShellGuardBlockError";
  }
}
