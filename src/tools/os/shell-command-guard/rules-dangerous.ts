import type { Rule } from "./guard-types.js";

interface PatternRule {
  id: string;
  regex: RegExp;
  reason: string;
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
  {
    id: "dangerous.chmod_recursive",
    regex: /\bchmod\s+-[a-z]*r[a-z]*\b/,
    reason: "recursive chmod",
  },
  {
    id: "dangerous.chown_recursive",
    regex: /\bchown\s+-[a-z]*r[a-z]*\b/,
    reason: "recursive chown",
  },
  {
    id: "dangerous.curl_pipe_sh",
    regex: /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh|python|python3)\b/,
    reason: "pipe download into interpreter",
  },
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
  {
    id: "dangerous.git_force_push",
    regex: /\bgit\s+push\b.*(?:^|\s)(?:--force|-f)(?:\s|$)/,
    reason: "force push",
  },
  {
    id: "dangerous.git_reset_hard",
    regex: /\bgit\s+reset\s+--hard\b/,
    reason: "hard reset",
  },
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
    regex: /\b(?:iwr|invoke-webrequest|curl|wget)\b.*\|\s*(?:iex|invoke-expression)\b/,
    reason: "download piped into PowerShell",
  },
];

export const dangerousRule: Rule = {
  id: "dangerous",
  layer: "dangerous",
  match(input) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.regex.test(input.joinedLower)) {
        return {
          action: "approval_required",
          rule: pattern.id,
          reason: pattern.reason,
        };
      }
    }
    return null;
  },
};
