import { createInterface } from "node:readline/promises";

import type { PluginInstallReport } from "../plugins/index.js";

/**
 * Terminal side of plugin install safety: print what changed and what
 * would run, and ask once per package whether that code may run. Only a
 * real terminal is asked; without one no callback is returned and the
 * plugin installs with its code-running parts off (`--accept-code` or
 * `plugin allow-code` turn them on).
 */
export interface CodeConsentDeps {
  isTTY?: () => boolean;
  ask?: (prompt: string) => Promise<string>;
  writeErr?: (text: string) => void;
}

export function createCodeConsentPrompt(deps: CodeConsentDeps = {}): ((report: PluginInstallReport) => Promise<boolean>) | undefined {
  const isTTY = deps.isTTY ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY()) return undefined;
  const ask = deps.ask ?? defaultAsk;
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  return async (report) => {
    writeErr(formatCodeQuestion(report));
    const answer = await ask(`Allow all of this for ${report.name} on this computer? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

/** The block shown before the question: exactly what would run. */
export function formatCodeQuestion(report: PluginInstallReport): string {
  const lines = [
    report.diff.codeChanged && !report.diff.fresh
      ? `${report.name}@${report.version} changed what it runs or which keys it gets, so it needs your OK again.`
      : `${report.name}@${report.version} can run programs on this computer or receive your keys:`,
    ...report.code.map(l => `  - ${l}`),
    "Say no to install it with these parts off; skills and remote servers without keys still work.",
    "You can allow them later with: atomic-agent plugin allow-code " + report.name,
  ];
  return `${lines.join("\n")}\n`;
}

/** Printed on update / --force before any question: the permission diff in plain words. */
export function formatPermissionChanges(report: PluginInstallReport): string {
  if (report.diff.fresh || report.changes.length === 0) return "";
  return `Changes in ${report.name}@${report.version}:\n${report.changes.map(l => `  - ${l}`).join("\n")}\n`;
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
