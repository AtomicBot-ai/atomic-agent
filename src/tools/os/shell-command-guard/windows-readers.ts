/**
 * Readers and words for the Windows credential rule
 * (`rules-credentials-windows.ts`, ATO-2728): which words name a program
 * that reads a file, and the .NET / object forms that read with no reader
 * word at all (review round 3: `StreamReader`, `FileStream`, `.OpenText()`,
 * `.OpenRead()`, `New-Object`). Every pattern reads lowercased text.
 */

export const READERS: ReadonlySet<string> = new Set([
  // POSIX readers, as Git Bash and WSL run them.
  "cat", "bat", "tac", "nl", "less", "head", "tail", "strings", "od", "xxd", "hexdump",
  "base64", "base32", "grep", "egrep", "rg", "awk", "sed", "scp", "rsync", "tar", "zip",
  "7z", "gzip", "curl", "wget", "nc", "ncat", "ssh-keygen", "openssl",
  // cmd.exe
  "type", "more", "copy", "xcopy", "robocopy", "findstr", "certutil", "move",
  // PowerShell, with its aliases
  "get-content", "gc", "copy-item", "cpi", "cp", "compress-archive", "select-string", "sls",
  "move-item", "mi", "mv", "import-clixml", "invoke-webrequest", "iwr", "invoke-restmethod",
  "irm", "start-bitstransfer", "send-mailmessage", "format-hex", "fhx",
]);
/** What reads the output of the stage before it in a pipeline. */
export const PIPE_READERS: ReadonlySet<string> = new Set(["xargs", "foreach-object", "foreach", "%"]);
/** A code runner with inline code (`python -c`, `node -e`). */
const CODE_RUNNER = /^(?:python[0-9.]*|py|node|perl|ruby)$/;
const CODE_FLAG = /^(?:-[a-z]*[ce]|--eval|--print)$/;
/** A .NET or object read, with no reader word. */
const DOTNET_READ =
  /\[(?:system\.)?io\.file\]::(?:read|copy|open)|streamreader|filestream|binaryreader|\.open(?:text|read)?\s*\(|::readall|\.readtoend\s*\(|new-object\b/;
/** A string built from pieces: `'a'+'b'`, `'{0}' -f x`, `-replace`, `-join`, `[char]115`. */
export const STRING_BUILD = /['"]\s*\+|\+\s*['"]|['"]\s*-f\s|-replace\b|-join\b|\[char\]/;
/** A variable set to a value: `$p = ...`, `set K=...`, `set "K=..."`. */
export const ASSIGNMENT = /(?:^|[\s"'(;{])(?:\$[a-z_][a-z_0-9:]*\s*=(?!=)|set\s+"?[a-z_][a-z_0-9]*=)/;
/** A PowerShell provider variable is the file's content: `${C:\Users\x\.ssh\id_rsa}`. */
const PROVIDER_READ = /\$\{[^{}\s]*[/\\][^{}]*\}/;

/** Words of one command, quotes respected and removed; an inner quoted command adds its words too. */
export function wordsOf(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)) {
    const word = match[1] ?? match[2] ?? match[3] ?? "";
    words.push(word);
    if (/\s/.test(word)) words.push(...wordsOf(word));
  }
  return words;
}

/**
 * A word as a program name: no folder, no `.exe`, nothing up to a
 * PowerShell `(` or `{` (`&{gc`, `if(1){gc`), no closing `)` / `}`.
 */
export function program(word: string): string {
  const open = Math.max(word.lastIndexOf("("), word.lastIndexOf("{"));
  const base = word.slice(open + 1).replace(/^&+/, "").replace(/[)}]+$/, "");
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
  return name.replace(/\.exe$/, "");
}

/** Whether one command reads a file it names: a reader word, code, a .NET read. */
export function stageReads(command: string, words: readonly string[], programs: readonly string[]): boolean {
  const codeRunner = programs.some(
    (name, i) => CODE_RUNNER.test(name) && words.slice(i + 1).some((w) => CODE_FLAG.test(w)),
  );
  return (
    codeRunner ||
    DOTNET_READ.test(command) ||
    PROVIDER_READ.test(command) ||
    programs.some((name) => READERS.has(name))
  );
}
