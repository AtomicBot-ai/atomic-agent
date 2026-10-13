import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type ShellGuardConfig,
} from "../config/index.js";

/**
 * Persist the operator's shell-guard rules into `shellGuard`, then
 * invalidate the config cache so the next `getConfig()` — and through
 * the bootstrap's `userGuardRules` predicate, the very next shell
 * command — sees them. Same read → merge → validate → write → reset
 * shape as the other `persist-*` helpers. Only the `/guard` handler
 * calls this, never the reducer or a render path.
 */
export function persistShellGuardRules(shellGuard: ShellGuardConfig): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    shellGuard: {
      deny: [...shellGuard.deny],
      allow: [...shellGuard.allow],
    },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}

/**
 * The chat rendering of the live rule set: one line per rule, deny
 * first (they are the ones that stop a command). `"(none)"` when both
 * lists are empty, so a bare `/guard` never answers with silence.
 */
export function formatShellGuardRules(rules: ShellGuardConfig): string {
  const lines: string[] = [];
  for (const pattern of rules.deny) lines.push(`  deny   ${pattern}`);
  for (const pattern of rules.allow) lines.push(`  allow  ${pattern}`);
  if (lines.length === 0) {
    return "no shell guard rules — /guard add allow|deny <pattern> to add one";
  }
  return `shell guard rules (deny/allow, matched after the built-in dangerous rules):\n${lines.join("\n")}`;
}
