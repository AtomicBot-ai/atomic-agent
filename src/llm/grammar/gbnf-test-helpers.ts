/**
 * A small GBNF interpreter for tests: does `rule` of `grammar` accept
 * exactly `input`? The real thing is llama.cpp's sampler, which reads
 * the same text; this lets a test pin the LANGUAGE a grammar edit
 * produces (which strings it admits) rather than only its bytes.
 *
 * Covers the subset `grammars/tool-call.gbnf` and `buildGrammar` use:
 * `"literals"` with escapes, `[character classes]`, `|`, `( groups )`,
 * `?` `*` `+` `{m,n}` repetition, rule references and `#` comments. A
 * set-of-end-positions matcher, so ambiguity and backtracking are free;
 * inputs are short. Left recursion is guarded, not supported.
 */

type Elem =
  | { kind: "lit"; text: string }
  | { kind: "class"; negate: boolean; ranges: Array<[number, number]> }
  | { kind: "ref"; name: string }
  | { kind: "group"; alts: Seq[] };

interface Item {
  elem: Elem;
  min: number;
  max: number;
}

type Seq = Item[];
export type GbnfRules = Map<string, Seq[]>;

type Token =
  | { kind: "name"; text: string }
  | { kind: "assign" }
  | { kind: "lit"; text: string }
  | { kind: "class"; negate: boolean; ranges: Array<[number, number]> }
  | { kind: "punct"; text: "(" | ")" | "|" | "?" | "*" | "+" }
  | { kind: "repeat"; min: number; max: number };

/** True when `rule` of `grammar` matches all of `input`. */
export function gbnfAccepts(
  grammar: string,
  rule: string,
  input: string,
): boolean {
  const rules = parseGbnf(grammar);
  if (!rules.has(rule)) throw new Error(`no rule named ${rule}`);
  return new Matcher(rules, input).rule(rule, 0).has(input.length);
}

export function parseGbnf(grammar: string): GbnfRules {
  const tokens = tokenize(grammar);
  const rules: GbnfRules = new Map();
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const atRuleStart = (): boolean =>
    tokens[i]?.kind === "name" && tokens[i + 1]?.kind === "assign";

  const parseAlternates = (): Seq[] => {
    const alts = [parseSequence()];
    while (peek()?.kind === "punct" && (peek() as { text: string }).text === "|") {
      i += 1;
      alts.push(parseSequence());
    }
    return alts;
  };

  const parseSequence = (): Seq => {
    const items: Seq = [];
    for (;;) {
      const token = peek();
      if (token === undefined || atRuleStart()) break;
      if (token.kind === "punct" && (token.text === ")" || token.text === "|"))
        break;
      let elem: Elem;
      if (token.kind === "lit") {
        elem = { kind: "lit", text: token.text };
        i += 1;
      } else if (token.kind === "class") {
        elem = { kind: "class", negate: token.negate, ranges: token.ranges };
        i += 1;
      } else if (token.kind === "name") {
        elem = { kind: "ref", name: token.text };
        i += 1;
      } else if (token.kind === "punct" && token.text === "(") {
        i += 1;
        const alts = parseAlternates();
        const close = peek();
        if (close?.kind !== "punct" || close.text !== ")")
          throw new Error("expected )");
        i += 1;
        elem = { kind: "group", alts };
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
      let min = 1;
      let max = 1;
      const rep = peek();
      if (rep?.kind === "punct" && rep.text === "?") {
        min = 0;
        i += 1;
      } else if (rep?.kind === "punct" && rep.text === "*") {
        min = 0;
        max = Infinity;
        i += 1;
      } else if (rep?.kind === "punct" && rep.text === "+") {
        max = Infinity;
        i += 1;
      } else if (rep?.kind === "repeat") {
        min = rep.min;
        max = rep.max;
        i += 1;
      }
      items.push({ elem, min, max });
    }
    return items;
  };

  while (i < tokens.length) {
    const name = tokens[i];
    if (name?.kind !== "name" || tokens[i + 1]?.kind !== "assign")
      throw new Error(`expected a rule at token ${i}`);
    i += 2;
    rules.set(name.text, parseAlternates());
  }
  return rules;
}

function tokenize(grammar: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readEscape = (): number => {
    // `i` is on the char after the backslash.
    const c = grammar[i]!;
    i += 1;
    switch (c) {
      case "n":
        return 10;
      case "r":
        return 13;
      case "t":
        return 9;
      case "x":
        return readHex(2);
      case "u":
        return readHex(4);
      case "U":
        return readHex(8);
      default:
        return c.codePointAt(0)!;
    }
  };
  const readHex = (digits: number): number => {
    const code = parseInt(grammar.slice(i, i + digits), 16);
    i += digits;
    return code;
  };
  while (i < grammar.length) {
    const c = grammar[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
    } else if (c === "#") {
      while (i < grammar.length && grammar[i] !== "\n") i += 1;
    } else if (grammar.startsWith("::=", i)) {
      tokens.push({ kind: "assign" });
      i += 3;
    } else if (/[a-zA-Z]/.test(c)) {
      const match = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(grammar.slice(i))!;
      tokens.push({ kind: "name", text: match[0] });
      i += match[0].length;
    } else if (c === '"') {
      i += 1;
      let text = "";
      while (grammar[i] !== '"') {
        if (i >= grammar.length) throw new Error("unterminated literal");
        if (grammar[i] === "\\") {
          i += 1;
          text += String.fromCodePoint(readEscape());
        } else {
          text += grammar[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: "lit", text });
    } else if (c === "[") {
      i += 1;
      let negate = false;
      if (grammar[i] === "^") {
        negate = true;
        i += 1;
      }
      const ranges: Array<[number, number]> = [];
      const readOne = (): number => {
        if (grammar[i] === "\\") {
          i += 1;
          return readEscape();
        }
        const code = grammar.codePointAt(i)!;
        i += String.fromCodePoint(code).length;
        return code;
      };
      while (grammar[i] !== "]") {
        if (i >= grammar.length) throw new Error("unterminated class");
        const from = readOne();
        if (grammar[i] === "-" && grammar[i + 1] !== "]") {
          i += 1;
          ranges.push([from, readOne()]);
        } else {
          ranges.push([from, from]);
        }
      }
      i += 1;
      tokens.push({ kind: "class", negate, ranges });
    } else if (c === "{") {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(grammar.slice(i));
      if (match === null) throw new Error("bad repetition");
      const min = Number(match[1]);
      const max =
        match[2] === undefined
          ? min
          : match[3] === ""
            ? Infinity
            : Number(match[3]);
      tokens.push({ kind: "repeat", min, max });
      i += match[0].length;
    } else if ("()|?*+".includes(c)) {
      tokens.push({ kind: "punct", text: c as "(" });
      i += 1;
    } else {
      throw new Error(`unexpected ${JSON.stringify(c)} at ${i}`);
    }
  }
  return tokens;
}

class Matcher {
  private readonly memo = new Map<string, Set<number>>();
  private readonly active = new Set<string>();

  constructor(
    private readonly rules: GbnfRules,
    private readonly input: string,
  ) {}

  rule(name: string, pos: number): Set<number> {
    const key = `${name}@${pos}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    // Left recursion would loop; the grammars here have none.
    if (this.active.has(key)) return new Set();
    const alts = this.rules.get(name);
    if (alts === undefined) throw new Error(`undefined rule ${name}`);
    this.active.add(key);
    const out = this.alts(alts, pos);
    this.active.delete(key);
    this.memo.set(key, out);
    return out;
  }

  private alts(alts: Seq[], pos: number): Set<number> {
    const out = new Set<number>();
    for (const seq of alts) for (const end of this.seq(seq, pos)) out.add(end);
    return out;
  }

  private seq(seq: Seq, pos: number): Set<number> {
    let current = new Set<number>([pos]);
    for (const item of seq) {
      const next = new Set<number>();
      for (const p of current) for (const q of this.item(item, p)) next.add(q);
      current = next;
      if (current.size === 0) break;
    }
    return current;
  }

  private item(item: Item, pos: number): Set<number> {
    const out = new Set<number>();
    // Positions reached at a repetition count >= min: everything past
    // them is already accounted for, so a repeat of one stops the walk.
    const settled = new Set<number>();
    let frontier = new Set<number>([pos]);
    if (item.min === 0) {
      out.add(pos);
      settled.add(pos);
    }
    for (let reps = 1; reps <= item.max && frontier.size > 0; reps += 1) {
      const next = new Set<number>();
      for (const p of frontier) for (const q of this.elem(item.elem, p)) next.add(q);
      if (reps < item.min) {
        frontier = next;
        continue;
      }
      const fresh = new Set<number>();
      for (const q of next) {
        if (settled.has(q)) continue;
        settled.add(q);
        out.add(q);
        fresh.add(q);
      }
      frontier = fresh;
    }
    return out;
  }

  private elem(elem: Elem, pos: number): Set<number> {
    switch (elem.kind) {
      case "lit":
        return this.input.startsWith(elem.text, pos)
          ? new Set([pos + elem.text.length])
          : new Set();
      case "class": {
        if (pos >= this.input.length) return new Set();
        const code = this.input.codePointAt(pos)!;
        const inRange = elem.ranges.some(([lo, hi]) => code >= lo && code <= hi);
        return inRange !== elem.negate
          ? new Set([pos + String.fromCodePoint(code).length])
          : new Set();
      }
      case "ref":
        return this.rule(elem.name, pos);
      case "group":
        return this.alts(elem.alts, pos);
    }
  }
}
