import type { ShellWord } from "./shell-line-lexer.js";

/**
 * Where an archive command unpacks (review round 2 of ATO-2505): `tar x
 * -C dir`, `unzip -d dir`, `7z x -odir`, `cpio -i -D dir`, `pax -r`, or
 * the current directory when none is named (`cd ~ && tar xf p.tar`). An
 * archive can carry `.zshrc` or `.ssh/authorized_keys`, so the folder it
 * lands in is checked as a tree (`sensitiveTreeTargets`). Also the
 * archive file a `tar c` / `tar r` writes (`-f out`). Review round 3:
 * `C` bundled in a key (`tar xfC a.tar ~`, `-xzC ~`), `--cd` and long
 * option prefixes (`--dir=~`), and PowerShell's `Expand-Archive`.
 *
 * `undefined` for a command that is not one of these archivers; `[]`
 * for one that only lists, tests or prints.
 */
export interface ArchiveWrites {
  /** Folders the command unpacks into. */
  trees: ShellWord[];
  /** Files it writes as a whole (the archive of `tar c -f out`). */
  files: ShellWord[];
}

const TARS: ReadonlySet<string> = new Set(["tar", "bsdtar", "gtar", "gnutar"]);
const SEVEN_ZIP: ReadonlySet<string> = new Set(["7z", "7za", "7zz", "7zr"]);
const HERE: ShellWord = { text: ".", dynamic: false };

export function archiveWrites(name: string, args: readonly ShellWord[]): ArchiveWrites | undefined {
  if (TARS.has(name)) return tarWrites(args);
  if (name === "unzip") return unzipWrites(args);
  if (SEVEN_ZIP.has(name)) return sevenZipWrites(args);
  if (name === "cpio") return cpioWrites(args);
  if (name === "pax") return paxWrites(args);
  if (name === "expand-archive") return expandArchiveWrites(args);
  return undefined;
}

const withText = (word: ShellWord, text: string): ShellWord => ({ ...word, text });

/** tar key letters that always take the next free word, in order: `tar xfC a.tar ~`. */
const TAR_VALUE_LETTERS = "fCbTX";
/** Letters that take a word in one tar and not in another (GNU `-L`, `-K`, `-N`; bsdtar `-s`). */
const TAR_MAYBE_VALUE_LETTERS = "LVgKNFHs";

/** A long tar option, GNU style: any unambiguous prefix (`--dir=~`, `--extr`); `--cd` too. */
function tarLong(text: string): { name: string; value: string | undefined } | undefined {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(text);
  if (match === null) return undefined;
  const given = match[1]!;
  const of = (full: string, min: number): boolean => given.length >= min && full.startsWith(given);
  const name = given === "cd" || of("directory", 3)
    ? "directory"
    : of("extract", 3) || given === "get"
      ? "extract"
      : of("file", 3)
        ? "file"
        : ["create", "append", "update", "concatenate"].find((full) => of(full, 3)) ?? given;
  return { name, value: match[2] };
}

/**
 * Review round 3 (F2069-R3.1): a `C` inside a key cluster takes its word
 * in order with the other value letters (`tar xfC a.tar ~` gives `~` to
 * `C`, `tar xCf ~ a.tar` gives it first), and a dash cluster with text
 * after `C` (`-xC~`) gives that text too. Failing closed, each word a
 * letter of the cluster might take from `C`'s place on counts as a
 * folder. Only words before the next option are taken (`-` alone is one).
 */
function tarCluster(key: string, attached: boolean, rest: readonly ShellWord[], word: ShellWord): {
  dirs: ShellWord[];
  archive: ShellWord | undefined;
  used: number;
} {
  const dirs: ShellWord[] = [];
  const alpha = /^[A-Za-z]*/.exec(key)![0];
  const at = alpha.indexOf("C");
  if (attached && at !== -1 && at < key.length - 1) dirs.push(withText(word, key.slice(at + 1)));
  const option = rest.findIndex((next) => next.text.startsWith("-") && next.text !== "-");
  const operands = rest.slice(0, option === -1 ? rest.length : option);
  const letters = [...alpha].filter((letter) => TAR_VALUE_LETTERS.includes(letter));
  const maybe = [...alpha].filter((letter) => TAR_MAYBE_VALUE_LETTERS.includes(letter)).length;
  const c = letters.indexOf("C");
  if (c !== -1) dirs.push(...operands.slice(c, c + maybe + 1));
  const f = letters.indexOf("f");
  return { dirs, archive: f === -1 ? undefined : operands[f], used: Math.min(letters.length, operands.length) };
}

function tarWrites(args: readonly ShellWord[]): ArchiveWrites {
  let extract = false;
  let create = false;
  const dirs: ShellWord[] = [];
  const archives: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const text = word.text;
    const next = args[k + 1];
    if (/^-C./.test(text)) {
      dirs.push(withText(word, text.slice(2)));
      continue;
    }
    // Old-style keys first (`tar xzf a.tgz`, `tar czf out.tgz dir`), then `-xzf`.
    const key = k === 0 && /^[A-Za-z]+$/.test(text) ? text : /^-[A-Za-z][^-]*$/.test(text) ? text.slice(1) : null;
    if (key !== null) {
      const letters = /^[A-Za-z]*/.exec(key)![0];
      if (/x/.test(letters)) extract = true;
      if (/[cru]/.test(letters)) create = true;
      const cluster = tarCluster(key, k > 0 || text.startsWith("-"), args.slice(k + 1), word);
      dirs.push(...cluster.dirs);
      if (cluster.archive !== undefined) archives.push(cluster.archive);
      k += cluster.used;
      continue;
    }
    const long = tarLong(text);
    if (long === undefined) continue;
    const takesNext = long.value === undefined && (long.name === "directory" || long.name === "file");
    const value = long.value !== undefined ? withText(word, long.value) : takesNext ? next : undefined;
    if (takesNext && next !== undefined) k += 1;
    if (long.name === "extract") extract = true;
    else if (["create", "append", "update", "concatenate"].includes(long.name)) create = true;
    else if (long.name === "directory" && value !== undefined) dirs.push(value);
    else if (long.name === "file" && value !== undefined) archives.push(value);
  }
  if (extract) return { trees: dirs.length > 0 ? dirs : [HERE], files: [] };
  return { trees: [], files: create ? archives.filter((a) => a.text !== "-") : [] };
}

function unzipWrites(args: readonly ShellWord[]): ArchiveWrites {
  const dirs: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const text = args[k]!.text;
    if (!/^-[A-Za-z]/.test(text)) continue;
    // List, test, pipe to stdout, comment only: nothing lands on disk.
    if (/^-[A-Za-z]*[ltvpcZz]/.test(text) && !/^-d/.test(text)) return { trees: [], files: [] };
    const at = text.indexOf("d");
    if (at === -1) continue;
    if (at === text.length - 1) {
      const next = args[k + 1];
      if (next !== undefined) dirs.push(next);
      k += 1;
    } else {
      dirs.push(withText(args[k]!, text.slice(at + 1)));
    }
  }
  return { trees: dirs.length > 0 ? dirs : [HERE], files: [] };
}

function sevenZipWrites(args: readonly ShellWord[]): ArchiveWrites {
  const command = args.find((arg) => !arg.text.startsWith("-"))?.text.toLowerCase();
  if (command !== "x" && command !== "e") return { trees: [], files: [] };
  const dirs = args
    .filter((arg) => /^-o./.test(arg.text))
    .map((arg) => withText(arg, arg.text.slice(2)));
  return { trees: dirs.length > 0 ? dirs : [HERE], files: [] };
}

function cpioWrites(args: readonly ShellWord[]): ArchiveWrites {
  const dirs: ShellWord[] = [];
  let extract = false;
  let pass = false;
  const operands: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const text = args[k]!.text;
    if (text === "--extract") extract = true;
    else if (text === "--pass-through") pass = true;
    else if (text.startsWith("--directory=")) dirs.push(withText(args[k]!, text.slice("--directory=".length)));
    else if (text === "-D" || text === "--directory") {
      const next = args[k + 1];
      if (next !== undefined) dirs.push(next);
      k += 1;
    } else if (/^-[A-Za-z]+$/.test(text)) {
      if (text.includes("i")) extract = true;
      if (text.includes("p")) pass = true;
    } else if (!text.startsWith("-")) operands.push(args[k]!);
  }
  if (pass) return { trees: operands.slice(-1), files: [] };
  if (extract) return { trees: dirs.length > 0 ? dirs : [HERE], files: [] };
  return { trees: [], files: [] };
}

function paxWrites(args: readonly ShellWord[]): ArchiveWrites {
  const flags = args.filter((arg) => /^-[A-Za-z]+$/.test(arg.text)).map((arg) => arg.text).join("");
  if (!flags.includes("r")) return { trees: [], files: [] };
  if (flags.includes("w")) {
    const operands = args.filter((arg) => !arg.text.startsWith("-"));
    return { trees: operands.slice(-1), files: [] };
  }
  return { trees: [HERE], files: [] };
}

/** `Expand-Archive a.zip [-DestinationPath] d`; `-d`, `-Dest:d` too; the current folder by default. */
function expandArchiveWrites(args: readonly ShellWord[]): ArchiveWrites {
  const positional: ShellWord[] = [];
  const dirs: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const named = /^-([a-z]+)(?::(.*))?$/i.exec(word.text);
    if (named === null) {
      positional.push(word);
      continue;
    }
    const flag = named[1]!.toLowerCase();
    const takes = "destinationpath".startsWith(flag) || "path".startsWith(flag) || "literalpath".startsWith(flag);
    if (!takes) continue;
    const value = named[2] !== undefined && named[2].length > 0 ? withText(word, named[2]) : args[(k += 1)];
    if (value !== undefined && "destinationpath".startsWith(flag)) dirs.push(value);
  }
  if (dirs.length === 0 && positional[1] !== undefined) dirs.push(positional[1]);
  return { trees: dirs.length > 0 ? dirs : [HERE], files: [] };
}
