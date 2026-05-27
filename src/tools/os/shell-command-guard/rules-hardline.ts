import type { GuardVerdict, NormalisedCommand, Rule } from "./guard-types.js";

interface PatternRule {
  id: string;
  regex: RegExp;
  reason: string;
}

const HARDLINE_PATTERNS: readonly PatternRule[] = [
  {
    id: "hardline.rm_root",
    regex:
      /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)\s+\/(?:\s|$)/,
    reason: "recursive delete of filesystem root",
  },
  {
    id: "hardline.rm_root_glob",
    regex: /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/\*/,
    reason: "recursive delete of /*",
  },
  {
    id: "hardline.rm_home",
    regex:
      /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(?:~|\$home)(?:\s|$|\/)/,
    reason: "recursive delete of home directory",
  },
  {
    id: "hardline.mkfs",
    regex: /\bmkfs(?:\.[a-z0-9]+)?\b/,
    reason: "filesystem format",
  },
  {
    id: "hardline.dd_block",
    regex: /\bdd\b.*\bof=\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+n\d+|disk\d+)/,
    reason: "raw block device write via dd",
  },
  {
    id: "hardline.fork_bomb",
    regex: /:\s*\(\s*\)\s*\{.*:\s*\|:\s*&.*\}\s*;:/,
    reason: "fork bomb",
  },
  {
    id: "hardline.shutdown",
    regex: /\b(?:shutdown|reboot|halt|poweroff)\b/,
    reason: "host power state change",
  },
  {
    id: "hardline.raw_device_redirect",
    regex: />\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+n\d+|disk\d+)/,
    reason: "redirect into raw block device",
  },
];

export const hardlineRule: Rule = {
  id: "hardline",
  layer: "hardline",
  match(input) {
    return matchPattern(input, HARDLINE_PATTERNS, "block");
  },
};

function matchPattern(
  input: NormalisedCommand,
  patterns: readonly PatternRule[],
  action: "block",
): GuardVerdict | null {
  for (const pattern of patterns) {
    if (pattern.regex.test(input.joinedLower)) {
      return {
        action,
        rule: pattern.id,
        reason: pattern.reason,
      };
    }
  }
  return null;
}
