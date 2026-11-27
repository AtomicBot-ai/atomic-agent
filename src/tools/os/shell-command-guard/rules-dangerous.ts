import type { GuardInput, GuardVerdict, NormalisedCommand, Rule } from "./guard-types.js";
import {
  ASK_EVERY_LEVEL_CONFIDENCE,
  argScanVerdict,
  type ArgScanFinding,
} from "./arg-scan-finding.js";
import { matchDangerousArgv } from "./rules-dangerous-argv.js";
import { matchCredentialRead } from "./rules-credentials.js";
import { matchEncodedExec } from "./rules-encoded-exec.js";
import { matchWindowsCredentialRead } from "./rules-credentials-windows.js";
import { matchWindowsEncodedExec } from "./rules-encoded-exec-windows.js";
import { matchHomeArchive } from "./rules-home-archive.js";
import { matchInlineHomeCode } from "./rules-inline-home-code.js";
import { nestedCommandLines } from "./nested-command-lines.js";
import { matchCredentialCommand } from "./rules-credential-commands.js";
import { matchEncodedExecFile } from "./rules-encoded-exec-file.js";

interface PatternRule {
  id: string;
  regex: RegExp;
  reason: string;
  /**
   * Tested against the line as written rather than lowercased, for a
   * rule where case changes the meaning (`chmod -R` recurses, `chmod
   * -r` removes read permission).
   */
  caseSensitive?: true;
}

const DANGEROUS_PATTERNS: readonly PatternRule[] = [
  {
    id: "dangerous.rm_recursive",
    regex: /\brm\s+(?:-[a-z]*r[a-z]*|--recursive)\b/,
    reason: "recursive remove",
  },
  {
    id: "dangerous.rm_force",
    regex: /\brm\s+(?:-[a-z]*f[a-z]*|--force)\b/,
    reason: "force remove",
  },
  {
    id: "dangerous.chmod_world",
    regex: /\bchmod\s+(?:-[^\s]+\s+)*(?:777|666)\b/,
    reason: "permissive chmod",
  },
  // `-R` anywhere in the same command (GNU takes options after the
  // mode/owner too: `chmod 755 -R dir`), bundled (`-Rv`), or the long
  // `--recursive` and its abbreviations. `[^;&|\n]*` keeps the match
  // inside one command of a compound line. Case-sensitive: a lowercase
  // `-r` is the mode "remove read" (`chmod -r f`), not recursion.
  {
    id: "dangerous.chmod_recursive",
    regex: /\bchmod\b[^;&|\n]*\s(?:-[A-Za-z]*R[A-Za-z]*|--rec[a-z]*)(?=\s|$)/,
    reason: "recursive chmod",
    caseSensitive: true,
  },
  {
    id: "dangerous.chown_recursive",
    regex:
      /\bch(?:own|grp)\b[^;&|\n]*\s(?:-[a-z]*r[a-z]*|--rec[a-z]*)(?=\s|$)/,
    reason: "recursive chown",
  },
  {
    id: "dangerous.curl_pipe_sh",
    regex: /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh|python|python3)\b/,
    reason: "pipe download into interpreter",
  },
  // `bash <(curl …)`, `bash < <(curl …)`, `source <(wget …)`: the same
  // download-and-run as a pipe, through process substitution.
  {
    id: "dangerous.curl_process_substitution",
    regex:
      /(?:^|[\s;&|(])(?:sh|bash|zsh|dash|ksh|python|python3|source|\.)\s+(?:-\S+\s+)*(?:<\s*)?<\(\s*(?:curl|wget)\b/,
    reason: "run a download through process substitution",
  },
  // Only the start of the line here, so a quoted mention (`git commit
  // -m "run sh -c x"`) is not one. A nested shell anywhere else (`cd x
  // && bash -c …`, `env bash -lc …`, inside `$(…)`) is read from the
  // parsed words in rules-dangerous-argv.ts (`matchNestedShell`).
  {
    id: "dangerous.shell_dash_c",
    regex: /^(?:bash|sh|zsh|dash|ksh)\s+(?:-c|--command)\b/,
    reason: "nested shell command",
  },
  {
    id: "dangerous.eval",
    regex: /\beval\b/,
    reason: "eval execution",
  },
  {
    id: "dangerous.sudo",
    regex: /\bsudo\b/,
    reason: "privilege escalation",
  },
  // git (force push, hard reset, clean -f, checkout/restore of the
  // whole tree, branch -D) and find -delete / -exec rm are matched on
  // parsed words in rules-dangerous-argv.ts, after these patterns.
  {
    id: "dangerous.drop_table",
    regex: /\bdrop\s+table\b/,
    reason: "destructive SQL",
  },
  {
    id: "dangerous.npm_mutation",
    regex: /\bnpm\s+(?:uninstall|unpublish)\b/,
    reason: "package mutation",
  },
  // Windows destructive operations (require approval, not outright block).
  {
    id: "dangerous.win_del_recursive",
    regex: /\b(?:del|erase)\b.*\s\/(?:s|q)\b/,
    reason: "recursive or forced delete",
  },
  {
    id: "dangerous.win_rmdir_recursive",
    regex: /\b(?:rd|rmdir)\b.*\s\/s\b/,
    reason: "recursive directory delete",
  },
  {
    id: "dangerous.win_remove_item_recurse",
    regex: /\bremove-item\b.*-recurse/,
    reason: "recursive PowerShell remove",
  },
  {
    id: "dangerous.win_remove_item_force",
    regex: /\bremove-item\b.*-force/,
    reason: "forced PowerShell remove",
  },
  {
    id: "dangerous.win_reg_delete",
    regex: /\breg\s+delete\b/,
    reason: "registry deletion",
  },
  {
    id: "dangerous.win_takeown",
    regex: /\btakeown\b/,
    reason: "take ownership",
  },
  {
    id: "dangerous.win_icacls_grant",
    regex: /\bicacls\b.*\/grant/,
    reason: "ACL modification",
  },
  {
    id: "dangerous.win_net_user",
    regex: /\bnet\s+user\b.*\/(?:add|delete)/,
    reason: "user account mutation",
  },
  {
    id: "dangerous.win_ps_download_exec",
    regex:
      /\b(?:iwr|invoke-webrequest|curl|wget)\b.*\|\s*(?:iex|invoke-expression)\b/,
    reason: "download piped into PowerShell",
  },
];

/**
 * The dangerous layer. `threshold` is the live
 * `agent.security.argScanThreshold` (ATO-2505); absent, or a value that
 * is not a number in 0.5..1, reads as `ASK_EVERY_LEVEL_CONFIDENCE`, and
 * so does a value above it.
 */
export function buildDangerousRule(threshold?: () => number): Rule {
  return {
    id: "dangerous",
    layer: "dangerous",
    match: (input, raw) => matchDangerous(input, raw, readThreshold(threshold)),
  };
}

export const dangerousRule: Rule = buildDangerousRule();

function readThreshold(threshold: (() => number) | undefined): number {
  if (threshold === undefined) return ASK_EVERY_LEVEL_CONFIDENCE;
  try {
    const value = threshold();
    const valid = Number.isFinite(value) && value >= 0.5 && value <= 1;
    // Above the default it reads as the default: the setting only makes
    // the check stricter (review round 1 of ATO-2505).
    return valid ? Math.min(value, ASK_EVERY_LEVEL_CONFIDENCE) : ASK_EVERY_LEVEL_CONFIDENCE;
  } catch {
    return ASK_EVERY_LEVEL_CONFIDENCE;
  }
}

function matchDangerous(
  input: NormalisedCommand,
  raw: GuardInput,
  threshold: number,
): GuardVerdict | null {
  // Credential reads and encoded commands first: they carry a
  // confidence and, above the threshold, ask at every level (ATO-2126),
  // so a `sudo` or `eval` on the same line must not shadow them.
  const finding = argScanFinding(input, raw, 0);
  if (finding !== null) return argScanVerdict(finding, threshold);
  for (const pattern of DANGEROUS_PATTERNS) {
    const line = pattern.caseSensitive ? input.joined : input.joinedLower;
    if (pattern.regex.test(line)) {
      return {
        action: "approval_required",
        rule: pattern.id,
        reason: pattern.reason,
        confidence: 1,
      };
    }
  }
  return withFullConfidence(matchDangerousArgv(input));
}

/** How deep `sh -c "bash -c '...'"` is read. */
const MAX_NESTED_DEPTH = 4;

/**
 * Every argument-pattern finding of the line, the strongest first:
 * POSIX and Windows credential reads and encoded commands (ATO-2126,
 * ATO-2728), a whole home folder packed or copied and inline code that
 * builds a credential path (ATO-2730), a command that prints a saved
 * credential and a decoded file that is then run (ATO-2505), and the
 * same again for each line
 * a nested `sh -c` or `eval` runs (ATO-2730).
 */
function argScanFinding(
  input: NormalisedCommand,
  raw: GuardInput,
  depth: number,
): ArgScanFinding | null {
  let best = strongestFinding(
    matchCredentialRead(input, raw),
    matchEncodedExec(input),
    matchWindowsCredentialRead(input),
    matchWindowsEncodedExec(input),
    matchHomeArchive(input, raw),
    matchInlineHomeCode(input),
    matchCredentialCommand(input),
    matchEncodedExecFile(input),
  );
  if (depth >= MAX_NESTED_DEPTH) return best;
  for (const inner of nestedCommandLines(input, raw.cwd)) {
    best = strongestFinding(best, argScanFinding(inner, raw, depth + 1));
  }
  return best;
}

function strongestFinding(
  ...findings: (ArgScanFinding | null)[]
): ArgScanFinding | null {
  let best: ArgScanFinding | null = null;
  for (const finding of findings) {
    if (finding !== null && (best === null || finding.confidence > best.confidence)) {
      best = finding;
    }
  }
  return best;
}

/** An exact argv match is sure of what it names. */
function withFullConfidence(verdict: GuardVerdict | null): GuardVerdict | null {
  return verdict === null ? null : { ...verdict, confidence: 1 };
}
