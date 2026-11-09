import { estimateTokensFromCounts } from "../../../prompt/token-budget.js";
import type { RankedFile } from "./code-map-rank.js";
import type { FileOutline } from "./outline-types.js";

/** Symbols printed per file in the project map, before the budget says stop. */
export const SYMBOLS_PER_FILE = 8;

/** A token counter for a growing block, priced like `estimateTokens`. */
class Packer {
  private chars = 0;
  private words = 0;
  readonly lines: string[] = [];
  constructor(private readonly budget: number) {}

  /** Add `block` if it fits; returns whether it did. */
  tryAdd(block: readonly string[]): boolean {
    let chars = this.chars;
    let words = this.words;
    for (const line of block) {
      chars += line.length + 1;
      words += line.trim().split(/\s+/).filter(Boolean).length;
    }
    if (estimateTokensFromCounts(chars, words) > this.budget) return false;
    this.chars = chars;
    this.words = words;
    this.lines.push(...block);
    return true;
  }

  get tokens(): number {
    return estimateTokensFromCounts(this.chars, this.words);
  }
}

function symbolLine(line: number, depth: 0 | 1, signature: string): string {
  return `${depth === 1 ? "    " : "  "}L${line} ${signature}`;
}

export interface RenderedMap {
  text: string;
  filesShown: number;
  filesTotal: number;
  tokens: number;
}

/**
 * The project map: files best-ranked first, each with up to
 * {@link SYMBOLS_PER_FILE} of its best symbols printed in source order
 * (members indented under their class). Stops at the first file that
 * would cross `maxTokens`, then tries a path-only line for a few more so
 * the model still learns they exist.
 */
export function renderProjectMap(ranked: readonly RankedFile[], maxTokens: number): RenderedMap {
  const packer = new Packer(maxTokens);
  let shown = 0;
  let pathOnly = 0;
  for (const file of ranked) {
    if (file.symbols.length === 0) continue;
    const picked = file.symbols.slice(0, SYMBOLS_PER_FILE).map((s) => s.symbol);
    picked.sort((a, b) => a.line - b.line);
    const more = file.symbols.length - picked.length;
    const head = more > 0 ? `${file.path} (+${more} more)` : file.path;
    const block = [head, ...picked.map((s) => symbolLine(s.line, s.depth, s.signature))];
    if (pathOnly === 0 && packer.tryAdd(block)) {
      shown++;
      continue;
    }
    // Out of room for full blocks: name the next few files only.
    if (pathOnly >= 10 || !packer.tryAdd([`${file.path} (${file.symbols.length} symbols)`])) break;
    pathOnly++;
    shown++;
  }
  const withSymbols = ranked.filter((f) => f.symbols.length > 0).length;
  return { text: packer.lines.join("\n"), filesShown: shown, filesTotal: withSymbols, tokens: packer.tokens };
}

/** One file's skeleton: every symbol in source order with its line, within the budget. */
export function renderFileOutline(path: string, outline: FileOutline, maxTokens: number): RenderedMap {
  const packer = new Packer(maxTokens);
  packer.tryAdd([`${path} (${outline.lineCount} lines, ${outline.symbols.length} symbols)`]);
  let shown = 0;
  for (const s of outline.symbols) {
    if (!packer.tryAdd([symbolLine(s.line, s.depth, s.signature)])) break;
    shown++;
  }
  return { text: packer.lines.join("\n"), filesShown: shown, filesTotal: outline.symbols.length, tokens: packer.tokens };
}
