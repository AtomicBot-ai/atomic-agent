export type GuardAction = "allow" | "approval_required" | "block";

export interface GuardVerdict {
  action: GuardAction;
  rule: string;
  reason: string;
  /**
   * How sure the rule is that the command does what it names, 0..1.
   * Set on every `dangerous.*` verdict: 1 for an exact pattern, lower
   * for a heuristic (a project `.env` read). Absent reads as 1.
   */
  confidence?: number;
  /**
   * The approval gate asks about this command at every level, bypass
   * (level 5) included: a credential read or an encoded command at or
   * above `ASK_EVERY_LEVEL_CONFIDENCE` (`arg-scan-finding.ts`, ATO-2126).
   * Hardline rules block instead; this is their ask-only sibling.
   */
  askEveryLevel?: true;
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
  /**
   * `agent.security.argScanThreshold` (ATO-2505), read live: the
   * confidence at or above which an argument finding asks at every
   * level. Absent reads as `ASK_EVERY_LEVEL_CONFIDENCE`.
   */
  argScanThreshold?: () => number;
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
