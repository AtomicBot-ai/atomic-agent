import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelProfile } from "../model-profile.js";

function resolveDefaultGrammarsDir(): string {
  const nextToBinary = join(dirname(process.execPath), "grammars");
  if (existsSync(nextToBinary)) {
    return nextToBinary;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../grammars");
}

export async function buildGrammar(
  profile: ModelProfile,
  grammarsDir = resolveDefaultGrammarsDir(),
): Promise<string> {
  const baseGrammar = await readFile(join(grammarsDir, "tool-call.gbnf"), "utf8");
  if (!profile.allowThinkPrelude || profile.reasoningStyle === "none") return baseGrammar;
  const ruleStem = profile.id === "gemma4-think" ? "channel" : "think";
  const rootRule = `root ::= ${ruleStem}-prelude tool-call`;
  const withPreludeRoot = baseGrammar.replace(/^root ::= .*$/m, rootRule);
  const preludeRules = buildUntilSentinelRules(ruleStem, profile.reasoningCloseTag);
  return `${withPreludeRoot.trimEnd()}\n${preludeRules}\n`;
}

function buildUntilSentinelRules(ruleStem: string, sentinel: string): string {
  const preludeRule = `${ruleStem}-prelude`;
  const bodyRule = `${ruleStem}-body`;
  const fragmentRule = `${ruleStem}-fragment`;
  const fragments = [`[^${escapeCharClass(sentinel[0]!)}]+`];

  for (let idx = 0; idx < sentinel.length - 1; idx += 1) {
    const prefix = sentinel.slice(0, idx + 1);
    const nextChar = sentinel[idx + 1]!;
    fragments.push(`${quoteGbnf(prefix)} [^${escapeCharClass(nextChar)}]`);
  }

  return [
    `${preludeRule} ::= ${bodyRule} ${quoteGbnf(sentinel)} ws`,
    `${bodyRule} ::= ${fragmentRule}*`,
    `${fragmentRule} ::= ${fragments.join(" | ")}`,
  ].join("\n");
}

function quoteGbnf(text: string): string {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function escapeCharClass(char: string): string {
  return char.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/-/g, "\\-");
}
