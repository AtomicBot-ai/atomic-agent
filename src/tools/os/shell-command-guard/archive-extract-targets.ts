import type { ShellWord } from "./shell-line-lexer.js";

/**
 * Where an archive command unpacks (review round 2 of ATO-2505): `tar x
 * -C dir`, `unzip -d dir`, `7z x -odir`, `cpio -i -D dir`, `pax -r`, or
 * the current directory when none is named (`cd ~ && tar xf p.tar`). An
 * archive can carry `.zshrc` or `.ssh/authorized_keys`, so the folder it
 * lands in is checked as a tree (`sensitiveTreeTargets`). Also the
 * archive file a `tar c` / `tar r` writes (`-f out`).
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
  return undefined;
}

const withText = (word: ShellWord, text: string): ShellWord => ({ ...word, text });

function tarWrites(args: readonly ShellWord[]): ArchiveWrites {
  let extract = false;
  let create = false;
  const dirs: ShellWord[] = [];
  const archives: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const text = word.text;
    const next = args[k + 1];
    // Old-style keys first (`tar xzf a.tgz`, `tar czf out.tgz dir`).
    const key = k === 0 && /^[A-Za-z]+$/.test(text) ? text : /^-[A-Za-z]+$/.test(text) ? text.slice(1) : null;
    if (/^-C./.test(text)) {
      dirs.push(withText(word, text.slice(2)));
      continue;
    }
    if (key !== null) {
      if (/x/.test(key)) extract = true;
      if (/[cru]/.test(key)) create = true;
      // A key that ends in `C` or `f` takes the next word.
      if (key.endsWith("C") && next !== undefined) {
        dirs.push(next);
        k += 1;
      } else if (key.endsWith("f") && next !== undefined) {
        archives.push(next);
        k += 1;
      }
      continue;
    }
    if (text === "--extract" || text === "--get") extract = true;
    else if (["--create", "--append", "--update", "--concatenate"].includes(text)) create = true;
    else if (text.startsWith("--directory=")) dirs.push(withText(word, text.slice("--directory=".length)));
    else if (text === "--directory" && next !== undefined) {
      dirs.push(next);
      k += 1;
    } else if (text.startsWith("--file=")) archives.push(withText(word, text.slice("--file=".length)));
    else if (text === "--file" && next !== undefined) {
      archives.push(next);
      k += 1;
    }
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
