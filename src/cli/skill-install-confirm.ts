import { createInterface } from "node:readline/promises";

import type { SkillScanResult } from "../skills/index.js";

/**
 * Interactive confirmation for `skill install` when the security scan
 * says `caution`. Only a real terminal gets asked: without a TTY on both
 * stdin and stdout there is nobody to answer, so no callback is returned
 * and the install gate refuses unless `--yes` was passed.
 */
export interface InstallConfirmDeps {
  /** Defaults to stdin *and* stdout being a TTY. */
  isTTY?: () => boolean;
  /** Free-text prompt. Defaults to a readline question. */
  ask?: (prompt: string) => Promise<string>;
  writeErr?: (text: string) => void;
}

export function createInstallConfirm(
  deps: InstallConfirmDeps = {},
): ((scan: SkillScanResult) => Promise<boolean>) | undefined {
  const isTTY =
    deps.isTTY ??
    (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY()) return undefined;
  const ask = deps.ask ?? defaultAsk;
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  return async (scan) => {
    writeErr(formatScanFindings(scan));
    const answer = await ask("Install this skill anyway? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  };
}

/** Findings block printed before the prompt and on a refused install. */
export function formatScanFindings(scan: SkillScanResult): string {
  const lines = [`security scan: ${scan.verdict}`];
  for (const f of scan.findings) {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    lines.push(`  [${f.severity}] ${f.rule}  ${where}  ${f.excerpt}`);
  }
  return `${lines.join("\n")}\n`;
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
