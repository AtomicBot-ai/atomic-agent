import type { FileOutline, OutlineSymbol } from "./outline-types.js";

/**
 * Which files and symbols matter most, from references alone.
 *
 * The idea is aider's repo map, written fresh: a file that mentions an
 * identifier another file defines "points at" that file. Edges are
 * weighted by how often the name is used (square-rooted, so one chatty
 * file cannot dominate) and discounted for names defined in many places
 * (`get`, `run`, `init`: they link everything to everything) or marked
 * private by convention. A short personalised PageRank over that graph
 * ranks files; a symbol then gets its file's rank split by the share of
 * incoming weight that came through its name. `focus` (files the user is
 * working on, names they mentioned) tilts both towards what they asked
 * about.
 */

export interface RankInput {
  path: string;
  outline: FileOutline;
}

export interface RankFocus {
  /** Relative paths to centre the ranking on. */
  files?: ReadonlySet<string>;
  /** Identifiers to boost (mentioned by the user). */
  idents?: ReadonlySet<string>;
}

export interface RankedSymbol {
  symbol: OutlineSymbol;
  score: number;
}

export interface RankedFile {
  path: string;
  rank: number;
  /** Every symbol of the file, best first. */
  symbols: RankedSymbol[];
  lineCount: number;
}

const DAMPING = 0.85;
const ITERATIONS = 30;
/** A name defined in more files than this links too much to mean anything. */
const COMMON_DEFINITION_FILES = 5;

function identWeight(ident: string, definers: number, focusIdents: ReadonlySet<string>): number {
  let w = 1;
  if (focusIdents.has(ident)) w *= 10;
  if (ident.startsWith("_")) w *= 0.1;
  if (definers > COMMON_DEFINITION_FILES) w *= 0.1;
  // Long, specific names (`buildToolViewTool`, `parse_config`) say more
  // about a dependency than short ones.
  if (ident.length >= 8 && (/[a-z][A-Z]/.test(ident) || ident.includes("_"))) w *= 2;
  return w;
}

export function rankFiles(inputs: readonly RankInput[], focus: RankFocus = {}): RankedFile[] {
  const focusFiles = focus.files ?? new Set<string>();
  const focusIdents = focus.idents ?? new Set<string>();
  const n = inputs.length;
  if (n === 0) return [];
  const index = new Map(inputs.map((f, i) => [f.path, i] as const));

  // Who defines each name.
  const definers = new Map<string, number[]>();
  inputs.forEach((file, i) => {
    const seen = new Set<string>();
    for (const s of file.outline.symbols) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const list = definers.get(s.name);
      if (list) list.push(i);
      else definers.set(s.name, [i]);
    }
  });

  // edges[from] : Map<to, weight>; incoming[to] : Map<ident, weight>
  const edges: Map<number, number>[] = inputs.map(() => new Map());
  const incoming: Map<string, number>[] = inputs.map(() => new Map());
  inputs.forEach((file, from) => {
    for (const [ident, count] of file.outline.mentions) {
      const defs = definers.get(ident);
      if (!defs) continue;
      const w = Math.sqrt(count) * identWeight(ident, defs.length, focusIdents);
      for (const to of defs) {
        if (to === from) continue;
        edges[from]!.set(to, (edges[from]!.get(to) ?? 0) + w);
        incoming[to]!.set(ident, (incoming[to]!.get(ident) ?? 0) + w);
      }
    }
  });

  // Personalisation: the focus files, the files defining focus names, or
  // everyone alike.
  const personal = new Array<number>(n).fill(0);
  for (const path of focusFiles) {
    const i = index.get(path);
    if (i !== undefined) personal[i] = 1;
  }
  for (const ident of focusIdents) {
    for (const i of definers.get(ident) ?? []) personal[i] = (personal[i] ?? 0) + 1;
  }
  let total = personal.reduce((a, b) => a + b, 0);
  if (total === 0) {
    personal.fill(1);
    total = n;
  }
  for (let i = 0; i < n; i++) personal[i] = personal[i]! / total;

  const outWeight = edges.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  let rank = personal.slice();
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = personal.map((p) => (1 - DAMPING) * p);
    let dangling = 0;
    for (let from = 0; from < n; from++) {
      const r = rank[from]!;
      const out = outWeight[from]!;
      if (out === 0) {
        dangling += r;
        continue;
      }
      for (const [to, w] of edges[from]!) next[to] = next[to]! + (DAMPING * r * w) / out;
    }
    if (dangling > 0) for (let i = 0; i < n; i++) next[i] = next[i]! + DAMPING * dangling * personal[i]!;
    rank = next;
  }

  const ranked: RankedFile[] = inputs.map((file, i) => {
    const inWeights = incoming[i]!;
    const inTotal = [...inWeights.values()].reduce((a, b) => a + b, 0);
    const symbols = file.outline.symbols.map((symbol) => {
      const share = inTotal > 0 ? (inWeights.get(symbol.name) ?? 0) / inTotal : 0;
      let score = rank[i]! * (share + 0.01);
      if (symbol.exported) score *= 1.5;
      if (symbol.depth === 0) score *= 1.2;
      if (focusIdents.has(symbol.name)) score *= 10;
      return { symbol, score };
    });
    symbols.sort((a, b) => b.score - a.score || a.symbol.line - b.symbol.line);
    return { path: file.path, rank: rank[i]!, symbols, lineCount: file.outline.lineCount };
  });
  ranked.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
  return ranked;
}
