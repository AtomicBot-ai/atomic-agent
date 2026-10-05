import { homedir } from "node:os";

/**
 * Which shell a command line is written for. `posix` is `sh -c`'s line;
 * `cmd` is `cmd.exe /c`'s (`"` only, `^` escapes, `%VAR%`); `powershell`
 * is `-Command`'s (`'` and `"`, `#` comments, a backtick escape).
 */
export type ShellDialect = "posix" | "cmd" | "powershell";

/**
 * One word of a command line as the shell would pass it on: quotes
 * taken off, escapes applied, a leading `$HOME` / `${HOME}` expanded.
 * `dynamic` when part of it is only known when the line runs (another
 * variable, a glob, `%VAR%`, brace expansion, a quoted `~`).
 */
export interface ShellWord {
  text: string;
  dynamic: boolean;
}

/**
 * What the lexer hands on. A `redirect` is followed by the word it
 * applies to: `file` writes that file (`>`, `>>`, `&>`, `<>`); `dup`
 * names a descriptor when that word is digits or `-` (`2>&1`) and a
 * file otherwise (`>&out.log`); `none` reads it (`<`, `<<<`). A heredoc
 * (`<<EOF … EOF`) is consumed whole and leaves no token.
 */
export type ShellToken =
  | ({ kind: "word" } & ShellWord)
  | { kind: "separator" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "redirect"; writes: "file" | "dup" | "none" };

type Operator =
  | Exclude<ShellToken, { kind: "word" }>
  | { kind: "heredoc"; stripTabs: boolean };

const SEPARATOR: { kind: "separator" } = { kind: "separator" };
const WRITE: Operator = { kind: "redirect", writes: "file" };
const DUP: Operator = { kind: "redirect", writes: "dup" };
const READ: Operator = { kind: "redirect", writes: "none" };

/** Operators outside quotes, longest first so `&&` is not read as `&`. */
const OPERATORS: Record<ShellDialect, readonly (readonly [string, Operator])[]> = {
  posix: [
    ["&&", SEPARATOR],
    ["||", SEPARATOR],
    [";;", SEPARATOR],
    ["|&", SEPARATOR],
    ["&>>", WRITE],
    ["&>", WRITE],
    ["<<<", READ],
    ["<<-", { kind: "heredoc", stripTabs: true }],
    ["<<", { kind: "heredoc", stripTabs: false }],
    ["<>", WRITE],
    ["<&", READ],
    [">>", WRITE],
    [">|", WRITE],
    [">&", DUP],
    [">", WRITE],
    ["<", READ],
    [";", SEPARATOR],
    ["|", SEPARATOR],
    ["&", SEPARATOR],
    ["(", { kind: "open" }],
    [")", { kind: "close" }],
  ],
  // `;` is not a command separator in cmd.exe.
  cmd: [
    ["&&", SEPARATOR],
    ["||", SEPARATOR],
    [">>", WRITE],
    [">&", DUP],
    ["<&", READ],
    [">", WRITE],
    ["<", READ],
    ["|", SEPARATOR],
    ["&", SEPARATOR],
    ["(", { kind: "open" }],
    [")", { kind: "close" }],
  ],
  powershell: [
    ["&&", SEPARATOR],
    ["||", SEPARATOR],
    ["*>>", WRITE],
    ["*>", WRITE],
    [">>", WRITE],
    [">&", DUP],
    [">", WRITE],
    [";", SEPARATOR],
    ["|", SEPARATOR],
    ["&", SEPARATOR],
    ["(", { kind: "open" }],
    [")", { kind: "close" }],
  ],
};

/**
 * Split a command line into words and operators the way its shell
 * would, or `null` for a line this does not read: an unbalanced quote,
 * command substitution (`$(…)`, backticks), `${…}` other than
 * `${HOME}`, a redirect or heredoc with nothing after it. Operators,
 * newlines and `#` comments count only outside quotes; a quoted string
 * is part of one word; heredoc bodies are skipped.
 *
 * Deliberately small: it serves `shellWriteTargets`, whose caller asks
 * the user whenever this cannot say, so `null` is always a safe answer.
 */
export function lexShellLine(
  line: string,
  dialect: ShellDialect,
): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const operators = OPERATORS[dialect];
  const escape = dialect === "posix" ? "\\" : dialect === "cmd" ? "^" : null;
  const singleQuotes = dialect !== "cmd";
  const variables = dialect !== "cmd";
  let word = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  /** Set right after `<<`: the next word is a heredoc delimiter. */
  let pendingHeredoc: { stripTabs: boolean } | null = null;

  const endWord = (): void => {
    if (!inWord) return;
    if (pendingHeredoc !== null) {
      heredocs.push({ delimiter: word, ...pendingHeredoc });
      pendingHeredoc = null;
    } else {
      tokens.push({ kind: "word", text: word, dynamic });
    }
    word = "";
    inWord = false;
    quoted = false;
    dynamic = false;
  };
  /** Start a quoted part; a `~` that opens a word quoted is not home. */
  const openQuote = (first: string | undefined): void => {
    if (!inWord && first === "~") dynamic = true;
    quoted = true;
    inWord = true;
  };
  const appendDollar = (at: number): number | null => {
    const read = readDollar(line, at, word.length === 0);
    if (read === null) return null;
    word += read.text;
    dynamic ||= read.dynamic;
    inWord = true;
    return read.next;
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "\n") {
      endWord();
      if (pendingHeredoc !== null) return null;
      tokens.push(SEPARATOR);
      i = skipHeredocBodies(line, i + 1, heredocs);
      heredocs.length = 0;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
      continue;
    }
    if (escape !== null && c === escape) {
      const next = line[i + 1];
      if (next === undefined) return null;
      // A line continuation joins the two lines.
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    // POSIX command substitution; PowerShell's escape character.
    if (c === "`") return null;
    if (singleQuotes && c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      openQuote(line[i + 1]);
      word += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      openQuote(line[i + 1]);
      let j = i + 1;
      for (;;) {
        const d = line[j];
        if (d === undefined) return null;
        if (d === '"') break;
        if (d === "`") return null;
        if (dialect === "posix" && d === "\\") {
          const next = line[j + 1];
          if (next !== undefined && '"\\$`\n'.includes(next)) {
            if (next !== "\n") word += next;
            j += 2;
            continue;
          }
        }
        if (variables && d === "$") {
          const next = appendDollar(j);
          if (next === null) return null;
          j = next;
          continue;
        }
        if (dialect === "cmd" && d === "%") dynamic = true;
        word += d;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (variables && c === "$") {
      const next = appendDollar(i);
      if (next === null) return null;
      i = next;
      continue;
    }
    if (dialect !== "cmd" && c === "#" && !inWord) {
      const newline = line.indexOf("\n", i);
      i = newline === -1 ? line.length : newline;
      continue;
    }
    const match = operators.find(([text]) => line.startsWith(text, i));
    if (match !== undefined) {
      const [text, operator] = match;
      const redirect = operator.kind === "redirect" || operator.kind === "heredoc";
      // `2>err.txt`: a word of bare digits right before a redirect is
      // the descriptor it applies to, not a word of the command.
      if (redirect && inWord && !quoted && !dynamic && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      if (pendingHeredoc !== null) return null;
      if (operator.kind === "heredoc") {
        pendingHeredoc = { stripTabs: operator.stripTabs };
      } else {
        tokens.push(operator);
      }
      i += text.length;
      continue;
    }
    if (dialect === "posix" && /[*?[]/.test(c)) dynamic = true;
    // Brace expansion (`a{1,2}`); a lone `{` is the grouping keyword.
    if (dialect === "posix" && c === "{" && (inWord || !/^\s?$/.test(line[i + 1] ?? ""))) {
      dynamic = true;
    }
    if (dialect === "cmd" && c === "%") dynamic = true;
    word += c;
    inWord = true;
    i += 1;
  }
  endWord();
  if (pendingHeredoc !== null) return null;
  return tokens;
}

/**
 * A `$` at `at`: `$HOME` or `${HOME}` opening a word is the home
 * directory; another variable is kept as text and marks the word
 * dynamic; `$(` and any other `${` are not read (`null`); a `$` with
 * no name after it is a literal dollar.
 */
function readDollar(
  line: string,
  at: number,
  wordStart: boolean,
): { text: string; dynamic: boolean; next: number } | null {
  const next = line[at + 1];
  if (next === "(") return null;
  if (next === "{") {
    if (wordStart && line.startsWith("${HOME}", at)) {
      return { text: homedir(), dynamic: false, next: at + "${HOME}".length };
    }
    return null;
  }
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(at + 1))?.[0];
  if (name !== undefined) {
    if (wordStart && name === "HOME") {
      return { text: homedir(), dynamic: false, next: at + 1 + name.length };
    }
    return { text: `$${name}`, dynamic: true, next: at + 1 + name.length };
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
    return { text: `$${next}`, dynamic: true, next: at + 2 };
  }
  return { text: "$", dynamic: false, next: at + 1 };
}

/**
 * Past the bodies of the heredocs opened on the line that just ended,
 * each up to its delimiter line (leading tabs dropped for `<<-`). A body
 * with no delimiter runs to the end, as in the shell.
 */
function skipHeredocBodies(
  line: string,
  from: number,
  heredocs: readonly { delimiter: string; stripTabs: boolean }[],
): number {
  let i = from;
  for (const heredoc of heredocs) {
    while (i < line.length) {
      const newline = line.indexOf("\n", i);
      const end = newline === -1 ? line.length : newline;
      let text = line.slice(i, end).replace(/\r$/, "");
      if (heredoc.stripTabs) text = text.replace(/^\t+/, "");
      i = newline === -1 ? line.length : newline + 1;
      if (text === heredoc.delimiter) break;
    }
  }
  return i;
}
