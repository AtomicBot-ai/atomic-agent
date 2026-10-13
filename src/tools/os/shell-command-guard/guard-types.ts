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
 * runtime injects a `ShellGuardPolicy`. `user` sits between the trusted
 * read-only allows and safe-allow: user-configured deny/allow patterns
 * (config v77, `shellGuard.*`) that can only narrow what the engine
 * would otherwise do at that point — they fire after the built-in
 * dangerous decisions, so no pattern can talk the guard out of one.
 */
export type GuardLayer =
  | "hardline"
  | "policy"
  | "dangerous"
  | "trusted"
  | "user"
  | "safe-allow";

/**
 * The user's own shell-guard rules (issue #229). Patterns are dull
 * globs over the normalised command line, anchored at argv[0]:
 * `"npm run *"` matches `npm run` and anything after it, `"git status"`
 * matches exactly that. Stored in `config.json` under `shellGuard` —
 * this shape is what the guard sees, so the guard never reads config.
 */
export interface ShellGuardUserRules {
  /** Commands that must never run silently; they go to the approval ladder. */
  deny: readonly string[];
  /** Commands the operator pre-approves; they run without a prompt. */
  allow: readonly string[];
}

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
   * The user's own guard rules, read live (`/guard` writes config.json
   * and resets the config cache, so the next command sees the new
   * rules without a restart). Absent — embedders, unit tests — means
   * no user layer at all: the static rule set runs unchanged.
   */
  userGuardRules?: () => ShellGuardUserRules;
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
