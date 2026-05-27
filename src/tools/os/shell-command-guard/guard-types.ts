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

export type GuardLayer = "hardline" | "dangerous" | "trusted" | "safe-allow";

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
